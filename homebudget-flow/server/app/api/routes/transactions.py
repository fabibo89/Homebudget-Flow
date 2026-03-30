from __future__ import annotations

import json
import re
from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import joinedload, selectinload

from app.api.deps import CurrentUser
from app.db.models import (
    AccountGroup,
    AccountGroupMember,
    BankAccount,
    Category,
    ExternalTransactionRecord,
    ExternalRecordSource,
    HouseholdMember,
    Transaction,
    TransactionEnrichment,
    User,
)
from app.db.session import get_session
from app.services.category_assignment import ensure_category_is_subcategory_for_assignment
from app.services.salary_cache import refresh_salary_cache_for_bank_account, refresh_salary_cache_for_bank_accounts
from app.schemas.transaction import (
    BulkTransactionCategoryBody,
    BulkTransactionCategoryResult,
    TransactionCategoryUpdate,
    TransactionOut,
  TransferKind,
    transaction_to_out,
)
from app.schemas.transaction_enrichment import (
    ExternalRecordMappingOut,
    ExternalRecordsImportBody,
    ExternalRecordsImportResult,
    TransactionEnrichmentOut,
)
from app.services.access import bank_account_visible_to_user
from app.services.access import user_has_household
from app.services.transaction_enrichment import (
    enrichment_list_meta_for_transactions,
    rematch_external_records,
    upsert_external_record,
)

router = APIRouter(prefix="/transactions", tags=["transactions"])

_LIKE_MAX = 500


def _ilike_pattern_fragment(raw: str) -> str:
    """Sicheres Teil-Muster für ILIKE: % und _ wörtlich, Backslashes escaped."""
    return (
        raw.replace("\\", "\\\\")
        .replace("%", "\\%")
        .replace("_", "\\_")
    )


def _pg_word_regex(term: str) -> str:
    """Ein Suchbegriff als PostgreSQL-Regex mit Wortgrenzen (~*), Eingabe per re.escape geschützt."""
    esc = re.escape(term.strip())
    return rf"\y{esc}\y"


def _search_terms(raw: str) -> list[str]:
    return [t for t in raw.split() if t.strip()]


