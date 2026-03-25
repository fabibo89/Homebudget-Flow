from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Optional

from pydantic import BaseModel, Field, field_validator

from app.db.models import BankAccountBalanceSnapshot


class BalanceSnapshotOut(BaseModel):
    """Ein gespeicherter Saldo-Stand zum Zeitpunkt eines erfolgreichen Syncs."""

    id: int
    bank_account_id: int
    balance: str
    currency: str
    recorded_at: datetime


class BalanceSnapshotUpdate(BaseModel):
    """Manuelle Korrektur eines Saldo-Snapshots (z. B. nach Bugfix)."""

    balance: Optional[Decimal] = Field(default=None, description="Neuer Saldo-Wert (mit Vorzeichen).")
    currency: Optional[str] = Field(default=None, max_length=8)
    recorded_at: Optional[datetime] = Field(default=None, description="Zeitpunkt des Snapshots.")

    @field_validator("currency")
    @classmethod
    def _currency_upper(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        return str(v).strip().upper()


def balance_snapshot_to_out(row: BankAccountBalanceSnapshot) -> BalanceSnapshotOut:
    return BalanceSnapshotOut(
        id=row.id,
        bank_account_id=row.bank_account_id,
        balance=str(row.balance),
        currency=row.currency,
        recorded_at=row.recorded_at,
    )
