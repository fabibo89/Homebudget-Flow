"""Persistente Verträge (pro Bankkonto): Erkennung, Status, Buchungs-Verknüpfung."""

from __future__ import annotations

from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import joinedload

from app.api.deps import CurrentUser
from app.db.models import BankAccount, HouseholdContract, Transaction
from app.db.models import ContractStatus
from app.db.session import get_session
from app.schemas.contracts import (
    ContractConfirmResult,
    ContractOut,
    ContractRecognizeResult,
    ContractIgnoreResult,
)
from app.schemas.transaction import TransactionOut, TransferKind, transaction_to_out
from app.services.access import bank_account_ids_visible_to_user, bank_account_visible_to_user
from app.services.contracts_service import (
    confirm_contract,
    contract_category_summary_for_list,
    count_transactions_for_contract,
    fetch_transactions_for_contract_detail,
    household_id_for_bank_account,
    ignore_contract,
    run_contract_recognition,
    sample_transaction_ids_for_contract,
)

router = APIRouter(prefix="/contracts", tags=["contracts"])


async def _contract_out(
    session: AsyncSession,
    hc: HouseholdContract,
    *,
    bank_name: Optional[str] = None,
) -> ContractOut:
    acc_name = bank_name
    if acc_name is None and hc.bank_account:
        acc_name = hc.bank_account.name
    elif acc_name is None:
        r = await session.get(BankAccount, hc.bank_account_id)
        acc_name = r.name if r else f"Konto {hc.bank_account_id}"

    amt = Decimal(str(hc.amount_abs)).quantize(Decimal("0.01"))
    sample_ids = await sample_transaction_ids_for_contract(session, hc, limit=5)
    if hc.status == ContractStatus.confirmed.value:
        tx_count = await count_transactions_for_contract(session, hc)
    else:
        tx_count = hc.occurrences

    cat_label, cat_hex = await contract_category_summary_for_list(session, hc)

    hid = await household_id_for_bank_account(session, hc.bank_account_id)
    if hid is None:
        hid = 0

    return ContractOut(
        id=hc.id,
        household_id=hid,
        bank_account_id=hc.bank_account_id,
        bank_account_name=acc_name or "",
        status=hc.status,
        label=hc.label,
        amount_typical=str(amt),
        currency=hc.currency,
        rhythm=hc.rhythm,
        rhythm_display=hc.rhythm_display or "",
        occurrences=hc.occurrences,
        first_booking=hc.first_booking,
        last_booking=hc.last_booking,
        confidence=float(hc.confidence),
        signature_hash=hc.signature_hash,
        sample_transaction_ids=sample_ids,
        transaction_count=tx_count,
        category_summary=cat_label,
        category_color_hex=cat_hex,
    )


