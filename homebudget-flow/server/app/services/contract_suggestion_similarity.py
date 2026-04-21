"""Abgleich Vertrags-Vorschläge (conditions-JSON) mit bestehenden Kategorie-Regeln."""

from __future__ import annotations

from decimal import Decimal, InvalidOperation
from typing import Any, Optional

from app.db.models import Category, CategoryRule
from app.schemas.category_rule_conditions import conditions_for_api, resolved_rule_display_name

_TEXT_TYPES = frozenset(
    {
        "description_contains",
        "description_contains_word",
        "description_equals",
        "counterparty_contains",
        "counterparty_contains_word",
        "counterparty_equals",
    },
)


def _norm_pat(s: str) -> str:
    return " ".join((s or "").strip().lower().split())


def _patterns_from_condition_dicts(conds: list[dict[str, Any]]) -> list[str]:
    out: list[str] = []
    for d in conds:
        t = d.get("type")
        if t in _TEXT_TYPES:
            p = _norm_pat(str(d.get("pattern") or ""))
            if len(p) >= 2:
                out.append(p)
    return out


def _amount_between_from_dicts(conds: list[dict[str, Any]]) -> tuple[Optional[Decimal], Optional[Decimal]]:
    lo: Optional[Decimal] = None
    hi: Optional[Decimal] = None
    for d in conds:
        if d.get("type") != "amount_between":
            continue
        for key in ("min_amount", "max_amount"):
            raw = d.get(key)
            if raw is None or str(raw).strip() == "":
                continue
            try:
                v = Decimal(str(raw))
            except (InvalidOperation, ValueError):
                continue
            if key == "min_amount":
                lo = v if lo is None else max(lo, v)
            else:
                hi = v if hi is None else min(hi, v)
    return lo, hi


def _intervals_overlap(
    a_lo: Optional[Decimal],
    a_hi: Optional[Decimal],
    b_lo: Optional[Decimal],
    b_hi: Optional[Decimal],
    *,
    pad: Decimal = Decimal("0.05"),
) -> bool:
    """Zwei [lo,hi]-Intervalle überlappen (fehlende Grenze = unbeschränkt auf dieser Seite)."""
    if a_lo is None and a_hi is None:
        return True
    if b_lo is None and b_hi is None:
        return True

    def widen(lo: Optional[Decimal], hi: Optional[Decimal]) -> tuple[Optional[Decimal], Optional[Decimal]]:
        if lo is not None:
            lo = lo - pad
        if hi is not None:
            hi = hi + pad
        return lo, hi

    a_lo, a_hi = widen(a_lo, a_hi)
    b_lo, b_hi = widen(b_lo, b_hi)

    eff_a_lo = a_lo if a_lo is not None else Decimal("-999999999")
    eff_a_hi = a_hi if a_hi is not None else Decimal("999999999")
    eff_b_lo = b_lo if b_lo is not None else Decimal("-999999999")
    eff_b_hi = b_hi if b_hi is not None else Decimal("999999999")
    return eff_a_lo <= eff_b_hi and eff_b_lo <= eff_a_hi


def suggestion_conditions_similar_to_category_rule(
    suggestion_conditions: list[dict[str, Any]],
    category_rule: CategoryRule,
) -> bool:
    """Grober Text-Muster-Overlap + optional Betrag; Richtung wird nicht verglichen."""
    if category_rule.category_missing:
        return False
    sugg_texts = _patterns_from_condition_dicts(suggestion_conditions)
    eff = conditions_for_api(category_rule)
    rule_texts = _patterns_from_condition_dicts(eff)
    if not sugg_texts or not rule_texts:
        return False

    st_a_lo, st_a_hi = _amount_between_from_dicts(suggestion_conditions)
    st_b_lo, st_b_hi = _amount_between_from_dicts(eff)

    for a in sugg_texts:
        for b in rule_texts:
            if len(a) < 2 or len(b) < 2:
                continue
            if a in b or b in a or a == b:
                if (st_a_lo is None and st_a_hi is None) or (st_b_lo is None and st_b_hi is None):
                    return True
                return _intervals_overlap(st_a_lo, st_a_hi, st_b_lo, st_b_hi)
    return False


def similar_category_rules_for_suggestion(
    suggestion_conditions: list[dict[str, Any]],
    household_rules: list[CategoryRule],
) -> list[CategoryRule]:
    out: list[CategoryRule] = []
    for cr in household_rules:
        if suggestion_conditions_similar_to_category_rule(suggestion_conditions, cr):
            out.append(cr)
    return out


def similar_rule_out_entries(rules: list[CategoryRule]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for cr in rules:
        cat: Optional[Category] = cr.category
        rows.append(
            {
                "id": int(cr.id),
                "display_name": resolved_rule_display_name(cr),
                "category_name": (cat.name if cat else None),
            }
        )
    return rows
