from __future__ import annotations

from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import joinedload, selectinload

from app.api.deps import CurrentUser
from app.db.models import AccountGroup, AccountGroupMember, BankAccount, Category, HouseholdMember, Transaction, User
from app.db.session import get_session
from app.services.category_assignment import ensure_category_is_subcategory_for_assignment
from app.services.salary_cache import refresh_salary_cache_for_bank_account, refresh_salary_cache_for_bank_accounts
from app.schemas.transaction import (
    BulkTransactionCategoryBody,
    BulkTransactionCategoryResult,
    TransactionCategoryUpdate,
    TransactionOut,
    transaction_to_out,
)
from app.services.access import bank_account_visible_to_user

router = APIRouter(prefix="/transactions", tags=["transactions"])

_LIKE_MAX = 500


def _ilike_pattern_fragment(raw: str) -> str:
    """Sicheres Teil-Muster für ILIKE: % und _ wörtlich, Backslashes escaped."""
    return (
        raw.replace("\\", "\\\\")
        .replace("%", "\\%")
        .replace("_", "\\_")
    )


def _transactions_base_query(user: User):
    if user.all_household_transactions:
        household_ids = select(HouseholdMember.household_id).where(HouseholdMember.user_id == user.id)
        return (
            select(Transaction)
            .join(BankAccount)
            .join(AccountGroup, AccountGroup.id == BankAccount.account_group_id)
            .where(AccountGroup.household_id.in_(household_ids))
        )
    return (
        select(Transaction)
        .join(BankAccount)
        .join(AccountGroupMember, AccountGroupMember.account_group_id == BankAccount.account_group_id)
        .where(AccountGroupMember.user_id == user.id)
    )


@router.get("", response_model=list[TransactionOut])
async def list_transactions(
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
    from_date: Optional[date] = Query(None, alias="from"),
    to_date: Optional[date] = Query(None, alias="to"),
    bank_account_id: Optional[int] = None,
    description_contains: Optional[str] = Query(None, max_length=_LIKE_MAX),
    counterparty_contains: Optional[str] = Query(None, max_length=_LIKE_MAX),
    limit: int = Query(200, le=2000),
    offset: int = 0,
) -> list[TransactionOut]:
    q = _transactions_base_query(user)
    if bank_account_id is not None:
        if not await bank_account_visible_to_user(session, user, bank_account_id):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "No access to account")
        q = q.where(Transaction.bank_account_id == bank_account_id)
    if from_date is not None:
        q = q.where(Transaction.booking_date >= from_date)
    if to_date is not None:
        q = q.where(Transaction.booking_date <= to_date)
    desc_q = (description_contains or "").strip()
    if desc_q:
        pat = f"%{_ilike_pattern_fragment(desc_q)}%"
        q = q.where(Transaction.description.ilike(pat, escape="\\"))
    cp_q = (counterparty_contains or "").strip()
    if cp_q:
        pat_cp = f"%{_ilike_pattern_fragment(cp_q)}%"
        q = q.where(Transaction.counterparty.ilike(pat_cp, escape="\\"))
    q = (
        q.options(
            joinedload(Transaction.category)
            .joinedload(Category.parent)
            .selectinload(Category.children),
        )
        .order_by(Transaction.booking_date.desc(), Transaction.id.desc())
        .limit(limit)
        .offset(offset)
    )
    r = await session.execute(q)
    rows = r.unique().scalars().all()
    return [transaction_to_out(x) for x in rows]


@router.patch("/{transaction_id}", response_model=TransactionOut)
async def patch_transaction_category(
    transaction_id: int,
    body: TransactionCategoryUpdate,
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
) -> TransactionOut:
    r = await session.execute(
        select(Transaction)
        .where(Transaction.id == transaction_id)
        .options(
            joinedload(Transaction.bank_account).joinedload(BankAccount.account_group),
        )
    )
    tx = r.unique().scalar_one_or_none()
    if tx is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Buchung nicht gefunden")
    if not await bank_account_visible_to_user(session, user, tx.bank_account_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Kein Zugriff auf diese Buchung")
    household_id = tx.bank_account.account_group.household_id
    if body.category_id is None:
        tx.category_id = None
    else:
        cat = await session.get(Category, body.category_id)
        if cat is None or cat.household_id != household_id:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Kategorie unbekannt oder gehört nicht zum Haushalt dieses Kontos.",
            )
        ensure_category_is_subcategory_for_assignment(cat)
        tx.category_id = body.category_id
    await refresh_salary_cache_for_bank_account(session, tx.bank_account_id)
    await session.commit()
    r2 = await session.execute(
        select(Transaction)
        .where(Transaction.id == tx.id)
        .options(
            joinedload(Transaction.category)
            .joinedload(Category.parent)
            .selectinload(Category.children),
        )
    )
    tx2 = r2.unique().scalar_one()
    return transaction_to_out(tx2)


@router.post("/bulk-category", response_model=BulkTransactionCategoryResult)
async def bulk_patch_transaction_categories(
    body: BulkTransactionCategoryBody,
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
) -> BulkTransactionCategoryResult:
    """Mehrere Buchungen auf eine Kategorie setzen (z. B. nach Rückfrage bei Regel-Konflikten)."""
    if not body.items:
        return BulkTransactionCategoryResult(updated=0)

    seen: set[int] = set()
    updated = 0
    affected_bank_account_ids: set[int] = set()
    for item in body.items:
        if item.transaction_id in seen:
            continue
        seen.add(item.transaction_id)
        r = await session.execute(
            select(Transaction)
            .where(Transaction.id == item.transaction_id)
            .options(
                joinedload(Transaction.bank_account).joinedload(BankAccount.account_group),
            ),
        )
        tx = r.unique().scalar_one_or_none()
        if tx is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, f"Buchung {item.transaction_id} nicht gefunden")
        if not await bank_account_visible_to_user(session, user, tx.bank_account_id):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Kein Zugriff auf diese Buchung")
        household_id = tx.bank_account.account_group.household_id
        cat = await session.get(Category, item.category_id)
        if cat is None or cat.household_id != household_id:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Kategorie unbekannt oder gehört nicht zum Haushalt dieses Kontos.",
            )
        ensure_category_is_subcategory_for_assignment(cat)
        tx.category_id = item.category_id
        affected_bank_account_ids.add(tx.bank_account_id)
        updated += 1

    if affected_bank_account_ids:
        await refresh_salary_cache_for_bank_accounts(session, affected_bank_account_ids)

    await session.commit()
    return BulkTransactionCategoryResult(updated=updated)