def _transactions_base_query(user: User):
    if user.all_household_transactions:
        household_ids = select(HouseholdMember.household_id).where(HouseholdMember.user_id == user.id)
        return (
            select(Transaction)
            .join(BankAccount, BankAccount.id == Transaction.bank_account_id)
            .join(AccountGroup, AccountGroup.id == BankAccount.account_group_id)
            .where(AccountGroup.household_id.in_(household_ids))
        )
    return (
        select(Transaction)
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
    # "eigene Umbuchungen" beziehen sich auf private Kontengruppe (nur der User).
    if source_members != {current_user_id}:
        return TransferKind.none
    if target_members == {current_user_id}:
        return TransferKind.own_internal
    if current_user_id in target_members and len(target_members) > 1:
        return TransferKind.own_to_shared
    if len(target_members) == 1 and current_user_id not in target_members:
        return TransferKind.own_to_other_user
    return TransferKind.none


async def _transfer_kind_map_for_transactions(
    session: AsyncSession,
    *,
    current_user_id: int,
    rows: list[Transaction],
) -> dict[int, TransferKind]:
    bank_account_ids: set[int] = set()
    for tx in rows:
        bank_account_ids.add(int(tx.bank_account_id))
        if tx.transfer_target_bank_account_id is not None:
            bank_account_ids.add(int(tx.transfer_target_bank_account_id))
    if not bank_account_ids:
        return {}

    r_acc = await session.execute(
        select(BankAccount.id, BankAccount.account_group_id).where(BankAccount.id.in_(bank_account_ids))
    )
    acc_to_group: dict[int, int] = {int(aid): int(gid) for aid, gid in r_acc.fetchall()}
    group_ids = set(acc_to_group.values())
    if not group_ids:
        return {int(tx.id): TransferKind.none for tx in rows}

    r_mem = await session.execute(
        select(AccountGroupMember.account_group_id, AccountGroupMember.user_id).where(
            AccountGroupMember.account_group_id.in_(group_ids)
        )
    )
    group_to_members: dict[int, set[int]] = {}
    for gid, uid in r_mem.fetchall():
        group_to_members.setdefault(int(gid), set()).add(int(uid))

    out: dict[int, TransferKind] = {}
    for tx in rows:
        tgt = tx.transfer_target_bank_account_id
        if tgt is None:
            out[int(tx.id)] = TransferKind.none
            continue
        src_gid = acc_to_group.get(int(tx.bank_account_id))
        tgt_gid = acc_to_group.get(int(tgt))
        out[int(tx.id)] = _transfer_kind_for_memberships(
            current_user_id=current_user_id,
            source_members=group_to_members.get(int(src_gid)) if src_gid is not None else None,
            target_members=group_to_members.get(int(tgt_gid)) if tgt_gid is not None else None,
        )
    return out


@router.get("", response_model=list[TransactionOut])
async def list_transactions(
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
    from_date: Optional[date] = Query(None, alias="from"),
    to_date: Optional[date] = Query(None, alias="to"),
    bank_account_id: Optional[int] = None,
    description_contains: Optional[str] = Query(None, max_length=_LIKE_MAX),
    counterparty_contains: Optional[str] = Query(None, max_length=_LIKE_MAX),
    whole_words: bool = Query(False, description="Nur ganze Wörter (Wortgrenzen), statt Teilstring."),
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
        if whole_words:
            for term in _search_terms(desc_q):
                q = q.where(Transaction.description.op("~*")(_pg_word_regex(term)))
        else:
            pat = f"%{_ilike_pattern_fragment(desc_q)}%"
            q = q.where(Transaction.description.ilike(pat, escape="\\"))
    cp_q = (counterparty_contains or "").strip()
    if cp_q:
        if whole_words:
            for term in _search_terms(cp_q):
                q = q.where(Transaction.counterparty.op("~*")(_pg_word_regex(term)))
        else:
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


@router.get("/enrichments/external-records", response_model=list[ExternalRecordMappingOut])
async def list_external_record_mappings(
    household_id: int,
    source: str,
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
    limit: int = Query(500, ge=1, le=5000),
) -> list[ExternalRecordMappingOut]:
    src = (source or "").strip().lower()
    if src not in {ExternalRecordSource.paypal.value, ExternalRecordSource.amazon.value}:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Quelle muss 'paypal' oder 'amazon' sein.")
    if not await user_has_household(session, user.id, household_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Kein Zugriff auf diesen Haushalt.")

    r = await session.execute(
        select(ExternalTransactionRecord)
        .where(
            ExternalTransactionRecord.household_id == household_id,
            ExternalTransactionRecord.source == src,
        )
        .options(
            joinedload(ExternalTransactionRecord.tx_links)
            .joinedload(TransactionEnrichment.transaction)
            .joinedload(Transaction.bank_account),
        )
        .order_by(ExternalTransactionRecord.booking_date.desc(), ExternalTransactionRecord.id.desc())
        .limit(limit)
    )
    records = r.unique().scalars().all()

    out: list[ExternalRecordMappingOut] = []
    for rec in records:
        order_id: str | None = None
        try:
            details = json.loads(rec.details_json or "{}")
            if isinstance(details, dict):
                if src == ExternalRecordSource.paypal.value:
                    rel = str(details.get("paypal_related_code") or "").strip()
                    tid = str(details.get("paypal_transaction_code") or "").strip()
                    order_id = rel or tid or None
                else:
                    v = str(details.get("order_id") or "").strip()
                    order_id = v or None
        except Exception:
            order_id = None

        link = next((x for x in (rec.tx_links or []) if x.source == src), None)
        tx = link.transaction if link is not None else None
        acc = tx.bank_account if tx is not None else None
        out.append(
            ExternalRecordMappingOut(
                record_id=rec.id,
                source=rec.source,
                external_ref=rec.external_ref,
                order_id=order_id,
                booking_date=rec.booking_date,
                amount=rec.amount,
                currency=rec.currency,
                description=rec.description,
                counterparty=rec.counterparty,
                vendor=rec.vendor,
                matched=link is not None and tx is not None,
                matched_transaction_id=tx.id if tx is not None else None,
                matched_bank_account_id=acc.id if acc is not None else None,
                matched_bank_account_name=acc.name if acc is not None else None,
                matched_booking_date=tx.booking_date if tx is not None else None,
                matched_amount=tx.amount if tx is not None else None,
                matched_currency=tx.currency if tx is not None else None,
                matched_description=tx.description if tx is not None else None,
                matched_counterparty=tx.counterparty if tx is not None else None,
                matched_at=link.matched_at if link is not None else None,
            )
        )
    return out


@router.get("/{transaction_id}/enrichments", response_model=list[TransactionEnrichmentOut])
async def list_transaction_enrichments(
    transaction_id: int,
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
) -> list[TransactionEnrichmentOut]:
    tx_r = await session.execute(select(Transaction).where(Transaction.id == transaction_id))
    tx = tx_r.scalar_one_or_none()
    if tx is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Buchung nicht gefunden")
    if not await bank_account_visible_to_user(session, user, tx.bank_account_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Kein Zugriff auf diese Buchung")

    r = await session.execute(
        select(TransactionEnrichment)
        .where(TransactionEnrichment.transaction_id == transaction_id)
        .options(
            joinedload(TransactionEnrichment.external_record),
        )
        .order_by(TransactionEnrichment.matched_at.desc(), TransactionEnrichment.id.desc())
    )
    rows = r.scalars().all()
    out: list[TransactionEnrichmentOut] = []
    for row in rows:
        rec = row.external_record
        if rec is None:
            continue
        try:
            details = json.loads(rec.details_json or "{}")
            if not isinstance(details, dict):
                details = {}
        except Exception:
            details = {}
        try:
            raw = json.loads(rec.raw_json or "{}")
            if not isinstance(raw, dict):
                raw = {}
        except Exception:
            raw = {}
        out.append(
            TransactionEnrichmentOut(
                id=row.id,
                source=row.source,
                external_ref=rec.external_ref,
                booking_date=rec.booking_date,
                amount=rec.amount,
                currency=rec.currency,
                description=rec.description,
                counterparty=rec.counterparty,
                vendor=rec.vendor,
                details=details,
                raw=raw,
                matched_at=row.matched_at,
            )
        )
    return out


@router.post("/enrichments/import", response_model=ExternalRecordsImportResult)
async def import_external_records(
    body: ExternalRecordsImportBody,
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
) -> ExternalRecordsImportResult:
    source = (body.source or "").strip().lower()
    if source not in {ExternalRecordSource.paypal.value, ExternalRecordSource.amazon.value}:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Quelle muss 'paypal' oder 'amazon' sein.")
    if not await user_has_household(session, user.id, body.household_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Kein Zugriff auf diesen Haushalt.")
    if not body.records:
        return ExternalRecordsImportResult(
            imported=0, matched=0, unmatched=0, skipped_low_confidence=0, skipped_internal=0
        )

    imported_ids: list[int] = []
    for item in body.records:
        row = await upsert_external_record(
            session,
            household_id=body.household_id,
            source=source,
            external_ref=(item.external_ref or "").strip(),
            booking_date=item.booking_date,
            amount=item.amount,
            currency=(item.currency or "EUR").strip().upper(),
            description=item.description or "",
            counterparty=item.counterparty,
            vendor=item.vendor,
            details=item.details,
            raw=item.raw,
        )
        imported_ids.append(row.id)

    if body.auto_match:
        st = await rematch_external_records(
            session,
            household_id=body.household_id,
            source=source,
            external_record_ids=imported_ids,
        )
    else:
        st = ExternalRecordsImportResult(
            imported=len(imported_ids),
            matched=0,
            unmatched=len(imported_ids),
            skipped_low_confidence=0,
            skipped_internal=0,
        )
    await session.commit()
    return ExternalRecordsImportResult(
        imported=st.imported,
        matched=st.matched,
        unmatched=st.unmatched,
        skipped_low_confidence=st.skipped_low_confidence,
        skipped_internal=st.skipped_internal,
    )


@router.post("/enrichments/rematch", response_model=ExternalRecordsImportResult)
async def rematch_external_records_endpoint(
    household_id: int,
    source: str,
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
) -> ExternalRecordsImportResult:
    src = (source or "").strip().lower()
    if src not in {ExternalRecordSource.paypal.value, ExternalRecordSource.amazon.value}:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Quelle muss 'paypal' oder 'amazon' sein.")
    if not await user_has_household(session, user.id, household_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Kein Zugriff auf diesen Haushalt.")
    st = await rematch_external_records(
        session,
        household_id=household_id,
        source=src,
    )
    await session.commit()
    return ExternalRecordsImportResult(
        imported=st.imported,
        matched=st.matched,
        unmatched=st.unmatched,
        skipped_low_confidence=st.skipped_low_confidence,
        skipped_internal=st.skipped_internal,
    )


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
    meta_map = await enrichment_list_meta_for_transactions(session, [tx2.id])
    m = meta_map[tx2.id]
    transfer_kind_map = await _transfer_kind_map_for_transactions(
        session,
        current_user_id=user.id,
        rows=[tx2],
    )
    return transaction_to_out(
        tx2,
        enrichment_preview_lines=m.preview_lines,
        transfer_kind=transfer_kind_map.get(tx2.id, TransferKind.none),
    )


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
