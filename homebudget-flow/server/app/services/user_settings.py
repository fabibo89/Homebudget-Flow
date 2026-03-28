"""Gemeinsame Logik für Nutzereinstellungen (Auth /me und temporäre /users/me/settings)."""

from __future__ import annotations

from typing import Any

from app.db.models import User


def apply_user_settings_updates(user: User, updates: dict[str, Any]) -> None:
    if "display_name" in updates:
        raw = updates["display_name"]
        if raw is None:
            user.display_name = ""
        else:
            user.display_name = str(raw).strip()[:255]
    if "all_household_transactions" in updates:
        user.all_household_transactions = bool(updates["all_household_transactions"])
