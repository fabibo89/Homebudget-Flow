"""Komponierbare Kategorie-Regelbedingungen (UND-verknüpft)."""

from __future__ import annotations

import json
import re
from decimal import Decimal
from typing import Annotated, Any, List, Literal, Optional, Union

from pydantic import BaseModel, Field, TypeAdapter, model_validator

from app.db.models import CategoryRule, CategoryRuleType, Transaction


class DirectionCondition(BaseModel):
    type: Literal["direction"] = "direction"
    value: Literal["credit", "debit", "all"]


class DescriptionContainsCondition(BaseModel):
    type: Literal["description_contains"] = "description_contains"
    pattern: str = Field(..., min_length=1, max_length=512)


class DescriptionContainsWordCondition(BaseModel):
    """Wie „enthält“, aber nur ganze Wörter (Wortgrenzen); mehrere durch Leerzeichen = alle müssen vorkommen."""

    type: Literal["description_contains_word"] = "description_contains_word"
    pattern: str = Field(..., min_length=1, max_length=512)


class DescriptionEqualsCondition(BaseModel):
    type: Literal["description_equals"] = "description_equals"
    pattern: str = Field(..., min_length=1, max_length=512)


class CounterpartyContainsCondition(BaseModel):
    type: Literal["counterparty_contains"] = "counterparty_contains"
    pattern: str = Field(..., min_length=1, max_length=512)


class CounterpartyContainsWordCondition(BaseModel):
    type: Literal["counterparty_contains_word"] = "counterparty_contains_word"
    pattern: str = Field(..., min_length=1, max_length=512)


class CounterpartyEqualsCondition(BaseModel):
    type: Literal["counterparty_equals"] = "counterparty_equals"
    pattern: str = Field(..., min_length=1, max_length=512)


class AmountGteCondition(BaseModel):
    type: Literal["amount_gte"] = "amount_gte"
    amount: Decimal


class AmountLteCondition(BaseModel):
    type: Literal["amount_lte"] = "amount_lte"
    amount: Decimal


class AmountBetweenCondition(BaseModel):
    type: Literal["amount_between"] = "amount_between"
    min_amount: Optional[Decimal] = None
    max_amount: Optional[Decimal] = None

    @model_validator(mode="after")
    def at_least_one_bound(self) -> AmountBetweenCondition:
        if self.min_amount is None and self.max_amount is None:
            raise ValueError("amount_between braucht min_amount und/oder max_amount")
        return self


CategoryRuleCondition = Annotated[
    Union[
        DirectionCondition,
        DescriptionContainsCondition,
        DescriptionContainsWordCondition,
        DescriptionEqualsCondition,
        CounterpartyContainsCondition,
        CounterpartyContainsWordCondition,
        CounterpartyEqualsCondition,
        AmountGteCondition,
        AmountLteCondition,
        AmountBetweenCondition,
    ],
    Field(discriminator="type"),
]

_conditions_adapter: TypeAdapter[list[CategoryRuleCondition]] = TypeAdapter(list[CategoryRuleCondition])


def validate_conditions_list(raw: List[Any]) -> List[CategoryRuleCondition]:
    if len(raw) < 1:
        raise ValueError("Mindestens eine Bedingung erforderlich.")
    return _conditions_adapter.validate_python(raw)


def parse_conditions_json(raw: Optional[str]) -> List[CategoryRuleCondition]:
    if not raw or not raw.strip():
        return []
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return []
    if not isinstance(data, list):
        return []
    try:
        return _conditions_adapter.validate_python(data)
    except Exception:
        return []


def conditions_to_json(conditions: List[CategoryRuleCondition]) -> str:
    return json.dumps([c.model_dump(mode="json") for c in conditions], ensure_ascii=False)


def default_rule_display_name_from_pattern(pattern: str, conditions: List[CategoryRuleCondition]) -> str:
    """Vorgabe-Anzeigename: Filter-/Mustertext in Großbuchstaben (max. 512 Zeichen)."""
    pat = (pattern or "").strip()
    if pat:
        return pat.upper()[:512]
    for c in conditions:
        if isinstance(
            c,
            (
                DescriptionContainsCondition,
                DescriptionContainsWordCondition,
                DescriptionEqualsCondition,
                CounterpartyContainsCondition,
                CounterpartyContainsWordCondition,
                CounterpartyEqualsCondition,
            ),
        ):
            p = (c.pattern or "").strip()
            if p:
                return p.upper()[:512]
    return "REGEL"


def resolved_rule_display_name(rule: CategoryRule) -> str:
    """Effektiver Anzeigename: Override oder Vorgabe aus Muster."""
    o = (getattr(rule, "display_name_override", None) or "").strip()
    if o:
        return o[:512]
    conds = rule_effective_conditions(rule)
    return default_rule_display_name_from_pattern(rule.pattern or "", conds)


def _text_matches_whole_words(hay: str, pattern: str) -> bool:
    """Groß-/Kleinschreibung ignorieren; jeder durch Leerzeichen getrennte Token als ganzes Wort (\\b)."""
    hay_l = (hay or "").lower()
    terms = [t.strip().lower() for t in pattern.split() if t.strip()]
    if not terms:
        return False
    for t in terms:
        esc = re.escape(t)
        if not re.search(rf"\b{esc}\b", hay_l):
            return False
    return True


