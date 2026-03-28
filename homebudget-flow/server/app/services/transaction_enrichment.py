from __future__ import annotations

import json
import re
from hashlib import sha1
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from typing import Optional

from sqlalchemy import and_, case, delete, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import (
    AccountGroup,
    BankAccount,
    ExternalRecordSource,
    ExternalTransactionRecord,
    Transaction,
    TransactionEnrichment,
)

_ORDER_ID_RE = re.compile(r"^\d{3}-\d{7}-\d{7}$")


def _extract_order_id(rec: ExternalTransactionRecord) -> str:
    """Amazon Order-ID aus details_json (bevorzugt) oder external_ref."""
    try:
        details = json.loads(rec.details_json or "{}")
        if isinstance(details, dict):
            oid = str(details.get("order_id") or "").strip()
            if _ORDER_ID_RE.match(oid):
                return oid
    except Exception:
        pass
    ref = (rec.external_ref or "").strip()
    if ":" in ref:
        ref = ref.split(":", 1)[0].strip()
    if _ORDER_ID_RE.match(ref):
        return ref
    return ""


def _extract_ship_date(rec: ExternalTransactionRecord) -> date:
    """Ship-Date aus details_json (nur Datum), fallback booking_date."""
    try:
        details = json.loads(rec.details_json or "{}")
        if isinstance(details, dict):
            raw = str(details.get("ship_date") or "").strip()
            if raw:
                # z.B. 2026-02-25T07:30:43.564Z
                d = raw[:10]
                if re.match(r"^\d{4}-\d{2}-\d{2}$", d):
                    return date.fromisoformat(d)
    except Exception:
        pass
    return rec.booking_date


@dataclass
class MatchingStats:
    imported: int = 0
    matched: int = 0
    unmatched: int = 0
    skipped_low_confidence: int = 0
    skipped_internal: int = 0


async def upsert_external_record(
    session: AsyncSession,
    *,
    household_id: int,
    source: str,
    external_ref: str,
    booking_date: date,
    amount: Decimal,
    currency: str,
    description: str,
    counterparty: Optional[str],
    vendor: Optional[str],
    details: dict,
    raw: dict,
) -> ExternalTransactionRecord:
    normalized_ref = (external_ref or "").strip()
    if not normalized_ref:
        sig = f"{source}|{booking_date.isoformat()}|{amount}|{currency}|{description}|{counterparty or ''}|{vendor or ''}"
        normalized_ref = f"auto:{sha1(sig.encode('utf-8')).hexdigest()}"
    r = await session.execute(
        select(ExternalTransactionRecord).where(
            ExternalTransactionRecord.source == source,
            ExternalTransactionRecord.external_ref == normalized_ref,
        )
    )
    row = r.scalar_one_or_none()
    if row is None:
        row = ExternalTransactionRecord(
            household_id=household_id,
            source=source,
            external_ref=normalized_ref,
            booking_date=booking_date,
            amount=amount,
            currency=currency,
            description=description or "",
            counterparty=counterparty,
            vendor=vendor,
            details_json=json.dumps(details or {}, ensure_ascii=True),
            raw_json=json.dumps(raw or {}, ensure_ascii=True),
        )
        session.add(row)
    else:
        row.booking_date = booking_date
        row.amount = amount
        row.currency = currency
        row.description = description or ""
        row.counterparty = counterparty
        row.vendor = vendor
        row.details_json = json.dumps(details or {}, ensure_ascii=True)
        row.raw_json = json.dumps(raw or {}, ensure_ascii=True)
    await session.flush()
    return row


