from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field

from app.db.models import Category, Transaction as TransactionRow
from app.services.category_colors import effective_color, normalize_hex


def _effective_hex_for_category(cat: Category | None) -> str | None:
    if cat is None:
        return None
    is_child = cat.parent_id is not None
    if is_child:
        pr = cat.parent
        parent_color = (pr.color_hex or normalize_hex(None)) if pr is not None else normalize_hex(None)
        s_idx, s_n = 0, 1
        if pr is not None:
            sibs = sorted(getattr(pr, "children", []) or [], key=lambda c: c.id)
            if sibs:
                s_n = len(sibs)
                found = next((i for i, c in enumerate(sibs) if c.id == cat.id), None)
                if found is not None:
                    s_idx = found
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
    imported_at: datetime
    category_id: Optional[int] = None
    category_name: Optional[str] = None
    category_color_hex: Optional[str] = None
    booking_flow: BookingFlow

    model_config = {"from_attributes": True}


def transaction_to_out(row: TransactionRow) -> TransactionOut:
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
        imported_at=row.imported_at,
        category_id=row.category_id,
        category_name=cat.name if cat is not None else None,
        category_color_hex=_effective_hex_for_category(cat),
        booking_flow=booking_flow_from_amount(row.amount),
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
