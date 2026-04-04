from __future__ import annotations

from datetime import date, datetime
from typing import Optional

from pydantic import BaseModel, Field


class ContractCandidateOut(BaseModel):
    """@deprecated — nur für Abwärtskompatibilität; Liste kommt aus DB (ContractOut)."""

    bank_account_id: int
    bank_account_name: str
    label: str = Field(description="Gegenpart oder Beschreibungs-Muster")
    amount_typical: str
    currency: str
    rhythm: str
    rhythm_display: str
    occurrences: int
    first_booking: date
    last_booking: date
    confidence: float = Field(ge=0, le=1)
    sample_transaction_ids: list[int]


class ContractOut(BaseModel):
    id: int
    household_id: int
    bank_account_id: int
    bank_account_name: str
    status: str
    label: str
    amount_typical: str
    currency: str
    rhythm: str
    rhythm_display: str
    occurrences: int
    first_booking: Optional[date]
    last_booking: Optional[date]
    confidence: float
    signature_hash: str
    sample_transaction_ids: list[int] = Field(default_factory=list)
    transaction_count: int = 0


class ContractRecognizeResult(BaseModel):
    suggestions_updated: int
    confirmed_links_touched: int


class ContractIgnoreResult(BaseModel):
    ok: bool = True


class ContractConfirmResult(BaseModel):
    ok: bool = True
    transactions_linked: int
