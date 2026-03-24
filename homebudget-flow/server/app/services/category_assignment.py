"""Regeln für Zuordnung von Buchungen / Regeln zu Kategorien."""

from fastapi import HTTPException, status

from app.db.models import Category


def ensure_category_is_subcategory_for_assignment(cat: Category) -> None:
    """Hauptkategorien (parent_id is None) sind nur zur Gruppierung; Zuordnung nur auf Unterkategorien."""
    if cat.parent_id is None:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Nur Unterkategorien können Buchungen und Regeln zugeordnet werden — Hauptkategorien dienen nur der Gruppierung.",
        )
