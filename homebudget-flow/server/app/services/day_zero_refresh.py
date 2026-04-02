"""Tag-Null-Datum (`day_zero_date`) neu aus der konfigurierten Regel ableiten (ohne Gehalt-Cache)."""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import joinedload

from app.db.models import AccountGroup, BankAccount
from app.services.tag_zero_rule import apply_tag_zero_rule_for_account, bank_account_has_tag_zero_rule


async def refresh_day_zero_for_bank_account(session: AsyncSession, bank_account_id: int) -> None:
    """Wenn eine Tag-Null-Regel konfiguriert ist: Regel auf Buchungen anwenden."""
    r = await session.execute(
        select(BankAccount)
        .where(BankAccount.id == bank_account_id)
        .options(joinedload(BankAccount.account_group)),
    )
    acc = r.unique().scalar_one_or_none()
    if acc is None or acc.account_group is None:
        return
    if not bank_account_has_tag_zero_rule(acc):
        return
    await apply_tag_zero_rule_for_account(
        session,
        account=acc,
        household_id=int(acc.account_group.household_id),
    )


async def refresh_day_zero_for_household(session: AsyncSession, household_id: int) -> None:
    r = await session.execute(
        select(BankAccount.id)
        .join(AccountGroup, AccountGroup.id == BankAccount.account_group_id)
        .where(AccountGroup.household_id == household_id),
    )
    for (bid,) in r.all():
        await refresh_day_zero_for_bank_account(session, int(bid))


async def refresh_day_zero_for_bank_accounts(session: AsyncSession, bank_account_ids: list[int]) -> None:
    for bid in set(bank_account_ids):
        await refresh_day_zero_for_bank_account(session, int(bid))
