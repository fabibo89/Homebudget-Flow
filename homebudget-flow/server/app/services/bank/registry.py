from __future__ import annotations

from app.services.bank.base import BankConnector
from app.services.bank.comdirect import ComdirectConnector
from app.services.bank.fints_runner import FintsCredentials
from app.services.bank.transaction_tan_channel import TransactionTanChannel


def get_connector(
    provider: str,
    fints_credentials: FintsCredentials | None = None,
    tx_tan_channel: TransactionTanChannel | None = None,
) -> BankConnector:
    if provider == "comdirect":
        return ComdirectConnector(fints_credentials=fints_credentials, tx_tan_channel=tx_tan_channel)
    raise ValueError(f"Unbekannter Provider: {provider}")
