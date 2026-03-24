from __future__ import annotations

import re
from typing import Optional

from pydantic import BaseModel, Field, field_validator

_HEX = re.compile(r"^#[0-9A-Fa-f]{6}$")
_MUI_ICON_TOKEN = re.compile(r"^mui:[A-Za-z][A-Za-z0-9]*$")
_MUI_ICON_MAX_LEN = 64
_MAX_IMAGE_B64 = 280_000


def _normalize_icon_emoji(v: Optional[str]) -> Optional[str]:
    if v is None:
        return None
    s = v.strip()
    if not s:
        return None
    if s.startswith("mui:"):
        if len(s) > _MUI_ICON_MAX_LEN or not _MUI_ICON_TOKEN.match(s):
            raise ValueError("Ungültiges Symbol (mui:…)")
        return s
    return s


class CategoryBaseFields(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    color_hex: Optional[str] = Field(
        default=None,
        description="Hauptkategorie: Pflicht beim Anlegen. Unterkategorie: leer = Variante der Hauptfarbe.",
    )
    icon_emoji: Optional[str] = Field(default=None, max_length=_MUI_ICON_MAX_LEN)
    image_mime: Optional[str] = Field(default=None, max_length=64)
    image_base64: Optional[str] = Field(default=None, max_length=_MAX_IMAGE_B64)

    @field_validator("color_hex")
    @classmethod
    def validate_hex(cls, v: Optional[str]) -> Optional[str]:
        if v is None or v == "":
            return None
        s = v.strip()
        if not s.startswith("#"):
            s = "#" + s
        if not _HEX.match(s):
            raise ValueError("color_hex muss #RRGGBB sein")
        return s.lower()

    @field_validator("image_mime")
    @classmethod
    def validate_mime(cls, v: Optional[str]) -> Optional[str]:
        if v is None or v == "":
            return None
        allowed = {"image/png", "image/jpeg", "image/webp", "image/gif"}
        if v.lower() not in allowed:
            raise ValueError(f"Bildtyp erlaubt: {', '.join(sorted(allowed))}")
        return v.lower()

    @field_validator("icon_emoji")
    @classmethod
    def strip_emoji(cls, v: Optional[str]) -> Optional[str]:
        return _normalize_icon_emoji(v)


class CategoryCreate(CategoryBaseFields):
    parent_id: Optional[int] = Field(default=None, description="NULL = Hauptkategorie")


class CategoryUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=255)
    color_hex: Optional[str] = None
    icon_emoji: Optional[str] = Field(default=None, max_length=_MUI_ICON_MAX_LEN)
    image_mime: Optional[str] = Field(default=None, max_length=64)
    image_base64: Optional[str] = Field(default=None, max_length=_MAX_IMAGE_B64)
    clear_image: bool = False

    @field_validator("color_hex")
    @classmethod
    def validate_hex(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        if v == "":
            return None
        s = v.strip()
        if not s.startswith("#"):
            s = "#" + s
        if not _HEX.match(s):
            raise ValueError("color_hex muss #RRGGBB sein")
        return s.lower()

    @field_validator("image_mime")
    @classmethod
    def validate_mime(cls, v: Optional[str]) -> Optional[str]:
        if v is None or v == "":
            return None
        allowed = {"image/png", "image/jpeg", "image/webp", "image/gif"}
        if v.lower() not in allowed:
            raise ValueError(f"Bildtyp erlaubt: {', '.join(sorted(allowed))}")
        return v.lower()

    @field_validator("icon_emoji")
    @classmethod
    def validate_icon_emoji(cls, v: Optional[str]) -> Optional[str]:
        return _normalize_icon_emoji(v)


class CategoryOut(BaseModel):
    id: int
    household_id: int
    name: str
    parent_id: Optional[int]
    color_hex: Optional[str]
    effective_color_hex: str
    icon_emoji: Optional[str]
    image_mime: Optional[str]
    has_image: bool
    created_by_user_id: Optional[int] = None
    created_by_display: Optional[str] = Field(
        default=None,
        description="Anzeigename oder E-Mail des Nutzers, der die Kategorie angelegt hat.",
    )
    children: list["CategoryOut"] = Field(default_factory=list)

    model_config = {"from_attributes": False}
