"""
Stabile, konto-lokale externe Buchungs-ID für Import-Deduplizierung.

Basiert auf IBAN, Buchungs- und Wertstellung, Betrag, Verwendungszweck und Gegenpartei —
nicht auf Bank-„POS“-Zählern, die sich wiederholen können.
"""

from __future__ import annotations

import hashlib
import re
from datetime import date
from decimal import Decimal
from typing import Optional

_SEP = "\x1f"  # Feldtrenner im Canonical-String (nicht in normalem Freitext üblich)


def norm_iban(iban: str) -> str:
    return iban.replace(" ", "").upper()


def _normalize_text(s: str, max_len: int) -> str:
    t = (s or "").strip()
    t = re.sub(r"\s+", " ", t)
    return t[:max_len]


def _amount_key(amount: Decimal) -> str:
    q = amount.quantize(Decimal("0.01"))
    return format(q, "f")


def compute_stable_transaction_external_id(
    iban: str,
    booking_date: date,
    value_date: Optional[date],
    amount: Decimal,
    description: str,
    counterparty: Optional[str],
) -> str:
    """Liefert z. B. ``txv1|<64 hex>`` — deterministisch aus sichtbaren Buchungsmerkmalen."""
    parts = (
        "1",
        norm_iban(iban),
        booking_date.isoformat(),
        value_date.isoformat() if value_date else "",
        _amount_key(amount),
        _normalize_text(description, 2000),
        _normalize_text(counterparty or "", 512),
    )
    payload = _SEP.join(parts).encode("utf-8")
    digest = hashlib.sha256(payload).hexdigest()
    return f"txv1|{digest}"
