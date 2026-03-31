from __future__ import annotations

from datetime import date
from typing import Optional

from pydantic import BaseModel, Field


class DayZeroMeltdownDay(BaseModel):
    day: str = Field(..., description="Kalendertag YYYY-MM-DD (APP_TIMEZONE).")

    balance_actual: str = Field(..., description="Ist-Saldo (Betrag als String).")
    balance_target: str = Field(..., description="Soll-Saldo (linearer Burn-down auf 0).")

    spend_actual: str = Field(..., description="Ist-Ausgaben des Tages (Summe negativer Beträge, Transfers ausgeschlossen).")
    spend_target_fixed: str = Field(..., description="Soll-Ausgaben pro Tag (fix, an Tag Null berechnet).")
    spend_target_dynamic: str = Field(
        ...,
        description="Soll-Ausgaben pro Tag (dynamisch, abhängig vom Ist-Saldo und verbleibenden Tagen).",
    )

    remaining: str = Field(..., description="Übrig (gleich balance_actual).")


class DayZeroMeltdownOut(BaseModel):
    bank_account_id: int
    tag_zero_date: date
    period_start: date
    period_end_exclusive: date
    currency: str
    days: list[DayZeroMeltdownDay]


class HaDayZeroAccountToday(BaseModel):
    bank_account_id: int
    name: str
    currency: str
    tag_zero_date: Optional[str] = None
    period_end_exclusive: Optional[str] = None
    today: Optional[DayZeroMeltdownDay] = None


class HaDayZeroMeltdownSnapshot(BaseModel):
    accounts: list[HaDayZeroAccountToday]

