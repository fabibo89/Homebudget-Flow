from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, EmailStr, Field


class UserSettingsOut(BaseModel):
    """Antwort für GET/PATCH Nutzereinstellungen (temporäre Route)."""

    email: EmailStr
    display_name: str
    all_household_transactions: bool


class UserSettingsPatch(BaseModel):
    display_name: Optional[str] = Field(None, max_length=255)
    all_household_transactions: Optional[bool] = None
