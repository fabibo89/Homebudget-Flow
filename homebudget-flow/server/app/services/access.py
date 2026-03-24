"""Zugriffsprüfung: Nutzer nur auf Konten in Gruppen, in denen sie Mitglied sind."""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import AccountGroup, AccountGroupMember, BankAccount, HouseholdMember, User


async def user_has_household(session: AsyncSession, user_id: int, household_id: int) -> bool:
    r = await session.execute(
        select(HouseholdMember.id).where(
            HouseholdMember.user_id == user_id,
            HouseholdMember.household_id == household_id,
        )
    )
    return r.scalar_one_or_none() is not None


async def user_can_access_account_group(session: AsyncSession, user_id: int, group_id: int) -> bool:
    r = await session.execute(
        select(AccountGroupMember.id).where(
            AccountGroupMember.user_id == user_id,
            AccountGroupMember.account_group_id == group_id,
        )
    )
    return r.scalar_one_or_none() is not None


async def user_can_access_bank_account(session: AsyncSession, user_id: int, bank_account_id: int) -> bool:
    r = await session.execute(select(BankAccount).where(BankAccount.id == bank_account_id))
    acc = r.scalar_one_or_none()
    if acc is None:
        return False
    return await user_can_access_account_group(session, user_id, acc.account_group_id)


async def bank_account_ids_visible_for_user_in_household(
    session: AsyncSession,
    user: User,
    household_id: int,
) -> list[int]:
    """Bankkonten-IDs im Haushalt, auf die der Nutzer Buchungen sehen/bearbeiten darf."""
    base = (
        select(BankAccount.id)
        .join(AccountGroup, AccountGroup.id == BankAccount.account_group_id)
        .where(AccountGroup.household_id == household_id)
    )
    if user.all_household_transactions:
        r = await session.execute(base)
        return [row[0] for row in r.all()]
    r = await session.execute(
        base.join(
            AccountGroupMember,
            AccountGroupMember.account_group_id == BankAccount.account_group_id,
        ).where(AccountGroupMember.user_id == user.id),
    )
    return [row[0] for row in r.all()]


async def bank_account_visible_to_user(session: AsyncSession, user: User, bank_account_id: int) -> bool:
    """Buchungen eines Kontos listen/bearbeiten: nach Nutzereinstellung Haushalt weit oder nur eigene Kontogruppe."""
    r = await session.execute(
        select(AccountGroup.household_id)
        .select_from(BankAccount)
        .join(AccountGroup, AccountGroup.id == BankAccount.account_group_id)
        .where(BankAccount.id == bank_account_id),
    )
    hid = r.scalar_one_or_none()
    if hid is None:
        return False
    if user.all_household_transactions:
        r2 = await session.execute(
            select(HouseholdMember.id).where(
                HouseholdMember.user_id == user.id,
                HouseholdMember.household_id == hid,
            ),
        )
        return r2.scalar_one_or_none() is not None
    return await user_can_access_bank_account(session, user.id, bank_account_id)
