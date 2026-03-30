from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field, field_validator

from app.db.models import Category, Transaction as TransactionRow
from app.services.category_colors import effective_color, normalize_hex
from sqlalchemy.exc import MissingGreenlet


def _effective_hex_for_category(cat: Category | None) -> str | None:
    if cat is None:
        return None
    is_child = cat.parent_id is not None
    if is_child:
        pr = cat.parent
        parent_color = (pr.color_hex or normalize_hex(None)) if pr is not None else normalize_hex(None)
        s_idx, s_n = 0, 1
        if pr is not None:
            try:
                sibs = sorted(getattr(pr, "children", []) or [], key=lambda c: c.id)
                if sibs:
                    s_n = len(sibs)
                    found = next((i for i, c in enumerate(sibs) if c.id == cat.id), None)
                    if found is not None:
                        s_idx = found
            except MissingGreenlet:
                # In Async-Kontext darf kein Lazy-Load passieren. Fallback: keine Sibling-Automatik.
                s_idx, s_n = 0, 1
        return effective_color(
            parent_color_hex=parent_color,
            own_color_hex=cat.color_hex,
            is_child=True,
            auto_sibling_index=s_idx,
            auto_sibling_count=s_n,
        )
    return effective_color(
        parent_color_hex=None,
        own_color_hex=cat.color_hex,
        is_child=False,
    )


class BookingFlow(str, Enum):
    """Aus dem Buchungsbetrag abgeleitet (Bankkonvention: positiv = Einnahme). Nicht in der DB gespeichert."""

    einnahme = "einnahme"
    ausgabe = "ausgabe"
    neutral = "neutral"


def booking_flow_from_amount(amount: Decimal) -> BookingFlow:
    if amount > 0:
        return BookingFlow.einnahme
    if amount < 0:
        return BookingFlow.ausgabe
    return BookingFlow.neutral


class TransferKind(str, Enum):
    """Klassifikation aus Sicht des angemeldeten Nutzers (nicht in der DB gespeichert)."""

    none = "none"
    own_internal = "own_internal"
    own_to_shared = "own_to_shared"
    own_to_other_user = "own_to_other_user"


class TransactionOut(BaseModel):
    id: int
    bank_account_id: int
    external_id: str
    amount: Decimal
    currency: str
    booking_date: date
    value_date: Optional[date]
    description: str
    counterparty: Optional[str]
    counterparty_name: Optional[str] = None
    counterparty_iban: Optional[str] = None
    counterparty_partner_name: Optional[str] = None
    counterparty_bic: Optional[str] = None
    raw_json: Optional[str] = None
    sepa_end_to_end_id: Optional[str] = None
    sepa_mandate_reference: Optional[str] = None
    sepa_creditor_id: Optional[str] = None
    bank_reference: Optional[str] = None
    customer_reference: Optional[str] = None
    prima_nota: Optional[str] = None
    imported_at: datetime
    category_id: Optional[int] = None
    category_name: Optional[str] = None
    category_color_hex: Optional[str] = None
    booking_flow: BookingFlow
    transfer_target_bank_account_id: Optional[int] = None
    transfer_kind: TransferKind = TransferKind.none
    # Externe Positionsbeschreibungen (z. B. alle Amazon-Produkte) für die Listenansicht
    enrichment_preview_lines: list[str] = Field(default_factory=list)

    model_config = {"from_attributes": True}

    @field_validator("enrichment_preview_lines", mode="before")
    @classmethod
    def _none_preview_lines_to_empty(cls, v: object) -> object:
        return v if v is not None else []


def transaction_to_out(
    row: TransactionRow,
    *,
    enrichment_preview_lines: list[str] | None = None,
    transfer_kind: TransferKind = TransferKind.none,
) -> TransactionOut:
    """ORM → API inkl. Kategoriename (Relationship ``category``)."""
    cat = row.category
    return TransactionOut(
        id=row.id,
        bank_account_id=row.bank_account_id,
        external_id=row.external_id,
        amount=row.amount,
        currency=row.currency,
        booking_date=row.booking_date,
        value_date=row.value_date,
        description=row.description,
        counterparty=row.counterparty,
        counterparty_name=getattr(row, "counterparty_name", None),
        counterparty_iban=getattr(row, "counterparty_iban", None),
        counterparty_partner_name=getattr(row, "counterparty_partner_name", None),
        counterparty_bic=getattr(row, "counterparty_bic", None),
        raw_json=getattr(row, "raw_json", None),
        sepa_end_to_end_id=getattr(row, "sepa_end_to_end_id", None),
        sepa_mandate_reference=getattr(row, "sepa_mandate_reference", None),
        sepa_creditor_id=getattr(row, "sepa_creditor_id", None),
        bank_reference=getattr(row, "bank_reference", None),
        customer_reference=getattr(row, "customer_reference", None),
        prima_nota=getattr(row, "prima_nota", None),
        imported_at=row.imported_at,
        category_id=row.category_id,
        category_name=cat.name if cat is not None else None,
        category_color_hex=_effective_hex_for_category(cat),
        booking_flow=booking_flow_from_amount(row.amount),
        transfer_target_bank_account_id=row.transfer_target_bank_account_id,
        transfer_kind=transfer_kind,
        enrichment_preview_lines=list(enrichment_preview_lines or []),
    )


class TransactionFilter(BaseModel):
    from_date: Optional[date] = None
    to_date: Optional[date] = None
    bank_account_id: Optional[int] = None
    limit: int = Field(default=200, le=2000)
    offset: int = 0


class TransactionCategoryUpdate(BaseModel):
    """Nur Kategorie setzen oder entfernen (``category_id: null``)."""

    category_id: Optional[int] = None


class BulkTransactionCategoryItem(BaseModel):
    transaction_id: int
    category_id: int


class BulkTransactionCategoryBody(BaseModel):
    items: list[BulkTransactionCategoryItem] = Field(default_factory=list, max_length=500)


class BulkTransactionCategoryResult(BaseModel):
    updated: int
