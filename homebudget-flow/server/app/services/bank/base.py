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
    counterparty: str | None = None
    raw: dict[str, Any] | None = None


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