async def _rematch_amazon_records(
    session: AsyncSession,
    *,
    account_ids: list[int],
    records: list[ExternalTransactionRecord],
    source: str,
) -> int:
    """
    Amazon: zuerst jede CSV-Position gegen eine Buchung mit gleichem Betrag (Lastschrift negativ),
    dann Fallback (order_id, Versandtag)-Cluster mit Summe — nur wenn es keine passende Einzelbuchung gibt.
    """
    matched = 0
    used_tx_ids: set[int] = set()

    amazon_recs = [r for r in records if _extract_order_id(r)]
    # Phase 1: exakter Betrag pro Position; bei gleichen Beträgen (z. B. zwei × 8,99) Buchungen nur einmal verwenden.
    # Spätere Lieferungen zuerst: bei gleichen Beträgen (z. B. zwei × 8,99) soll die Abbuchung vom
    # passenden Tag (z. B. 15.01.) nicht schon von einer früheren Positions-Schleife „verbraucht“ werden.
    phase1_order = sorted(amazon_recs, key=lambda r: (_extract_ship_date(r), r.id), reverse=True)
    matched_rec_ids: set[int] = set()
    for rec in phase1_order:
        order_id = _extract_order_id(rec)
        ship_d = _extract_ship_date(rec)
        want_amount = -abs(rec.amount)
        tx_r = await session.execute(
            select(Transaction).where(
                Transaction.bank_account_id.in_(account_ids),
                Transaction.amount == want_amount,
                or_(
                    Transaction.description.ilike(f"%{order_id}%"),
                    Transaction.counterparty.ilike(f"%{order_id}%"),
                ),
            )
        )
        candidates = [t for t in tx_r.scalars().all() if t.id not in used_tx_ids]
        if not candidates:
            continue
        best_tx = min(
            candidates,
            key=lambda tx: (abs((tx.booking_date - ship_d).days), tx.id),
        )
        used_tx_ids.add(best_tx.id)
        matched_rec_ids.add(rec.id)
        session.add(
            TransactionEnrichment(
                transaction_id=best_tx.id,
                external_record_id=rec.id,
                source=source,
                matched_at=datetime.utcnow(),
            )
        )
        matched += 1

    # Phase 2: nur noch ungemappte Positionen; Cluster nach Kalendertag (eine Abbuchung für Summe).
    remaining = [r for r in amazon_recs if r.id not in matched_rec_ids]
    groups: dict[tuple[str, date], list[ExternalTransactionRecord]] = {}
    for rec in remaining:
        oid = _extract_order_id(rec)
        ship_d = _extract_ship_date(rec)
        groups.setdefault((oid, ship_d), []).append(rec)

    for (order_id, ship_d), recs in groups.items():
        group_sum = sum((r.amount for r in recs), Decimal("0.00"))
        target_amount = -abs(group_sum)

        tx_where = [
            Transaction.bank_account_id.in_(account_ids),
            Transaction.amount < 0,
            or_(
                Transaction.description.ilike(f"%{order_id}%"),
                Transaction.counterparty.ilike(f"%{order_id}%"),
            ),
        ]
        if used_tx_ids:
            tx_where.append(Transaction.id.notin_(used_tx_ids))

        tx_order_r = await session.execute(
            select(Transaction).where(and_(*tx_where)).order_by(Transaction.booking_date.desc(), Transaction.id.desc())
        )
        txs = tx_order_r.scalars().all()
        if not txs:
            continue

        def _rank(tx: Transaction) -> tuple[int, int, int]:
            amount_eq = 1 if tx.amount == target_amount else 0
            day_diff = abs((tx.booking_date - ship_d).days)
            return (amount_eq, -day_diff, tx.id)

        best_tx = sorted(txs, key=_rank, reverse=True)[0]
        used_tx_ids.add(best_tx.id)
        for rec in recs:
            session.add(
                TransactionEnrichment(
                    transaction_id=best_tx.id,
                    external_record_id=rec.id,
                    source=source,
                    matched_at=datetime.utcnow(),
                )
            )
            matched += 1

    return matched


_PAYPAL_SKIP_MATCH = frozenset({"Bankgutschrift auf PayPal-Konto"})


def _paypal_row_match_eligible(rec: ExternalTransactionRecord) -> bool:
    """Nur echte Zahlungs-/Lastschrift-Zeilen; keine interne Kontofüllung von der Bank."""
    try:
        details = json.loads(rec.details_json or "{}")
        if isinstance(details, dict):
            t = str(details.get("paypal_beschreibung") or "").strip()
            if t in _PAYPAL_SKIP_MATCH:
                return False
    except Exception:
        pass
    return True