def conditions_from_legacy_api_type(rule_type: str, pattern: str) -> List[CategoryRuleCondition]:
    pat = pattern.strip()
    if not pat:
        raise ValueError("Muster darf nicht leer sein.")
    if rule_type == CategoryRuleType.description_contains.value:
        return [DescriptionContainsCondition(pattern=pat)]
    if rule_type == CategoryRuleType.description_contains_word.value:
        return [DescriptionContainsWordCondition(pattern=pat)]
    if rule_type == CategoryRuleType.description_equals.value:
        return [DescriptionEqualsCondition(pattern=pat)]
    if rule_type == CategoryRuleType.counterparty_contains.value:
        return [CounterpartyContainsCondition(pattern=pat)]
    if rule_type == CategoryRuleType.counterparty_contains_word.value:
        return [CounterpartyContainsWordCondition(pattern=pat)]
    if rule_type == CategoryRuleType.counterparty_equals.value:
        return [CounterpartyEqualsCondition(pattern=pat)]
    raise ValueError(f"Unbekannter Regeltyp: {rule_type}")


def legacy_rule_to_conditions(rule: CategoryRule) -> List[CategoryRuleCondition]:
    rt = rule.rule_type
    if rt == "conditions":
        return []
    pat = (rule.pattern or "").strip()
    if rt == CategoryRuleType.description_contains.value and pat:
        return [DescriptionContainsCondition(pattern=pat)]
    if rt == CategoryRuleType.description_contains_word.value and pat:
        return [DescriptionContainsWordCondition(pattern=pat)]
    if rt == CategoryRuleType.description_equals.value and pat:
        return [DescriptionEqualsCondition(pattern=pat)]
    if rt == CategoryRuleType.counterparty_contains.value and pat:
        return [CounterpartyContainsCondition(pattern=pat)]
    if rt == CategoryRuleType.counterparty_contains_word.value and pat:
        return [CounterpartyContainsWordCondition(pattern=pat)]
    if rt == CategoryRuleType.counterparty_equals.value and pat:
        return [CounterpartyEqualsCondition(pattern=pat)]
    return []


def rule_effective_conditions(rule: CategoryRule) -> List[CategoryRuleCondition]:
    parsed = parse_conditions_json(rule.conditions_json)
    if parsed:
        return parsed
    return legacy_rule_to_conditions(rule)


def conditions_for_api(rule: CategoryRule) -> List[dict[str, Any]]:
    return [c.model_dump(mode="json") for c in rule_effective_conditions(rule)]


def transaction_matches_conditions(tx: Transaction, conditions: List[CategoryRuleCondition]) -> bool:
    """Alle Bedingungen müssen erfüllt sein (UND). Leere Liste matcht nicht."""
    if not conditions:
        return False
    amt = tx.amount
    if not isinstance(amt, Decimal):
        amt = Decimal(str(amt))

    for c in conditions:
        if isinstance(c, DirectionCondition):
            if c.value == "credit" and not (amt > 0):
                return False
            if c.value == "debit" and not (amt < 0):
                return False
            continue
        if isinstance(c, DescriptionContainsCondition):
            needle = c.pattern.lower()
            hay = (tx.description or "").lower()
            if not needle or needle not in hay:
                return False
            continue
        if isinstance(c, DescriptionContainsWordCondition):
            if not _text_matches_whole_words(tx.description or "", c.pattern):
                return False
            continue
        if isinstance(c, DescriptionEqualsCondition):
            d = (tx.description or "").strip().lower()
            pat = c.pattern.strip().lower()
            if not pat or d != pat:
                return False
            continue
        if isinstance(c, CounterpartyContainsCondition):
            needle = c.pattern.lower()
            hay = (tx.counterparty or "").lower()
            if not needle or needle not in hay:
                return False
            continue
        if isinstance(c, CounterpartyContainsWordCondition):
            if not _text_matches_whole_words(tx.counterparty or "", c.pattern):
                return False
            continue
        if isinstance(c, CounterpartyEqualsCondition):
            cp = (tx.counterparty or "").strip().lower()
            pat = c.pattern.strip().lower()
            if not pat or not cp or cp != pat:
                return False
            continue
        if isinstance(c, AmountGteCondition):
            if amt < c.amount:
                return False
            continue
        if isinstance(c, AmountLteCondition):
            if amt > c.amount:
                return False
            continue
        if isinstance(c, AmountBetweenCondition):
            if c.min_amount is not None and amt < c.min_amount:
                return False
            if c.max_amount is not None and amt > c.max_amount:
                return False
            continue
        return False
    return True


def derive_rule_type_and_pattern(conditions: List[CategoryRuleCondition]) -> tuple[str, str]:
    """Für DB-Spalten rule_type / pattern (Anzeige, Legacy, Suche)."""
    if len(conditions) == 1:
        c0 = conditions[0]
        if isinstance(c0, DescriptionContainsCondition):
            return CategoryRuleType.description_contains.value, c0.pattern
        if isinstance(c0, DescriptionContainsWordCondition):
            return CategoryRuleType.description_contains_word.value, c0.pattern
        if isinstance(c0, DescriptionEqualsCondition):
            return CategoryRuleType.description_equals.value, c0.pattern
        if isinstance(c0, CounterpartyContainsCondition):
            return CategoryRuleType.counterparty_contains.value, c0.pattern
        if isinstance(c0, CounterpartyContainsWordCondition):
            return CategoryRuleType.counterparty_contains_word.value, c0.pattern
        if isinstance(c0, CounterpartyEqualsCondition):
            return CategoryRuleType.counterparty_equals.value, c0.pattern
    return "conditions", ""

