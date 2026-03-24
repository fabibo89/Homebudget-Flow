"""Cache der letzten Gehalt-Buchung (Geldeingang → Gehalt) pro Bankkonto."""

from __future__ import annotations

from collections.abc import Iterable

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import joinedload

from app.db.models import AccountGroup, BankAccount, Transaction
from app.services.default_income_categories import get_gehalt_category_id


async def refresh_salary_cache_for_bank_account(session: AsyncSession, bank_account_id: int) -> None:
    """Setzt ``last_salary_*`` am Konto aus der DB (neueste Buchung nach Buchungsdatum, dann ID)."""
    r = await session.execute(
        select(BankAccount)
        .where(BankAccount.id == bank_account_id)
        .options(joinedload(BankAccount.account_group)),
    )
    acc = r.unique().scalar_one_or_none()
    if acc is None or acc.account_group is None:
        return
    household_id = acc.account_group.household_id
    gehalt_id = await get_gehalt_category_id(session, household_id)
    if gehalt_id is None:
        acc.last_salary_booking_date = None
        acc.last_salary_amount = None
        return
    row = (
        await session.execute(
            select(Transaction.booking_date, Transaction.amount)
            .where(
                Transaction.bank_account_id == bank_account_id,
                Transaction.category_id == gehalt_id,
            )
            .order_by(Transaction.booking_date.desc(), Transaction.id.desc())
            .limit(1),
        )
    ).first()
    if row is None:
        acc.last_salary_booking_date = None
        acc.last_salary_amount = None
    else:
        acc.last_salary_booking_date = row[0]
        acc.last_salary_amount = row[1]


async def refresh_salary_cache_for_bank_accounts(session: AsyncSession, bank_account_ids: Iterable[int]) -> None:
    for bid in set(bank_account_ids):
        await refresh_salary_cache_for_bank_account(session, bid)


async def refresh_salary_cache_for_household(session: AsyncSession, household_id: int) -> None:
    r = await session.execute(
        select(BankAccount.id).join(AccountGroup).where(AccountGroup.household_id == household_id),
    )
    for (bid,) in r.all():
        await refresh_salary_cache_for_bank_account(session, bid)
