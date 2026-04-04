"""Heuristische Erkennung wiederkehrender Zahlungen (Verträge / Abos) aus Buchungen."""

from __future__ import annotations

import hashlib
import statistics
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Literal, Optional, Union

from app.db.models import BankAccount, Transaction


def transaction_is_internal_transfer(
    tx: Transaction,
    pair_transaction_ids: Optional[set[int]] = None,
) -> bool:
    """True, wenn die Buchung als interne Umbuchung gilt (nicht für Vertrags-/Abo-Erkennung)."""
    if getattr(tx, "transfer_target_bank_account_id", None) is not None:
        return True
    ids = pair_transaction_ids or set()
    return int(tx.id) in ids

RhythmLabel = Literal["monthly", "quarterly", "yearly", "bi_monthly", "unknown"]


def _norm_counterparty_or_desc(tx: Transaction) -> str:
    c = (tx.counterparty or "").strip().lower()
    if len(c) >= 3:
        return c[:160]
    d = (tx.description or "").strip().lower().replace("\n", " ")[:160]
    return d or "—"


def _amount_abs(tx: Transaction) -> Decimal:
    return abs(Decimal(str(tx.amount))).quantize(Decimal("0.01"))


def _median_gap_days(booking_dates: list[date]) -> Optional[float]:
    if len(booking_dates) < 2:
        return None
    s = sorted(booking_dates)
    gaps = [(s[i + 1] - s[i]).days for i in range(len(s) - 1)]
    return float(statistics.median(gaps))


def _rhythm_from_median(median_days: float) -> RhythmLabel:
    if 24 <= median_days <= 35:
        return "monthly"
    if 55 <= median_days <= 68:
        return "bi_monthly"
    if 85 <= median_days <= 100:
        return "quarterly"
    if 350 <= median_days <= 380:
        return "yearly"
    return "unknown"


def _rhythm_label_de(label: RhythmLabel) -> str:
    return {
        "monthly": "monatlich",
        "bi_monthly": "zweimonatlich",
        "quarterly": "vierteljährlich",
        "yearly": "jährlich",
        "unknown": "unregelmäßig / unklar",
    }[label]


def contract_signature_hash(bank_account_id: int, party_norm: str, amount_abs: Union[Decimal, str]) -> str:
    """Stabiler Fingerabdruck für Konto + normalisierter Gegenpart + Betrag (abs)."""
    amt = str(Decimal(str(amount_abs)).quantize(Decimal("0.01")))
    raw = f"{bank_account_id}|{party_norm}|{amt}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class ContractCandidate:
    bank_account_id: int
    bank_account_name: str
    """Normalisierter Gegenpart/Beschreibungsschlüssel (wie Gruppierung), für Signatur und Matching."""
    party_norm: str
    label: str
    amount_typical: str
    currency: str
    rhythm: RhythmLabel
    rhythm_display: str
    occurrences: int
    first_booking: date
    last_booking: date
    confidence: float
    sample_transaction_ids: list[int]


def detect_contract_candidates(
    *,
    transactions: list[Transaction],
    accounts_by_id: dict[int, BankAccount],
    min_occurrences: int = 3,
    pair_transaction_ids: Optional[set[int]] = None,
) -> list[ContractCandidate]:
    """
    Gruppiert Ausgaben (amount < 0) nach Konto + normalisiertem Gegenpart/Beschreibung + gleichem Betrag (abs).
    Erkennt Rhythmus über medianen Abstand in Tagen (mind. min_occurrences Buchungen).
    Umbuchungen (Zielkonto / TransferPair) werden ausgeschlossen.
    """
    pair_ids = pair_transaction_ids or set()
    # Nur Ausgaben, keine Umbuchungen
    outflow = [
        t
        for t in transactions
        if Decimal(str(t.amount)) < 0 and not transaction_is_internal_transfer(t, pair_ids)
    ]
    if not outflow:
        return []

    groups: dict[tuple[int, str, str], list[Transaction]] = {}
    for tx in outflow:
        acc_id = int(tx.bank_account_id)
        key_party = _norm_counterparty_or_desc(tx)
        amt = _amount_abs(tx)
        gkey = (acc_id, key_party, str(amt))
        groups.setdefault(gkey, []).append(tx)

    candidates: list[ContractCandidate] = []
    for (acc_id, party_key, amt_s), txs in groups.items():
        if len(txs) < min_occurrences:
            continue
        txs_sorted = sorted(txs, key=lambda t: (t.booking_date, t.id))
        dates = [t.booking_date for t in txs_sorted]
        med_gap = _median_gap_days(dates)
        if med_gap is None or med_gap < 10:
            continue
        rhythm = _rhythm_from_median(med_gap)
        # Nur sinnvolle Rhythmen oder „unknown“ mit genug Abstand
        if rhythm == "unknown" and med_gap < 20:
            continue

        # Konfidenz: Anzahl + Stabilität der Abstände
        if len(dates) >= 2:
            s = sorted(dates)
            gaps = [(s[i + 1] - s[i]).days for i in range(len(s) - 1)]
            spread = statistics.pstdev(gaps) if len(gaps) > 1 else 0.0
        else:
            spread = 0.0
        conf = min(1.0, 0.35 + 0.12 * len(txs) - 0.01 * min(spread, 20))
        conf = max(0.0, min(1.0, conf))

        acc = accounts_by_id.get(acc_id)
        acc_name = acc.name if acc else f"Konto {acc_id}"
        cur = acc.currency if acc else "EUR"
        sample_ids = [t.id for t in txs_sorted[-5:]]

        candidates.append(
            ContractCandidate(
                bank_account_id=acc_id,
                bank_account_name=acc_name,
                party_norm=party_key,
                label=party_key[:120] if party_key != "—" else amt_s + " €",
                amount_typical=amt_s,
                currency=cur,
                rhythm=rhythm,
                rhythm_display=_rhythm_label_de(rhythm),
                occurrences=len(txs),
                first_booking=dates[0],
                last_booking=dates[-1],
                confidence=round(conf, 2),
                sample_transaction_ids=sample_ids,
            )
        )

    candidates.sort(key=lambda c: (-c.confidence, -c.occurrences, c.label))
    return candidates
