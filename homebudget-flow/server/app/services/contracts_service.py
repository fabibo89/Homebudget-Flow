"""Persistente Verträge: Erkennung, Bestätigen (Buchungen verknüpfen), Ignorieren."""

from __future__ import annotations

from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Optional

from sqlalchemy import or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import (
    AccountGroup,
    BankAccount,
    ContractStatus,
    HouseholdContract,
    Transaction,
    TransferPair,
)
from app.services.contracts_detection import (
    _amount_abs,
    _norm_counterparty_or_desc,
    contract_signature_hash,
    detect_contract_candidates,
    transaction_is_internal_transfer,
)


async def household_id_for_bank_account(session: AsyncSession, bank_account_id: int) -> Optional[int]:
    r = await session.execute(
        select(AccountGroup.household_id)
        .select_from(BankAccount)
        .join(AccountGroup, AccountGroup.id == BankAccount.account_group_id)
        .where(BankAccount.id == bank_account_id),
    )
    row = r.first()
    return int(row[0]) if row else None


async def load_transfer_pair_transaction_ids(
    session: AsyncSession,
    transaction_ids: list[int],
) -> set[int]:
    """Alle Buchungs-IDs, die in einem TransferPair vorkommen (bei Teil-Menge werden beide Beine des Paares geliefert)."""
    if not transaction_ids:
        return set()
    r = await session.execute(
        select(TransferPair.out_transaction_id, TransferPair.in_transaction_id).where(
            or_(
                TransferPair.out_transaction_id.in_(transaction_ids),
                TransferPair.in_transaction_id.in_(transaction_ids),
            ),
        ),
    )
    out: set[int] = set()
    for oid, iid in r.all():
        out.add(int(oid))
        out.add(int(iid))
    return out


async def transaction_ids_on_bank_account(session: AsyncSession, bank_account_id: int) -> list[int]:
    r = await session.execute(select(Transaction.id).where(Transaction.bank_account_id == bank_account_id))
    return [int(i) for i in r.scalars().all()]


def transaction_matches_contract(
    tx: Transaction,
    hc: HouseholdContract,
    *,
    pair_transaction_ids: Optional[set[int]] = None,
) -> bool:
    if transaction_is_internal_transfer(tx, pair_transaction_ids):
        return False
    if int(tx.bank_account_id) != int(hc.bank_account_id):
        return False
    if Decimal(str(tx.amount)) >= 0:
        return False
    if _amount_abs(tx) != Decimal(str(hc.amount_abs)).quantize(Decimal("0.01")):
        return False
    return _norm_counterparty_or_desc(tx) == (hc.party_norm or "").strip()


async def link_transactions_for_confirmed_contract(session: AsyncSession, hc: HouseholdContract) -> int:
    """Setzt contract_id auf alle passenden Ausgabenbuchungen; entfernt Verknüpfung wenn nicht mehr passend."""
    r_all = await session.execute(
        select(Transaction).where(Transaction.bank_account_id == hc.bank_account_id),
    )
    txs = r_all.scalars().all()
    acc_ids = [int(t.id) for t in txs]
    pair_ids = await load_transfer_pair_transaction_ids(session, acc_ids)
    matched_ids: set[int] = set()
    for tx in txs:
        if transaction_matches_contract(tx, hc, pair_transaction_ids=pair_ids):
            matched_ids.add(int(tx.id))

    updated = 0
    for tx in txs:
        tid = int(tx.id)
        want = tid in matched_ids
        have = tx.contract_id == hc.id
        if want and not have:
            tx.contract_id = hc.id
            updated += 1
        elif not want and have:
            tx.contract_id = None
            updated += 1

    return updated


