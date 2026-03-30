from __future__ import annotations

from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import BankAccount, CategoryRule, Transaction
from app.schemas.category_rule_conditions import (
    parse_conditions_json,
    rule_effective_conditions,
    transaction_matches_conditions,
)


async def apply_tag_zero_rule_for_account(
    session: AsyncSession,
    *,
    account: BankAccount,
    household_id: int,
) -> None:
    """Wendet die konfigurierte Tag-Null-Regel auf bestehende Buchungen an.

    Ergebnis wird in ``account.last_salary_*`` gespeichert:
    - neueste matchende Buchung (booking_date desc, id desc) -> Datum/Betrag
    - keine matchende Buchung -> NULL/NULL
    """
    conds = None
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

    if not conds:
        account.last_salary_booking_date = None
        account.last_salary_amount = None
        return

    r = await session.execute(
        select(Transaction)
        .where(Transaction.bank_account_id == account.id)
        .order_by(desc(Transaction.booking_date), desc(Transaction.id))
        .limit(5000),
    )
    for tx in r.scalars().all():
        if transaction_matches_conditions(tx, conds, normalize_dot_space=norm):
            account.last_salary_booking_date = tx.booking_date
            account.last_salary_amount = tx.amount
            return

    account.last_salary_booking_date = None
    account.last_salary_amount = None

