from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from enum import Enum
from typing import Any, Optional

from pydantic import BaseModel, Field


class CategoryRuleTypeSchema(str, Enum):
    description_contains = "description_contains"
    description_equals = "description_equals"
    counterparty_contains = "counterparty_contains"
    counterparty_equals = "counterparty_equals"


class CategoryRuleConditionsBody(BaseModel):
    """Gemeinsame Felder für Anlegen und Aktualisieren von Regelbedingungen."""

    conditions: Optional[list[dict[str, Any]]] = None
    """Komponierbare Bedingungen (UND). Mindestens ein Eintrag, wenn rule_type/pattern nicht gesetzt sind."""
    rule_type: Optional[CategoryRuleTypeSchema] = None
    pattern: Optional[str] = Field(None, max_length=512)
    """Nur mit rule_type: einzelne Textbedingung (Legacy-API)."""


class CategoryRuleCreate(CategoryRuleConditionsBody):
    category_id: int
    applies_to_household: bool = True
    """True: Regel gilt für alle Konten des Haushalts; False: nur für Konten, die der Ersteller sieht."""
    apply_to_uncategorized: bool = True
    """Alle noch unkategorisierten Buchungen des Haushalts anhand aller Regeln (neuere zuerst) zuordnen."""
    also_assign_transaction_id: Optional[int] = None
    """Diese Buchung immer auf category_id setzen (z. B. wenn das Muster angepasst wurde)."""


class CategoryRuleUpdate(CategoryRuleConditionsBody):
    category_id: int
    applies_to_household: bool = True
    apply_to_uncategorized: bool = True
    """Nach dem Speichern unkategorisierte Buchungen erneut zuordnen (wie beim Anlegen)."""


class CategoryRuleOut(BaseModel):
    id: int
    household_id: int
    category_id: Optional[int] = None
    category_missing: bool = False
    applies_to_household: bool = True
    rule_type: str
    pattern: str
    conditions: list[dict[str, Any]] = Field(default_factory=list)
    created_at: datetime
    created_by_user_id: Optional[int] = None
    created_by_display: Optional[str] = Field(
        default=None,
        description="Anzeigename oder E-Mail des Nutzers, der die Regel angelegt hat.",
    )

    model_config = {"from_attributes": True}


class CategoryRulesListOut(BaseModel):
    rules: list[CategoryRuleOut]
    warnings: list[str] = Field(default_factory=list)


class CategoryRuleOverwriteCandidate(BaseModel):
    """Buchung mit Kategorie, die sich bei strikter Regelanwendung ändern würde."""

    transaction_id: int
    bank_account_id: int
    booking_date: date
    amount: Decimal
    currency: str
    description: str
    counterparty: Optional[str]
    current_category_id: int
    current_category_name: str
    suggested_category_id: int
    suggested_category_name: str


class CategoryRuleSuggestionOut(BaseModel):
    """Heuristischer Vorschlag für eine neue *enthält*-Regel (unkategorisierte Buchungen)."""

    rule_type: CategoryRuleTypeSchema
    pattern: str
    transaction_count: int
    distinct_label_count: int
    sample_labels: list[str] = Field(default_factory=list)


class CategoryRuleSuggestionsBundle(BaseModel):
    active: list[CategoryRuleSuggestionOut]
    ignored: list[CategoryRuleSuggestionOut]


class CategoryRuleSuggestionPreviewBody(BaseModel):
    rule_type: CategoryRuleTypeSchema
    pattern: str = Field(..., min_length=1, max_length=512)
    sample_labels: list[str] = Field(default_factory=list, max_length=24)
    limit_per_label: int = Field(default=25, ge=1, le=100)
    limit_total: int = Field(default=200, ge=1, le=1000)


class CategoryRuleSuggestionPreviewGroup(BaseModel):
    label: str
    transactions: list["TransactionOut"]


class CategoryRuleSuggestionPreviewOut(BaseModel):
    rule_type: CategoryRuleTypeSchema
    pattern: str
    truncated: bool = False
    groups: list[CategoryRuleSuggestionPreviewGroup] = Field(default_factory=list)


class CategoryRuleSuggestionDismissCreate(BaseModel):
    """Snapshot eines Vorschlags beim Ignorieren (Anzeige unter „Ignoriert“)."""

    rule_type: CategoryRuleTypeSchema
    pattern: str = Field(..., min_length=1, max_length=512)
    transaction_count: int = Field(..., ge=0)
    distinct_label_count: int = Field(..., ge=0)
    sample_labels: list[str] = Field(default_factory=list)


class CategoryRuleSuggestionRestoreBody(BaseModel):
    rule_type: CategoryRuleTypeSchema
    pattern: str = Field(..., min_length=1, max_length=512)


class CategoryRuleCreatedOut(CategoryRuleOut):
    transactions_updated: int = 0
    """Anzahl Buchungen, die durch apply_to_uncategorized neu eine Kategorie erhielten."""
    category_overwrite_candidates: list[CategoryRuleOverwriteCandidate] = Field(default_factory=list)
    """Nur wenn apply_to_uncategorized: bereits kategorisierte Buchungen, die eine andere Regelkategorie hätten."""
    category_overwrite_truncated: bool = False
    """True, wenn mehr Treffer als category_overwrite_candidates zurückgegeben wurden."""


# Forward-ref resolution
from app.schemas.transaction import TransactionOut  # noqa: E402

CategoryRuleSuggestionPreviewGroup.model_rebuild()
CategoryRuleSuggestionPreviewOut.model_rebuild()