async def run_contract_recognition(
    session: AsyncSession,
    *,
    household_id: int,
    acc_ids: list[int],
    accounts_by_id: dict[int, BankAccount],
    months_back: int = 60,
) -> tuple[int, int]:
    """
    Analysiert alle Buchungen der Konten im Zeitraum, upsert Vorschläge, aktualisiert bestätigte Links.
    Returns: (anzahl_vorschlag_änderungen, anzahl_bestätigte_mit_link_updates)
    """
    if not acc_ids:
        return 0, 0

    today = date.today()
    from_day = today - timedelta(days=30 * months_back)

    r = await session.execute(select(Transaction).where(Transaction.bank_account_id.in_(acc_ids)))
    txs = [t for t in r.scalars().all() if t.booking_date >= from_day]

    tx_ids = [int(t.id) for t in txs]
    pair_ids = await load_transfer_pair_transaction_ids(session, tx_ids)

    candidates = detect_contract_candidates(
        transactions=txs,
        accounts_by_id=accounts_by_id,
        min_occurrences=3,
        pair_transaction_ids=pair_ids,
    )

    r_existing = await session.execute(
        select(HouseholdContract).where(HouseholdContract.household_id == household_id),
    )
    by_sig: dict[str, HouseholdContract] = {c.signature_hash: c for c in r_existing.scalars().all()}

    suggestion_changes = 0
    for cand in candidates:
        sig = contract_signature_hash(cand.bank_account_id, cand.party_norm, cand.amount_typical)
        existing = by_sig.get(sig)
        if existing is not None:
            if existing.status == ContractStatus.ignored.value:
                continue
            if existing.status == ContractStatus.confirmed.value:
                existing.label = cand.label
                existing.rhythm = cand.rhythm
                existing.rhythm_display = cand.rhythm_display
                existing.confidence = float(cand.confidence)
                existing.occurrences = cand.occurrences
                existing.first_booking = cand.first_booking
                existing.last_booking = cand.last_booking
                existing.updated_at = datetime.utcnow()
                continue
            existing.label = cand.label
            existing.rhythm = cand.rhythm
            existing.rhythm_display = cand.rhythm_display
            existing.confidence = float(cand.confidence)
            existing.occurrences = cand.occurrences
            existing.first_booking = cand.first_booking
            existing.last_booking = cand.last_booking
            existing.updated_at = datetime.utcnow()
            suggestion_changes += 1
            continue

        row = HouseholdContract(
            household_id=household_id,
            bank_account_id=cand.bank_account_id,
            signature_hash=sig,
            status=ContractStatus.suggested.value,
            party_norm=cand.party_norm,
            label=cand.label,
            amount_abs=Decimal(cand.amount_typical),
            currency=cand.currency,
            rhythm=cand.rhythm,
            rhythm_display=cand.rhythm_display,
            confidence=float(cand.confidence),
            occurrences=cand.occurrences,
            first_booking=cand.first_booking,
            last_booking=cand.last_booking,
        )
        session.add(row)
        by_sig[sig] = row
        suggestion_changes += 1

    refreshed = 0
    r_conf = await session.execute(
        select(HouseholdContract).where(
            HouseholdContract.household_id == household_id,
            HouseholdContract.status == ContractStatus.confirmed.value,
        ),
    )
    for hc in r_conf.scalars().all():
        n = await link_transactions_for_confirmed_contract(session, hc)
        if n:
            refreshed += 1

    return suggestion_changes, refreshed


async def confirm_contract(session: AsyncSession, hc: HouseholdContract) -> None:
    hc.status = ContractStatus.confirmed.value
    hc.confirmed_at = datetime.utcnow()
    hc.updated_at = datetime.utcnow()
    await link_transactions_for_confirmed_contract(session, hc)


async def fetch_transactions_for_contract_detail(
    session: AsyncSession,
    hc: HouseholdContract,
    *,
    limit: int = 2000,
) -> list[Transaction]:
    """
    Buchungen zur Anzeige unter dem Vertrag: bei bestätigt per contract_id,
    bei Vorschlag alle passenden Ausgaben (gleiche Matching-Heuristik wie Erkennung).
    """
    acc_tx_ids = await transaction_ids_on_bank_account(session, hc.bank_account_id)
    pair_ids = await load_transfer_pair_transaction_ids(session, acc_tx_ids)

    if hc.status == ContractStatus.confirmed.value:
        r = await session.execute(
            select(Transaction)
            .where(Transaction.contract_id == hc.id)
            .order_by(Transaction.booking_date.desc(), Transaction.id.desc())
            .limit(limit),
        )
        rows = [
            t
            for t in r.scalars().all()
            if not transaction_is_internal_transfer(t, pair_ids)
        ]
        return rows

    if hc.status == ContractStatus.suggested.value:
        r_all = await session.execute(
            select(Transaction).where(Transaction.bank_account_id == hc.bank_account_id),
        )
        matched = [
            t
            for t in r_all.scalars().all()
            if transaction_matches_contract(t, hc, pair_transaction_ids=pair_ids)
        ]
        matched.sort(key=lambda t: (t.booking_date, t.id), reverse=True)
        return matched[:limit]

    return []


async def sample_transaction_ids_for_contract(
    session: AsyncSession,
    hc: HouseholdContract,
    *,
    limit: int = 5,
) -> list[int]:
    """Letzte passende Buchungs-IDs (Anzeige in der Vertragsliste)."""
    acc_tx_ids = await transaction_ids_on_bank_account(session, hc.bank_account_id)
    pair_ids = await load_transfer_pair_transaction_ids(session, acc_tx_ids)
    r = await session.execute(
        select(Transaction)
        .where(Transaction.bank_account_id == hc.bank_account_id)
        .order_by(Transaction.booking_date.desc(), Transaction.id.desc()),
    )
    out: list[int] = []
    for tx in r.scalars().all():
        if transaction_matches_contract(tx, hc, pair_transaction_ids=pair_ids):
            out.append(int(tx.id))
            if len(out) >= limit:
                break
    return out


async def count_transactions_for_contract(session: AsyncSession, hc: HouseholdContract) -> int:
    if hc.status != ContractStatus.confirmed.value:
        return 0
    acc_tx_ids = await transaction_ids_on_bank_account(session, hc.bank_account_id)
    pair_ids = await load_transfer_pair_transaction_ids(session, acc_tx_ids)
    r = await session.execute(
        select(Transaction).where(Transaction.contract_id == hc.id),
    )
    return sum(
        1
        for t in r.scalars().all()
        if not transaction_is_internal_transfer(t, pair_ids)
    )


async def ignore_contract(session: AsyncSession, hc: HouseholdContract) -> None:
    was_confirmed = hc.status == ContractStatus.confirmed.value
    hc.status = ContractStatus.ignored.value
    hc.updated_at = datetime.utcnow()
    if was_confirmed:
        await session.execute(
            update(Transaction).where(Transaction.contract_id == hc.id).values(contract_id=None),
        )
    hc.confirmed_at = None
