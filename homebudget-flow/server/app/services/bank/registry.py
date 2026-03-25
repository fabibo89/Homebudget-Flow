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
    # Gleiche FinTS-Implementierung (python-fints); BLZ/Endpoint kommen aus dem Zugang.
    if provider in ("comdirect", "dkb"):
        return ComdirectConnector(fints_credentials=fints_credentials, tx_tan_channel=tx_tan_channel)
    raise ValueError(f"Unbekannter Provider: {provider}")
