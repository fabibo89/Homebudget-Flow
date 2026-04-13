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
    spend_excl_contract: str = Field(
        ...,
        description="Wie spend_actual, aber ohne Buchungen mit Vertrags-Verknüpfung (contract_id).",
    )
    spend_contract: str = Field(
        ...,
        description="Ausgaben nur aus Vertrags-Buchungen (Summe |negativer Beträge|, Transfers ausgeschlossen).",
    )
    #: Tagesanteil der Summe aller Vertrags-Buchungsbeträge im Zeitraum (signed, Bank-Vorzeichen); gleicher Wert jeden Tag.
    contract_net_daily_avg: str = Field(
        ...,
        description="Summe Vertrags-Nettos im Zeitraum ÷ Anzahl Kalendertage (für Saldo-Glättung und Balken).",
    )
    konto_balance_excl_contract_smooth: str = Field(
        ...,
        description=(
            "Konto-Ist-Saldo, wenn Vertragsbuchungen nicht tagesgenau wirken, sondern gleichmäßig über die Periode "
            "(Netto/Tag = contract_net_daily_avg)."
        ),
    )
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
    #: Meltdown-Start (Anzeige/Diagramm): Summe aller positiven Buchungsbeträge im Meltdown-Zeitraum (inkl. eingehender Umbuchungen).
    meltdown_start_amount: Optional[str] = Field(
        default=None,
        description=(
            "Meltdown-Startwert (Anzeige): Summe aller positiven Buchungsbeträge im Zeitraum "
            "[period_start, period_end_exclusive) — gleich ``einnahmen_summe_tag_zero_zeitraum`` (alle Einnahmen inkl. Umbuchungen)."
        ),
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
    income_bookings: list[DayZeroMeltdownBookingRef] = Field(
        default_factory=list,
        description=(
            "Zusätzliche Einnahmen im Meltdown-Zeitraum: positiver Betrag, ohne als Umbuchung erkannte Buchungen "
            "(Eingehen per Umbuchung siehe transfer_bookings). Summe i. d. R. kleiner als einnahmen_summe_tag_zero_zeitraum."
        ),
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
    konto_saldo_morgen_tag_null: str = Field(
        ...,
        description=(
            "Kontostand am Morgen des Tag-Null-Kalendertags: Sync-Saldo minus Summe aller Buchungsbeträge "
            "von tag_zero_date bis einschließlich Ledger-Tag (ohne die spätere Regel-/Kurven-Korrektur)."
        ),
    )
    einnahmen_summe_tag_zero_zeitraum: str = Field(
        ...,
        description=(
            "Summe aller positiven Buchungsbeträge im Meltdown-Zeitraum [period_start, period_end_exclusive), "
            "inkl. eingehender Umbuchungen."
        ),
    )
    vertraege_netto_summe_tag_zero_zeitraum: str = Field(
        ...,
        description=(
            "Summe der Buchungsbeträge (Bank-Vorzeichen) aller vertragsverknüpften Buchungen im Meltdown-Zeitraum "
            "[period_start, period_end_exclusive); typischerweise ≤ 0 (Belastungen)."
        ),
    )
    konto_morgen_start_inkl_einnahmen: str = Field(
        ...,
        description=(
            "konto_saldo_morgen_tag_null + einnahmen_summe_tag_zero_zeitraum + vertraege_netto_summe_tag_zero_zeitraum — "
            "„Konto · ohne Fixkosten“ für Tabellen-Spalte „Start“: Morgen-Saldo zuzüglich Einnahmen und Vertrags-Netto "
            "im Zeitraum (Belastungen mindern den Wert)."
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

