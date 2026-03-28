from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Any, Optional

from pydantic import BaseModel, Field


class ExternalRecordImportItem(BaseModel):
    external_ref: str = ""
    booking_date: date
    amount: Decimal
    currency: str = "EUR"
    description: str = ""
    counterparty: Optional[str] = None
    vendor: Optional[str] = None
    details: dict[str, Any] = Field(default_factory=dict)
    raw: dict[str, Any] = Field(default_factory=dict)


class ExternalRecordsImportBody(BaseModel):
    household_id: int
    source: str
    records: list[ExternalRecordImportItem] = Field(default_factory=list, max_length=5000)
    auto_match: bool = True


class ExternalRecordsImportResult(BaseModel):
    imported: int
    matched: int
    unmatched: int
    skipped_low_confidence: int
    skipped_internal: int = Field(
        0,
        description="PayPal: Zeilen ohne Bank-Match-Versuch (z. B. interne Bankgutschrift auf PayPal-Konto).",
    )


class ExternalRecordMappingOut(BaseModel):
    record_id: int
    source: str
    external_ref: str
    order_id: Optional[str] = None
    booking_date: date
    amount: Decimal
    currency: str
    description: str
    counterparty: Optional[str]
    vendor: Optional[str]
    matched: bool
    matched_transaction_id: Optional[int] = None
    matched_bank_account_id: Optional[int] = None
    matched_bank_account_name: Optional[str] = None
    matched_booking_date: Optional[date] = None
    matched_amount: Optional[Decimal] = None
    matched_currency: Optional[str] = None
    matched_description: Optional[str] = None
    matched_counterparty: Optional[str] = None
    matched_at: Optional[datetime] = None


class TransactionEnrichmentOut(BaseModel):
    id: int
    source: str
    external_ref: str
    booking_date: date
    amount: Decimal
    currency: str
    description: str
    counterparty: Optional[str]
    vendor: Optional[str]
    details: dict[str, Any] = Field(default_factory=dict)
    raw: dict[str, Any] = Field(default_factory=dict)
    matched_at: datetime
