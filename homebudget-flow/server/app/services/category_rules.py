from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import joinedload

from app.db.models import AccountGroup, BankAccount, Category, CategoryRule, Transaction, User
from app.schemas.category_rule_conditions import rule_effective_conditions, transaction_matches_conditions
from app.services.access import bank_account_ids_visible_for_user_in_household
from app.services.salary_cache import refresh_salary_cache_for_household

_OVERWRITE_CANDIDATE_LIMIT = 500


def transaction_matches_rule(tx: Transaction, rule: CategoryRule) -> bool:
    conds = rule_effective_conditions(rule)
    return transaction_matches_conditions(tx, conds)


async def build_rule_allowed_bank_account_ids(
    session: AsyncSession,
    household_id: int,
    rules: list[CategoryRule],
) -> dict[int, frozenset[int]]:
    """Pro Regel: Konten-IDs, auf die sie bei der Zuordnung angewendet werden darf."""
    acc_r = await session.execute(
        select(BankAccount.id).join(AccountGroup).where(AccountGroup.household_id == household_id),
    )
    household_ids = frozenset(row[0] for row in acc_r.all())
    if not household_ids or not rules:
        return {}

    creator_ids = {
        r.created_by_user_id
        for r in rules
        if not r.applies_to_household and r.created_by_user_id is not None
    }
    creators: dict[int, User] = {}
    if creator_ids:
        u_r = await session.execute(select(User).where(User.id.in_(creator_ids)))
        creators = {u.id: u for u in u_r.scalars().all()}

    visible_by_user: dict[int, frozenset[int]] = {}

    async def visible_for_creator(uid: int) -> frozenset[int]:
        if uid in visible_by_user:
            return visible_by_user[uid]
        u = creators.get(uid)
        if u is None:
            visible_by_user[uid] = household_ids
            return household_ids
        raw = await bank_account_ids_visible_for_user_in_household(session, u, household_id)
        vis = frozenset(raw) & household_ids
        visible_by_user[uid] = vis
        return visible_by_user[uid]

    out: dict[int, frozenset[int]] = {}
    for rule in rules:
        if rule.applies_to_household:
            out[rule.id] = household_ids
            continue
        uid = rule.created_by_user_id
        if uid is None:
            out[rule.id] = household_ids
            continue
        out[rule.id] = await visible_for_creator(uid)
    return out


def first_matching_rule_category_id(
    tx: Transaction,
    rules: list[CategoryRule],
    rule_allowed_accounts: dict[int, frozenset[int]],
) -> int | None:
    """Erste passende Regel (nach ID absteigend = neueste zuerst); sonst None."""
    for rule in rules:
        allowed = rule_allowed_accounts.get(rule.id)
        if allowed is not None and tx.bank_account_id not in allowed:
            continue
        if transaction_matches_rule(tx, rule):
            return rule.category_id
    return None


@dataclass(frozen=True)
class CategoryRuleOverwriteRow:
    transaction_id: int
    bank_account_id: int
    booking_date: date
    amount: Decimal
    currency: str
    description: str
    counterparty: str | None
    current_category_id: int
    current_category_name: str
    suggested_category_id: int
    suggested_category_name: str


async def list_category_rule_overwrite_candidates(
    session: AsyncSession,
    user: User,
    household_id: int,
) -> tuple[list[CategoryRuleOverwriteRow], bool]:
    """Buchungen mit gesetzter Kategorie, für die die aktuelle Regelliste eine andere Kategorie liefert."""
    account_ids = await bank_account_ids_visible_for_user_in_household(session, user, household_id)
    if not account_ids:
        return [], False

    rules_r = await session.execute(
        select(CategoryRule)
        .where(CategoryRule.household_id == household_id)
        .order_by(CategoryRule.id.desc()),
    )
    rules = list(rules_r.scalars().all())
    if not rules:
        return [], False

    rule_allowed = await build_rule_allowed_bank_account_ids(session, household_id, rules)

    cat_r = await session.execute(select(Category).where(Category.household_id == household_id))
    cats: dict[int, Category] = {c.id: c for c in cat_r.scalars().all()}

    tx_r = await session.execute(
        select(Transaction)
        .where(
            Transaction.bank_account_id.in_(account_ids),
            Transaction.category_id.isnot(None),
        )
        .options(joinedload(Transaction.category))
        .order_by(Transaction.booking_date.desc(), Transaction.id.desc()),
    )
    txs = list(tx_r.unique().scalars().all())

    raw: list[CategoryRuleOverwriteRow] = []
    for tx in txs:
        sug_id = first_matching_rule_category_id(tx, rules, rule_allowed)
        if sug_id is None or sug_id == tx.category_id:
            continue
        sug_cat = cats.get(sug_id)
        cur_cat = tx.category
        if sug_cat is None or cur_cat is None:
            continue
        raw.append(
            CategoryRuleOverwriteRow(
                transaction_id=tx.id,
                bank_account_id=tx.bank_account_id,
                booking_date=tx.booking_date,
                amount=tx.amount,
                currency=tx.currency,
                description=tx.description or "",
                counterparty=tx.counterparty,
                current_category_id=cur_cat.id,
                current_category_name=cur_cat.name,
                suggested_category_id=sug_cat.id,
                suggested_category_name=sug_cat.name,
            ),
        )

    truncated = len(raw) > _OVERWRITE_CANDIDATE_LIMIT
    return raw[:_OVERWRITE_CANDIDATE_LIMIT], truncated


async def apply_category_rules_to_uncategorized(
    session: AsyncSession,
    household_id: int,
) -> int:
    """Weist unkategorisierten Buchungen des Haushalts per Regeln eine Kategorie zu (höhere Regel-ID zuerst)."""
    rules_r = await session.execute(
        select(CategoryRule)
        .where(CategoryRule.household_id == household_id)
        .order_by(CategoryRule.id.desc()),
    )
    rules = list(rules_r.scalars().all())
    if not rules:
        return 0

    acc_r = await session.execute(
        select(BankAccount.id).join(AccountGroup).where(AccountGroup.household_id == household_id),
    )
    account_ids = [row[0] for row in acc_r.all()]
    if not account_ids:
        return 0

    rule_allowed = await build_rule_allowed_bank_account_ids(session, household_id, rules)

    tx_r = await session.execute(
        select(Transaction).where(
            Transaction.bank_account_id.in_(account_ids),
            Transaction.category_id.is_(None),
        ),
    )
    txs = list(tx_r.scalars().all())

    updated = 0
    for tx in txs:
        for rule in rules:
            allowed = rule_allowed.get(rule.id)
            if allowed is not None and tx.bank_account_id not in allowed:
                continue
            if transaction_matches_rule(tx, rule):
                tx.category_id = rule.category_id
                updated += 1
                break
    await refresh_salary_cache_for_household(session, household_id)
    return updated
