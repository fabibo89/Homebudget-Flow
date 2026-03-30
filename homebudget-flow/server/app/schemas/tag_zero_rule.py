from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field

from app.schemas.category_rule import CategoryRuleConditionsBody

TagZeroRuleSource = Literal["none", "category_rule", "custom"]


class TagZeroRuleOut(BaseModel):
    source: TagZeroRuleSource
    category_rule_id: Optional[int] = None
    display_name_override: Optional[str] = Field(default=None, max_length=512)
    normalize_dot_space: bool = False
    conditions: list[dict[str, Any]] = Field(default_factory=list)


class TagZeroRuleUpsert(CategoryRuleConditionsBody):
    """Wie Kategorie-Regeln: conditions (UND) oder rule_type+pattern; plus Quelle."""

    source: TagZeroRuleSource
    category_rule_id: Optional[int] = None
