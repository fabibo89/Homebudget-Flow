from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel

from app.db.models import BankAccountBalanceSnapshot


class BalanceSnapshotOut(BaseModel):
    """Ein gespeicherter Saldo-Stand zum Zeitpunkt eines erfolgreichen Syncs."""

    id: int
    bank_account_id: int
    balance: str
    currency: str
    recorded_at: datetime


def balance_snapshot_to_out(row: BankAccountBalanceSnapshot) -> BalanceSnapshotOut:
    return BalanceSnapshotOut(
        id=row.id,
        bank_account_id=row.bank_account_id,
        balance=str(row.balance),
        currency=row.currency,
        recorded_at=row.recorded_at,
    )
