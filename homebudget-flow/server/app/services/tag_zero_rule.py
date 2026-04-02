from __future__ import annotations

from typing import Any, Optional

from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import BankAccount, CategoryRule, Transaction
from app.schemas.category_rule_conditions import (
    parse_conditions_json,
    rule_effective_conditions,
    transaction_matches_conditions,
)


def bank_account_has_tag_zero_rule(account: BankAccount) -> bool:
    if getattr(account, "tag_zero_rule_category_rule_id", None) is not None:
        return True
    raw = getattr(account, "tag_zero_rule_conditions_json", None)
    return bool(raw and str(raw).strip())


async def tag_zero_rule_conditions_for_account(
    session: AsyncSession,
    account: BankAccount,
    household_id: int,
) -> tuple[Optional[list[Any]], bool]:
    """Liefert (Bedingungen, normalize_dot_space) oder (None, False) wenn keine Regel konfiguriert."""
    conds: Optional[list[Any]] = None
    norm = False

    rid = getattr(account, "tag_zero_rule_category_rule_id", None)
    if rid is not None:
        rule = await session.get(CategoryRule, int(rid))
        if rule is not None and int(rule.household_id) == int(household_id):
            conds = rule_effective_conditions(rule)
            norm = bool(getattr(rule, "normalize_dot_space", False))

    if conds is None:
        raw = getattr(account, "tag_zero_rule_conditions_json", None)
        if raw and str(raw).strip():
            conds = parse_conditions_json(str(raw))
            norm = bool(getattr(account, "tag_zero_rule_normalize_dot_space", False))

    return conds, norm


async def find_tag_zero_matching_transaction(
    session: AsyncSession,
    *,
    account: BankAccount,
    household_id: int,
) -> Optional[Transaction]:
    """Neueste Buchung, die der Tag-Null-Regel entspricht (gleiche Reihenfolge wie bei ``apply``)."""
    conds, norm = await tag_zero_rule_conditions_for_account(session, account, household_id)
    if not conds:
        return None
    r = await session.execute(
        select(Transaction)
        .where(Transaction.bank_account_id == account.id)
        .order_by(desc(Transaction.booking_date), desc(Transaction.id))
        .limit(5000),
    )
    for tx in r.scalars().all():
        if transaction_matches_conditions(tx, conds, normalize_dot_space=norm):
            return tx
    return None


async def apply_tag_zero_rule_for_account(
    session: AsyncSession,
    *,
    account: BankAccount,
    household_id: int,
) -> None:
    """Wendet die konfigurierte Tag-Null-Regel auf bestehende Buchungen an.

    Ergebnis: ``account.day_zero_date`` = Buchungsdatum der neuesten passenden Buchung,
    oder NULL wenn keine passt.
    """
    tx = await find_tag_zero_matching_transaction(session, account=account, household_id=household_id)
    if tx is None:
        account.day_zero_date = None
        return
    account.day_zero_date = tx.booking_date
