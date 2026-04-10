from __future__ import annotations

from datetime import date
from typing import Optional

from pydantic import BaseModel, Field


class DayZeroMeltdownBookingRef(BaseModel):
    """Kompakte Buchung für Day-Zero-Transparenz (Umbuchung / Vertrag)."""

    id: int
    booking_date: date
    amount: str
    description: str = ""
    counterparty_name: Optional[str] = None
    transfer_target_bank_account_id: Optional[int] = Field(
        default=None,
        description="Bei Umbuchung: Zielkonto-ID, sonst null.",
    )
    contract_id: Optional[int] = None
    contract_label: Optional[str] = None


class DayZeroMeltdownDay(BaseModel):
    day: str = Field(..., description="Kalendertag YYYY-MM-DD (APP_TIMEZONE).")

    balance_actual: str = Field(
        ...,
        description=(
            "Meltdown-Ist-Saldo: gleicher Pfad wie konto_balance_actual (Eröffnung, kumulatives Tagesnetto, Regel/Umbuchung)."
        ),
    )
    balance_target: str = Field(..., description="Meltdown-Soll-Saldo (linearer Burn-down auf 0).")

    konto_balance_actual: str = Field(
        ...,
        description=(
            "Konto-Ist: Pfad ab angepasstem Start (+ Regelbetrag, ausgehende Umbuchungen im Verlauf neutralisiert); "
            "endet am Sync-Saldo."
        ),
    )
    konto_balance_target: str = Field(
        ...,
        description="Konto-Soll: lineare Linie von Tagesend-Saldo Tag Null bis 0 über die Periodenlänge.",
    )

    net_actual: str = Field(
        ...,
        description="Tages-Netto (Summe aller Buchungen des Tages, Transfers ausgeschlossen; Vorzeichen wie Buchungen).",
    )
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
    tag_zero_amount: Optional[str] = Field(
        default=None,
        description=(
            "Konto-Start: Bank-Rückrechnung bis Tag Null plus Tag-Null-Regelbetrag plus Summe ausgehender Umbuchungen (out_adj); "
            "entspricht konto_saldo_start_backcalc."
        ),
    )
    tag_zero_rule_booking_amount: Optional[str] = Field(
        default=None,
        description="Betrag der neuesten Buchung, die der Tag-Null-Kontoregel entspricht.",
    )
    #: Expliziter Meltdown-Start (Regel-Buchung inkl. interne Umbuchungs-Anpassung); gleiche Größe wie tag_zero_rule_booking_amount nach Ausgleich.
    meltdown_start_amount: Optional[str] = Field(
        default=None,
        description="Meltdown-Startwert (Anzeige): Regel-Buchungsbetrag zzgl. outgoing_internal_transfer_adjustment.",
    )
    #: Ob der für ``tag_zero_amount`` genutzte Saldo (v. a. Snapshot) die Tag-Null-Regel-Buchung schon enthält; None = kein Snapshot / nicht anwendbar.
    tag_zero_saldo_includes_rule_booking: Optional[bool] = Field(
        default=None,
        description="True: Snapshot-Saldo enthält Regel-Buchung (Heuristik). False: Betrag wurde nachgerechnet. None: Rückrechnung aus Buchungen oder kein Regel-Tx am Tag.",
    )
    period_start: date
    period_end_exclusive: date
    currency: str
    days: list[DayZeroMeltdownDay]
    transfer_bookings: list[DayZeroMeltdownBookingRef] = Field(
        default_factory=list,
        description="Alle im Meltdown-Zeitraum als Umbuchung erkannten Buchungen auf diesem Konto.",
    )
    contract_bookings: list[DayZeroMeltdownBookingRef] = Field(
        default_factory=list,
        description="Alle Buchungen im Zeitraum mit Vertrags-Verknüpfung (contract_id).",
    )

    konto_saldo_ist: str = Field(..., description="Neuester bekannter Bank-Saldo (Sync).")
    konto_saldo_ist_at: Optional[str] = Field(
        default=None,
        description="Zeitpunkt des letzten Saldos (ISO8601, UTC naiv wie in der DB).",
    )
    konto_saldo_ledger_day: Optional[date] = Field(
        default=None,
        description="Kalendertag des letzten Saldos in APP_TIMEZONE.",
    )
    konto_saldo_not_tagesaktuell: bool = Field(
        ...,
        description="True, wenn Ledger-Tag vor „heute“ (APP_TIMEZONE) oder kein balance_at.",
    )
    konto_saldo_start_backcalc: str = Field(
        ...,
        description=(
            "(Letzter Bank-Saldo minus alle Buchungen bis Ledger-Tag) + Regelbetrag am Tag Null + out_adj (ausgehende Umbuchungen)."
        ),
    )


class HaDayZeroAccountToday(BaseModel):
    bank_account_id: int
    name: str
    currency: str
    tag_zero_date: Optional[str] = None
    period_end_exclusive: Optional[str] = None
    today: Optional[DayZeroMeltdownDay] = None


class HaDayZeroMeltdownSnapshot(BaseModel):
    accounts: list[HaDayZeroAccountToday]

