"""
Comdirect über FinTS (python-fints).

Zugang: optional `FintsCredentials` (gespeichert pro Nutzer) oder globale `FINTS_*` / Settings.

Das Bankkonto wird über die **IBAN** (normalisiert, wie in fints_test.py) an FinTS angebunden.
"""

from __future__ import annotations

import asyncio
from datetime import date
from decimal import Decimal

from app.services.bank.base import BankConnector, FetchedTransaction
from app.services.bank.fints_runner import FintsCredentials, fetch_balance_sync, fetch_transactions_sync
from app.services.bank.transaction_tan_channel import TransactionTanChannel


class ComdirectConnector(BankConnector):
    provider = "comdirect"

    def __init__(
        self,
        fints_credentials: FintsCredentials | None = None,
        tx_tan_channel: TransactionTanChannel | None = None,
    ) -> None:
        self.fints_credentials = fints_credentials
        self.tx_tan_channel = tx_tan_channel

    async def fetch_balance(self, external_account_id: str) -> tuple[Decimal, str]:
        return await asyncio.to_thread(
            fetch_balance_sync,
            external_account_id.strip(),
            self.fints_credentials,
        )

    async def fetch_transactions(
        self,
        external_account_id: str,
        from_date: date | None,
        to_date: date | None,
    ) -> list[FetchedTransaction]:
        return await asyncio.to_thread(
            fetch_transactions_sync,
            external_account_id.strip(),
            from_date,
            to_date,
            self.fints_credentials,
            self.tx_tan_channel,
        )
