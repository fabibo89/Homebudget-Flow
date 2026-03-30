from __future__ import annotations

from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import CurrentUser
from app.db.models import (
    AccountGroup,
    AccountGroupMember,
    BankAccount,
    Category,
    HouseholdMember,
    Transaction,
    TransferPair,
    User,
)
from app.db.session import get_session
from app.schemas.transaction import TransferKind, transaction_to_out
from app.schemas.transfer import TransferPairOut
from app.services.access import bank_account_visible_to_user
from app.services.transaction_enrichment import enrichment_list_meta_for_transactions

router = APIRouter(prefix="/transfers", tags=["transfers"])


def _pairs_base_query(user: User):
    if user.all_household_transactions:
        household_ids = select(HouseholdMember.household_id).where(HouseholdMember.user_id == user.id)
        return select(TransferPair).where(TransferPair.household_id.in_(household_ids))
    # sichtbar wenn User Mitglied in Sender- oder Empfänger-Kontogruppe ist
    return (
        select(TransferPair)
        .join(Transaction, Transaction.id == TransferPair.out_transaction_id)
        .join(BankAccount, BankAccount.id == Transaction.bank_account_id)
        .join(AccountGroupMember, AccountGroupMember.account_group_id == BankAccount.account_group_id)
        .where(AccountGroupMember.user_id == user.id)
    )


def _transfer_kind_for_memberships(
    *,
    current_user_id: int,
    source_members: set[int] | None,
    target_members: set[int] | None,
) -> TransferKind:
    if not source_members or not target_members:
        return TransferKind.none
    if source_members != {current_user_id}:
        return TransferKind.none
    if target_members == {current_user_id}:
        return TransferKind.own_internal
    if current_user_id in target_members and len(target_members) > 1:
        return TransferKind.own_to_shared
    if len(target_members) == 1 and current_user_id not in target_members:
        return TransferKind.own_to_other_user
    return TransferKind.none


async def _members_by_account_id(session: AsyncSession, account_ids: set[int]) -> dict[int, set[int]]:
    if not account_ids:
        return {}
    r_acc = await session.execute(select(BankAccount.id, BankAccount.account_group_id).where(BankAccount.id.in_(account_ids)))
    acc_to_group = {int(aid): int(gid) for aid, gid in r_acc.fetchall()}
    group_ids = set(acc_to_group.values())
    r_mem = await session.execute(
        select(AccountGroupMember.account_group_id, AccountGroupMember.user_id).where(
            AccountGroupMember.account_group_id.in_(group_ids)
        )
    )
    group_to_members: dict[int, set[int]] = {}
    for gid, uid in r_mem.fetchall():
        group_to_members.setdefault(int(gid), set()).add(int(uid))
    return {acc_id: group_to_members.get(group_id, set()) for acc_id, group_id in acc_to_group.items()}


@router.get("", response_model=list[TransferPairOut])
async def list_transfer_pairs(
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
    from_date: Optional[date] = Query(None, alias="from"),
    to_date: Optional[date] = Query(None, alias="to"),
    bank_account_id: Optional[int] = None,
    limit: int = Query(200, le=2000),
    offset: int = 0,
) -> list[TransferPairOut]:
    if bank_account_id is not None:
        if not await bank_account_visible_to_user(session, user, bank_account_id):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "No access to account")

    q = _pairs_base_query(user)

    # Filter: Datum bezieht sich auf Ausgangsbuchung
    if from_date is not None or to_date is not None or bank_account_id is not None:
        q = q.join(Transaction, Transaction.id == TransferPair.out_transaction_id)
        if from_date is not None:
            q = q.where(Transaction.booking_date >= from_date)
        if to_date is not None:
            q = q.where(Transaction.booking_date <= to_date)
        if bank_account_id is not None:
            q = q.where(
                or_(
                    Transaction.bank_account_id == bank_account_id,
                    TransferPair.in_transaction_id.in_(
                        select(Transaction.id).where(Transaction.bank_account_id == bank_account_id)
                    ),
                )
            )

    q = (
        q.options(
            # Wichtig: Category.parent / parent.children ist self-referential; selectinload ist hier stabil
            # und verhindert Async-Lazy-Loads (MissingGreenlet).
            selectinload(TransferPair.out_transaction)
            .selectinload(Transaction.category)
            .selectinload(Category.parent)
            .selectinload(Category.children),
            selectinload(TransferPair.in_transaction)
            .selectinload(Transaction.category)
            .selectinload(Category.parent)
            .selectinload(Category.children),
        )
        .order_by(TransferPair.id.desc())
        .limit(limit)
        .offset(offset)
    )
    r = await session.execute(q)
    pairs = r.unique().scalars().all()

    # Enrichment Preview Lines für beide Transaktionen
    tx_ids: list[int] = []
    for p in pairs:
        tx_ids.append(int(p.out_transaction_id))
        tx_ids.append(int(p.in_transaction_id))
    meta_map = await enrichment_list_meta_for_transactions(session, tx_ids)

    # Klassifikation pro Pair (aus Sicht user) anhand Sender/Empfänger-Kontogruppe
    account_ids: set[int] = set()
    for p in pairs:
        account_ids.add(int(p.out_transaction.bank_account_id))
        account_ids.add(int(p.in_transaction.bank_account_id))
    members_by_acc = await _members_by_account_id(session, account_ids)

    out: list[TransferPairOut] = []
    for p in pairs:
        out_acc_id = int(p.out_transaction.bank_account_id)
        in_acc_id = int(p.in_transaction.bank_account_id)
        kind = _transfer_kind_for_memberships(
            current_user_id=user.id,
            source_members=members_by_acc.get(out_acc_id),
            target_members=members_by_acc.get(in_acc_id),
        )
        out.append(
            TransferPairOut(
                id=p.id,
                household_id=p.household_id,
                created_at=p.created_at,
                out_transaction=transaction_to_out(
                    p.out_transaction,
                    enrichment_preview_lines=meta_map[p.out_transaction_id].preview_lines,
                    transfer_kind=kind,
                ),
                in_transaction=transaction_to_out(
                    p.in_transaction,
                    enrichment_preview_lines=meta_map[p.in_transaction_id].preview_lines,
                    transfer_kind=kind,
                ),
            )
        )
    return out