async def _rematch_paypal_records(
    session: AsyncSession,
    *,
    account_ids: list[int],
    records: list[ExternalTransactionRecord],
    source: str,
) -> tuple[int, int]:
    """
    PayPal-CSV-Zeilen mit Bankbuchungen verknüpfen: gleicher Betrag, PayPal im Text,
    kleinster Datumsabstand. Bankgutschrift-Zeilen werden nicht gematcht.
    Returns (matched_count, skipped_internal_count).
    """
    skipped_internal = sum(1 for r in records if not _paypal_row_match_eligible(r))
    eligible = [r for r in records if _paypal_row_match_eligible(r)]
    matched = 0
    used_tx_ids: set[int] = set()

    paypal_pred = or_(
        Transaction.description.ilike("%paypal%"),
        Transaction.counterparty.ilike("%paypal%"),
    )

    order = sorted(eligible, key=lambda r: (r.booking_date, r.id))
    for rec in order:
        tx_r = await session.execute(
            select(Transaction).where(
                Transaction.bank_account_id.in_(account_ids),
                Transaction.amount == rec.amount,
                paypal_pred,
            )
        )
        candidates = [t for t in tx_r.scalars().all() if t.id not in used_tx_ids]
        if not candidates:
            continue
        best_tx = min(
            candidates,
            key=lambda tx: (abs((tx.booking_date - rec.booking_date).days), tx.id),
        )
        used_tx_ids.add(best_tx.id)
        session.add(
            TransactionEnrichment(
                transaction_id=best_tx.id,
                external_record_id=rec.id,
                source=source,
                matched_at=datetime.utcnow(),
            )
        )
        matched += 1

    return matched, skipped_internal


async def rematch_external_records(
    session: AsyncSession,
    *,
    household_id: int,
    source: str,
    external_record_ids: Optional[list[int]] = None,
) -> MatchingStats:
    stats = MatchingStats()
    rec_q = select(ExternalTransactionRecord).where(
        ExternalTransactionRecord.household_id == household_id,
        ExternalTransactionRecord.source == source,
    )
    if external_record_ids:
        rec_q = rec_q.where(ExternalTransactionRecord.id.in_(external_record_ids))
    rec_r = await session.execute(rec_q.order_by(ExternalTransactionRecord.booking_date.desc()))
    records = rec_r.scalars().all()
    stats.imported = len(records)
    if not records:
        return stats

    acc_r = await session.execute(
        select(BankAccount.id).join(AccountGroup).where(AccountGroup.household_id == household_id)
    )
    account_ids = [row[0] for row in acc_r.all()]
    if not account_ids:
        stats.unmatched = stats.imported
        return stats

    record_ids = [r.id for r in records]
    await session.execute(
        delete(TransactionEnrichment).where(
            and_(
                TransactionEnrichment.source == source,
                TransactionEnrichment.external_record_id.in_(record_ids),
            )
        )
    )

    if source == "amazon":
        stats.matched = await _rematch_amazon_records(
            session, account_ids=account_ids, records=records, source=source
        )
        stats.skipped_internal = 0
    elif source == "paypal":
        stats.matched, stats.skipped_internal = await _rematch_paypal_records(
            session, account_ids=account_ids, records=records, source=source
        )
    else:
        stats.matched = 0
        stats.skipped_internal = 0

    stats.unmatched = max(0, stats.imported - stats.matched - stats.skipped_internal)
    stats.skipped_low_confidence = 0
    return stats


def _clip_preview(s: str, max_len: int = 160) -> str:
    t = s.strip()
    if len(t) <= max_len:
        return t
    return f"{t[: max_len - 1]}…"


@dataclass(frozen=True)
class EnrichmentListMeta:
    """Externe Positionstexte für die Buchungsliste (z. B. alle Amazon-Zeilen)."""

    preview_lines: list[str]


async def enrichment_list_meta_for_transactions(
    session: AsyncSession, transaction_ids: list[int]
) -> dict[int, EnrichmentListMeta]:
    """Alle Produkt-/Beschreibungszeilen pro Buchung (Amazon vor PayPal, stabil nach Datensatz-ID)."""
    if not transaction_ids:
        return {}
    ids = list({int(x) for x in transaction_ids})
    r_prev = await session.execute(
        select(
            TransactionEnrichment.transaction_id,
            ExternalTransactionRecord.description,
        )
        .join(
            ExternalTransactionRecord,
            TransactionEnrichment.external_record_id == ExternalTransactionRecord.id,
        )
        .where(TransactionEnrichment.transaction_id.in_(ids))
        .order_by(
            TransactionEnrichment.transaction_id,
            case((TransactionEnrichment.source == ExternalRecordSource.amazon.value, 0), else_=1),
            ExternalTransactionRecord.id,
        )
    )
    lines_by_tx: dict[int, list[str]] = {tid: [] for tid in ids}
    for tx_id, desc in r_prev.all():
        tid = int(tx_id)
        d = (desc or "").strip()
        if d:
            lines_by_tx[tid].append(_clip_preview(d))

    return {tid: EnrichmentListMeta(preview_lines=lines_by_tx[tid]) for tid in ids}
