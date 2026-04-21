from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, Field


class ContractRuleOut(BaseModel):
    id: int
    contract_id: int
    category_rule_id: int
    category_rule_display_name: str = ""
    category_id: Optional[int] = None
    category_name: Optional[str] = None
    enabled: bool
    priority: int
    conditions: list[dict[str, Any]] = Field(default_factory=list)
    normalize_dot_space: bool = False
    display_name_override: Optional[str] = None
    created_at: datetime
    updated_at: datetime


class ContractOut(BaseModel):
    id: int
    bank_account_id: int
    bank_account_name: str
    label: str
    rules: list[ContractRuleOut] = Field(default_factory=list)
    transaction_count: int = Field(
        0,
        description="Buchungen mit contract_id = dieser Vertrag (Zählung aller Zuordnungen am Konto).",
    )
    recurrence_label: str = Field(
        "",
        description="Geschätzter Rhythmus aus Buchungsdaten (z. B. monatlich, jährlich).",
    )
    created_at: datetime
    updated_at: datetime


class ContractCreateIn(BaseModel):
    bank_account_id: int
    label: str = Field(..., min_length=1, max_length=512)


class ContractUpdateIn(BaseModel):
    label: str = Field(..., min_length=1, max_length=512)


class ContractRuleCreateIn(BaseModel):
    category_rule_id: int = Field(..., ge=1)
    enabled: bool = True
    priority: int = 0


class ContractRuleUpdateIn(BaseModel):
    enabled: Optional[bool] = None
    priority: Optional[int] = None


class ContractApplyResult(BaseModel):
    ok: bool = True
    transactions_updated: int


class ContractSuggestionSimilarRuleOut(BaseModel):
    id: int
    display_name: str
    category_name: Optional[str] = None


class ContractSuggestionTransactionPreviewOut(BaseModel):
    id: int
    booking_date: str
    amount: str
    description: str
    counterparty: Optional[str] = None


class ContractSuggestionOut(BaseModel):
    """Ein Vorschlag entspricht einer potentiellen Regel (conditions) + Label für UX."""

    fingerprint: str
    bank_account_id: int
    label: str
    conditions: list[dict[str, Any]] = Field(default_factory=list)
    normalize_dot_space: bool = False
    occurrence_count: int = Field(0, description="Trefferhäufigkeit der Gruppe in den betrachteten Buchungen.")
    scanned_transactions_returned: int = Field(
        0,
        description="Anzahl geladener Buchungen für die Heuristik (neueste zuerst, Limit scan_limit).",
    )
    scan_limit: int = Field(2000, description="Max. Anzahl Buchungen pro Vorschlags-Lauf.")
    recurrence_label: str = Field(
        "",
        description="Geschätzter Rhythmus aus den Buchungsterminen der Gruppe im Scan-Fenster.",
    )
    similar_category_rules: list[ContractSuggestionSimilarRuleOut] = Field(default_factory=list)
    transactions_preview: list[ContractSuggestionTransactionPreviewOut] = Field(default_factory=list)


class ContractSuggestionIgnoreOut(BaseModel):
    fingerprint: str
    bank_account_id: int
    created_at: datetime