async def _get_contract_for_user(
    session: AsyncSession,
    user,
    contract_id: int,
) -> HouseholdContract:
    r = await session.execute(
        select(HouseholdContract)
        .where(HouseholdContract.id == contract_id)
        .options(joinedload(HouseholdContract.bank_account).joinedload(BankAccount.account_group)),
    )
    hc = r.unique().scalar_one_or_none()
    if hc is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Vertrag nicht gefunden")
    if not await bank_account_visible_to_user(session, user, hc.bank_account_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Kein Zugriff")
    return hc


@router.get("", response_model=list[ContractOut])
async def list_contracts(
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
    bank_account_id: Optional[int] = Query(
        None,
        ge=1,
        description="Nur Verträge dieses Kontos; weglassen = alle sichtbaren Konten",
    ),
    status: Optional[str] = Query(
        None,
        description="suggested | confirmed | ignored — leer = alle",
    ),
) -> list[ContractOut]:
    if bank_account_id is not None:
        if not await bank_account_visible_to_user(session, user, bank_account_id):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Kein Zugriff auf dieses Konto")
        scope_ids = [bank_account_id]
    else:
        scope_ids = await bank_account_ids_visible_to_user(session, user)
        if not scope_ids:
            return []

    q = (
        select(HouseholdContract)
        .where(HouseholdContract.bank_account_id.in_(scope_ids))
        .options(joinedload(HouseholdContract.bank_account))
        .order_by(HouseholdContract.updated_at.desc())
    )
    if status is not None:
        st = status.strip().lower()
        if st not in {ContractStatus.suggested.value, ContractStatus.confirmed.value, ContractStatus.ignored.value}:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Ungültiger status")
        q = q.where(HouseholdContract.status == st)

    r = await session.execute(q)
    rows = r.unique().scalars().all()
    out: list[ContractOut] = []
    for hc in rows:
        out.append(await _contract_out(session, hc))
    return out


@router.post("/recognize", response_model=ContractRecognizeResult)
async def recognize_contracts(
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
    bank_account_id: int = Query(..., ge=1, description="Nur dieses Konto auswerten"),
    months_back: int = Query(60, ge=3, le=120),
) -> ContractRecognizeResult:
    if not await bank_account_visible_to_user(session, user, bank_account_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Kein Zugriff auf dieses Konto")

    r_acc = await session.execute(select(BankAccount).where(BankAccount.id == bank_account_id))
    acc = r_acc.scalar_one_or_none()
    if acc is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Konto nicht gefunden")

    accounts = {int(acc.id): acc}

    suggestions_updated, confirmed_touched = await run_contract_recognition(
        session,
        acc_ids=[bank_account_id],
        accounts_by_id=accounts,
        months_back=months_back,
    )
    await session.commit()
    return ContractRecognizeResult(
        suggestions_updated=suggestions_updated,
        confirmed_links_touched=confirmed_touched,
    )


@router.post("/{contract_id}/confirm", response_model=ContractConfirmResult)
async def confirm_contract_route(
    contract_id: int,
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
) -> ContractConfirmResult:
    hc = await _get_contract_for_user(session, user, contract_id)
    if hc.status == ContractStatus.ignored.value:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Ignorierte Verträge können nicht bestätigt werden")
    await confirm_contract(session, hc)
    n_after = await count_transactions_for_contract(session, hc)
    await session.commit()
    return ContractConfirmResult(ok=True, transactions_linked=n_after)


@router.post("/{contract_id}/ignore", response_model=ContractIgnoreResult)
async def ignore_contract_route(
    contract_id: int,
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
) -> ContractIgnoreResult:
    hc = await _get_contract_for_user(session, user, contract_id)
    await ignore_contract(session, hc)
    await session.commit()
    return ContractIgnoreResult(ok=True)


@router.get("/{contract_id}/transactions", response_model=list[TransactionOut])
async def list_contract_transactions(
    contract_id: int,
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
    limit: int = Query(500, ge=1, le=2000),
) -> list[TransactionOut]:
    from app.api.routes.transactions import _transfer_kind_map_for_transactions
    from app.db.models import Category
    from app.services.transaction_enrichment import enrichment_list_meta_for_transactions

    hc = await _get_contract_for_user(session, user, contract_id)

    raw_rows = await fetch_transactions_for_contract_detail(session, hc, limit=limit)
    if not raw_rows:
        return []

    ids = [int(t.id) for t in raw_rows]
    q = (
        select(Transaction)
        .where(Transaction.id.in_(ids))
        .options(
            joinedload(Transaction.category)
            .joinedload(Category.parent)
            .selectinload(Category.children),
            joinedload(Transaction.contract),
        )
    )
    r = await session.execute(q)
    by_id = {int(x.id): x for x in r.unique().scalars().all()}
    rows = [by_id[i] for i in ids if i in by_id]
    ids = [x.id for x in rows]
    meta_map = await enrichment_list_meta_for_transactions(session, ids)
    transfer_kind_map = await _transfer_kind_map_for_transactions(
        session,
        current_user_id=user.id,
        rows=rows,
    )
    return [
        transaction_to_out(
            x,
            enrichment_preview_lines=meta_map[x.id].preview_lines,
            transfer_kind=transfer_kind_map.get(x.id, TransferKind.none),
        )
        for x in rows
    ]
