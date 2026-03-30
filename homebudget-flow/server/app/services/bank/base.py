from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Any


@dataclass
class FetchedTransaction:
    external_id: str
    amount: Decimal
    currency: str
    booking_date: date
    value_date: date | None
    description: str
    counterparty_name: str | None = None
    counterparty_iban: str | None = None
    counterparty_partner_name: str | None = None
    counterparty: str | None = None
    raw: dict[str, Any] | None = None


@dataclass
class FetchedAccountSnapshot:
    balance: Decimal
    currency: str
    transactions: list[FetchedTransaction]
    transactions_skipped: bool = False


class BankConnector(ABC):
    provider: str

    @abstractmethod
    async def fetch_balance(self, external_account_id: str) -> tuple[Decimal, str]:
        """Aktueller Saldo und Währung."""

    @abstractmethod
    async def fetch_transactions(
        self,
        external_account_id: str,
        from_date: date | None,
        to_date: date | None,
    ) -> list[FetchedTransaction]:
        """Buchungen im Zeitraum; None-Daten = maximale Bank-/Implementierungslogik."""

    async def fetch_snapshot(
        self,
        external_account_id: str,
        from_date: date | None,
        to_date: date | None,
    ) -> FetchedAccountSnapshot:
        """Saldo + Umsätze. Default: getrennte Calls (kann von Implementierungen überschrieben werden)."""
        balance, currency = await self.fetch_balance(external_account_id)
        txs = await self.fetch_transactions(external_account_id, from_date, to_date)
        return FetchedAccountSnapshot(
            balance=balance,
            currency=currency,
            transactions=txs,
            transactions_skipped=False,
        )
