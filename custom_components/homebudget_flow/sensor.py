"""Sensoren: Kontostand, Sync-Status, Saldo-/Umsatz-Import."""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, Literal

from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntity,
    SensorStateClass,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity import EntityCategory
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import HomeBudgetFlowCoordinator


def _parse_ha_timestamp(iso: str | None) -> datetime | None:
    """ISO-Zeit aus der API → timezone-aware datetime (UTC falls ohne TZ)."""
    if not iso or not isinstance(iso, str):
        return None
    s = iso.strip()
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def _account_device_info(coordinator: HomeBudgetFlowCoordinator, bank_account_id: int, account_name: str | None) -> dict[str, Any]:
    """DeviceInfo pro Bankkonto, gruppiert mehrere Sensoren unter einem Device."""
    entry_id = coordinator.entry.entry_id
    label = (account_name or f"Konto {bank_account_id}").strip()
    return {
        "identifiers": {(DOMAIN, f"{entry_id}:{bank_account_id}")},
        "name": f"{label}",
        "manufacturer": "HomeBudget Flow",
        "model": "Bankkonto",
        # Parent-Device = Integration/ConfigEntry
        "via_device": (DOMAIN, entry_id),
    }


def _parse_balance(raw: Any) -> float | None:
    if raw is None:
        return None
    if isinstance(raw, (int, float)):
        return float(raw)
    s = str(raw).strip().replace(" ", "").replace(",", ".")
    try:
        return float(Decimal(s))
    except (InvalidOperation, ValueError):
        return None


def _parse_iso_timestamp(raw: Any) -> datetime | None:
    if raw is None or raw == "":
        return None
    s = str(raw).strip()
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _import_state(attempt_raw: Any, success_raw: Any) -> Literal["ok", "error", "unknown"]:
    """Letzter Abruf erfolgreich, wenn Erfolg nicht älter ist als der letzte Versuch."""
    attempt = _parse_iso_timestamp(attempt_raw)
    success = _parse_iso_timestamp(success_raw)
    if attempt is None and success is None:
        return "unknown"
    if success is None:
        return "error"
    if attempt is None:
        return "ok"
    return "ok" if success >= attempt else "error"


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    coordinator: HomeBudgetFlowCoordinator = hass.data[DOMAIN][entry.entry_id]

    entities: list[SensorEntity] = []
    for acc in coordinator.data.get("accounts", []):
        aid = acc["bank_account_id"]
        name = acc.get("name") or f"Konto {aid}"
        entities.append(
            HomeBudgetBalanceSensor(
                coordinator,
                aid,
                f"{name} Balance",
                f"{DOMAIN}_balance_{aid}",
            )
        )
        entities.append(
            HomeBudgetSyncSensor(
                coordinator,
                aid,
                f"{name} Sync",
                f"{DOMAIN}_sync_{aid}",
            )
        )
        entities.append(
            HomeBudgetLastSyncSensor(
                coordinator,
                aid,
                f"{name} Zuletzt synchronisiert",
                f"{DOMAIN}_last_sync_at_{aid}",
            )
        )
        entities.append(
            HomeBudgetPartImportSensor(
                coordinator,
                aid,
                f"{name} Saldo-Import",
                f"{DOMAIN}_balance_import_{aid}",
                "balance",
            )
        )
        entities.append(
            HomeBudgetPartImportSensor(
                coordinator,
                aid,
                f"{name} Umsätze-Import",
                f"{DOMAIN}_transactions_import_{aid}",
                "transactions",
            )
        )
        entities.append(
            HomeBudgetLastSalaryDateSensor(
                coordinator,
                aid,
                f"{name} Gehalt zuletzt (Datum)",
                f"{DOMAIN}_last_salary_date_{aid}",
            )
        )
        entities.append(
            HomeBudgetLastSalaryAmountSensor(
                coordinator,
                aid,
                f"{name} Gehalt zuletzt (Betrag)",
                f"{DOMAIN}_last_salary_amount_{aid}",
            )
        )
        dz = acc.get("dayzero")
        if dz and dz.get("tag_zero_date"):
            for col, suffix, label in (
                ("start", "ofix_saldo_start", "Day Zero · o. Fix · Start"),
                ("ist", "ofix_saldo_ist", "Day Zero · o. Fix · Ist"),
                ("soll", "ofix_saldo_soll", "Day Zero · o. Fix · Soll"),
                ("delta", "ofix_saldo_delta", "Day Zero · o. Fix · Ist−Soll"),
            ):
                entities.append(
                    HomeBudgetDayZeroOhneFixSaldoSensor(
                        coordinator,
                        aid,
                        f"{name} {label}",
                        f"{DOMAIN}_dayzero_{suffix}_{aid}",
                        col,
                    )
                )
            entities.append(
                HomeBudgetDayZeroGeldProTagSensor(
                    coordinator,
                    aid,
                    f"{name} Day Zero · Geld/Tag (o. Fix)",
                    f"{DOMAIN}_dayzero_geld_pro_tag_{aid}",
                )
            )

    async_add_entities(entities)


class HomeBudgetBalanceSensor(
    CoordinatorEntity[HomeBudgetFlowCoordinator], SensorEntity
):
    """Kontostand als Zahl (monetär, für Verlauf & Automatisierungen)."""

    _attr_has_entity_name = False
    _attr_device_class = SensorDeviceClass.MONETARY
    _attr_state_class = SensorStateClass.TOTAL
    _attr_suggested_display_precision = 2

    def __init__(
        self,
        coordinator: HomeBudgetFlowCoordinator,
        bank_account_id: int,
        name: str,
        unique_id: str,
    ) -> None:
        super().__init__(coordinator)
        self._bank_account_id = bank_account_id
        self._attr_unique_id = unique_id
        self._attr_name = name

    def _account(self) -> dict[str, Any] | None:
        for acc in self.coordinator.data.get("accounts", []):
            if acc.get("bank_account_id") == self._bank_account_id:
                return acc
        return None

    @property
    def native_value(self) -> float | None:
        acc = self._account()
        if not acc:
            return None
        return _parse_balance(acc.get("balance"))

    @property
    def native_unit_of_measurement(self) -> str | None:
        acc = self._account() or {}
        cur = acc.get("currency")
        if cur and str(cur).strip():
            return str(cur).strip().upper()
        return "EUR"

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        acc = self._account() or {}
        return {
            "currency": acc.get("currency"),
            "iban": acc.get("iban"),
            "bank_account_id": self._bank_account_id,
        }

    @property
    def device_info(self) -> dict[str, Any]:
        acc = self._account() or {}
        return _account_device_info(
            self.coordinator,
            self._bank_account_id,
            acc.get("name"),
        )


class HomeBudgetSyncSensor(CoordinatorEntity[HomeBudgetFlowCoordinator], SensorEntity):
    """Sync-Status."""

    _attr_entity_category = EntityCategory.DIAGNOSTIC
    _attr_has_entity_name = False

    def __init__(
        self,
        coordinator: HomeBudgetFlowCoordinator,
        bank_account_id: int,
        name: str,
        unique_id: str,
    ) -> None:
        super().__init__(coordinator)
        self._bank_account_id = bank_account_id
        self._attr_unique_id = unique_id
        self._attr_name = name

    def _account(self) -> dict[str, Any] | None:
        for acc in self.coordinator.data.get("accounts", []):
            if acc.get("bank_account_id") == self._bank_account_id:
                return acc
        return None

    @property
    def native_value(self) -> str | None:
        acc = self._account()
        if not acc:
            return None
        return str(acc.get("sync_status", "unknown"))

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        acc = self._account() or {}
        return {
            "last_error": acc.get("last_error"),
            "bank_account_id": self._bank_account_id,
        }

    @property
    def device_info(self) -> dict[str, Any]:
        acc = self._account() or {}
        return _account_device_info(
            self.coordinator,
            self._bank_account_id,
            acc.get("name"),
        )


class HomeBudgetLastSyncSensor(CoordinatorEntity[HomeBudgetFlowCoordinator], SensorEntity):
    """Zeitpunkt des letzten erfolgreichen Saldo- oder Umsatz-Syncs."""

    _attr_entity_category = EntityCategory.DIAGNOSTIC
    _attr_has_entity_name = False
    _attr_device_class = SensorDeviceClass.TIMESTAMP

    def __init__(
        self,
        coordinator: HomeBudgetFlowCoordinator,
        bank_account_id: int,
        name: str,
        unique_id: str,
    ) -> None:
        super().__init__(coordinator)
        self._bank_account_id = bank_account_id
        self._attr_unique_id = unique_id
        self._attr_name = name

    def _account(self) -> dict[str, Any] | None:
        for acc in self.coordinator.data.get("accounts", []):
            if acc.get("bank_account_id") == self._bank_account_id:
                return acc
        return None

    @property
    def native_value(self) -> datetime | None:
        acc = self._account()
        if not acc:
            return None
        return _parse_ha_timestamp(acc.get("last_sync_at"))

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        acc = self._account() or {}
        return {
            "bank_account_id": self._bank_account_id,
            "balance_success_at": acc.get("balance_success_at"),
            "transactions_success_at": acc.get("transactions_success_at"),
        }

    @property
    def device_info(self) -> dict[str, Any]:
        acc = self._account() or {}
        return _account_device_info(
            self.coordinator,
            self._bank_account_id,
            acc.get("name"),
        )


class HomeBudgetPartImportSensor(
    CoordinatorEntity[HomeBudgetFlowCoordinator], SensorEntity
):
    """Ob der letzte Saldo- bzw. Umsatz-Abruf zum letzten Versuch passt (ok / error / unknown)."""

    _attr_entity_category = EntityCategory.DIAGNOSTIC
    _attr_has_entity_name = False

    def __init__(
        self,
        coordinator: HomeBudgetFlowCoordinator,
        bank_account_id: int,
        name: str,
        unique_id: str,
        part: Literal["balance", "transactions"],
    ) -> None:
        super().__init__(coordinator)
        self._bank_account_id = bank_account_id
        self._part = part
        self._attr_unique_id = unique_id
        self._attr_name = name

    def _account(self) -> dict[str, Any] | None:
        for acc in self.coordinator.data.get("accounts", []):
            if acc.get("bank_account_id") == self._bank_account_id:
                return acc
        return None

    @property
    def native_value(self) -> str | None:
        acc = self._account()
        if not acc:
            return None
        if self._part == "balance":
            return _import_state(
                acc.get("balance_attempt_at"),
                acc.get("balance_success_at"),
            )
        return _import_state(
            acc.get("transactions_attempt_at"),
            acc.get("transactions_success_at"),
        )

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        acc = self._account() or {}
        if self._part == "balance":
            return {
                "bank_account_id": self._bank_account_id,
                "balance_attempt_at": acc.get("balance_attempt_at"),
                "balance_success_at": acc.get("balance_success_at"),
            }
        return {
            "bank_account_id": self._bank_account_id,
            "transactions_attempt_at": acc.get("transactions_attempt_at"),
            "transactions_success_at": acc.get("transactions_success_at"),
        }

    @property
    def device_info(self) -> dict[str, Any]:
        acc = self._account() or {}
        return _account_device_info(
            self.coordinator,
            self._bank_account_id,
            acc.get("name"),
        )


def _dayzero_payload(acc: dict[str, Any] | None) -> dict[str, Any]:
    if not acc:
        return {}
    raw = acc.get("dayzero")
    return raw if isinstance(raw, dict) else {}


class HomeBudgetDayZeroOhneFixSaldoSensor(
    CoordinatorEntity[HomeBudgetFlowCoordinator], SensorEntity
):
    """Saldo-Tabelle „Konto · ohne Fixkosten“: Startwert, Ist, Soll, Ist−Soll (APP-Zeitzone-Stichtag)."""

    _attr_entity_category = EntityCategory.DIAGNOSTIC
    _attr_has_entity_name = False
    _attr_device_class = SensorDeviceClass.MONETARY
    _attr_suggested_display_precision = 2

    _KEYS: dict[str, str] = {
        "start": "konto_ohne_fixkosten_start",
        "ist": "konto_ohne_fixkosten_saldo_ist",
        "soll": "konto_ohne_fixkosten_saldo_soll",
        "delta": "konto_ohne_fixkosten_saldo_delta_ist_minus_soll",
    }

    def __init__(
        self,
        coordinator: HomeBudgetFlowCoordinator,
        bank_account_id: int,
        name: str,
        unique_id: str,
        column: Literal["start", "ist", "soll", "delta"],
    ) -> None:
        super().__init__(coordinator)
        self._bank_account_id = bank_account_id
        self._attr_unique_id = unique_id
        self._attr_name = name
        self._column = column
        self._attr_state_class = (
            SensorStateClass.MEASUREMENT if column == "delta" else SensorStateClass.TOTAL
        )

    def _account(self) -> dict[str, Any] | None:
        for acc in self.coordinator.data.get("accounts", []):
            if acc.get("bank_account_id") == self._bank_account_id:
                return acc
        return None

    @property
    def native_value(self) -> float | None:
        dz = _dayzero_payload(self._account())
        return _parse_balance(dz.get(self._KEYS[self._column]))

    @property
    def native_unit_of_measurement(self) -> str | None:
        acc = self._account() or {}
        cur = acc.get("currency")
        if cur and str(cur).strip():
            return str(cur).strip().upper()
        return "EUR"

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        acc = self._account() or {}
        dz = _dayzero_payload(acc)
        base: dict[str, Any] = {
            "bank_account_id": self._bank_account_id,
            "tag_zero_date": dz.get("tag_zero_date"),
            "period_end_exclusive": dz.get("period_end_exclusive"),
            "column": self._column,
        }
        if self._column == "ist":
            base.update(
                {
                    "konto_ohne_fixkosten_pfad_heute": dz.get("konto_ohne_fixkosten_pfad_heute"),
                    "chart_days": dz.get("chart_days"),
                    "chart_konto_ist": dz.get("chart_konto_ist"),
                    "chart_meltdown_line": dz.get("chart_meltdown_line"),
                    "chart_konto_linear_soll": dz.get("chart_konto_linear_soll"),
                }
            )
        return base

    @property
    def device_info(self) -> dict[str, Any]:
        acc = self._account() or {}
        return _account_device_info(
            self.coordinator,
            self._bank_account_id,
            acc.get("name"),
        )


class HomeBudgetDayZeroGeldProTagSensor(
    CoordinatorEntity[HomeBudgetFlowCoordinator], SensorEntity
):
    """„Geld pro Tag“-Soll zur Referenzlinie ohne Fixkosten (Rest durch verbleibende Tage)."""

    _attr_entity_category = EntityCategory.DIAGNOSTIC
    _attr_has_entity_name = False
    _attr_device_class = SensorDeviceClass.MONETARY
    _attr_state_class = SensorStateClass.TOTAL
    _attr_suggested_display_precision = 2

    def __init__(
        self,
        coordinator: HomeBudgetFlowCoordinator,
        bank_account_id: int,
        name: str,
        unique_id: str,
    ) -> None:
        super().__init__(coordinator)
        self._bank_account_id = bank_account_id
        self._attr_unique_id = unique_id
        self._attr_name = name

    def _account(self) -> dict[str, Any] | None:
        for acc in self.coordinator.data.get("accounts", []):
            if acc.get("bank_account_id") == self._bank_account_id:
                return acc
        return None

    @property
    def native_value(self) -> float | None:
        dz = _dayzero_payload(self._account())
        return _parse_balance(dz.get("konto_ohne_fixkosten_geld_pro_tag"))

    @property
    def native_unit_of_measurement(self) -> str | None:
        acc = self._account() or {}
        cur = acc.get("currency")
        if cur and str(cur).strip():
            return str(cur).strip().upper()
        return "EUR"

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        acc = self._account() or {}
        dz = _dayzero_payload(acc)
        return {
            "bank_account_id": self._bank_account_id,
            "konto_ohne_fixkosten_pfad_heute": dz.get("konto_ohne_fixkosten_pfad_heute"),
            "konto_ohne_fixkosten_start": dz.get("konto_ohne_fixkosten_start"),
        }

    @property
    def device_info(self) -> dict[str, Any]:
        acc = self._account() or {}
        return _account_device_info(
            self.coordinator,
            self._bank_account_id,
            acc.get("name"),
        )


class HomeBudgetLastSalaryDateSensor(
    CoordinatorEntity[HomeBudgetFlowCoordinator], SensorEntity
):
    """Letztes Buchungsdatum einer als „Gehalt“ (Geldeingang) kategorisierten Buchung (API-Cache)."""

    _attr_entity_category = EntityCategory.DIAGNOSTIC
    _attr_has_entity_name = False

    def __init__(
        self,
        coordinator: HomeBudgetFlowCoordinator,
        bank_account_id: int,
        name: str,
        unique_id: str,
    ) -> None:
        super().__init__(coordinator)
        self._bank_account_id = bank_account_id
        self._attr_unique_id = unique_id
        self._attr_name = name

    def _account(self) -> dict[str, Any] | None:
        for acc in self.coordinator.data.get("accounts", []):
            if acc.get("bank_account_id") == self._bank_account_id:
                return acc
        return None

    @property
    def native_value(self) -> str | None:
        acc = self._account()
        if not acc:
            return None
        raw = acc.get("last_salary_booking_date")
        if raw is None or raw == "":
            return None
        return str(raw).strip()

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        return {"bank_account_id": self._bank_account_id}

    @property
    def device_info(self) -> dict[str, Any]:
        acc = self._account() or {}
        return _account_device_info(
            self.coordinator,
            self._bank_account_id,
            acc.get("name"),
        )


class HomeBudgetLastSalaryAmountSensor(
    CoordinatorEntity[HomeBudgetFlowCoordinator], SensorEntity
):
    """Betrag der zuletzt erkannten Gehalt-Buchung (API-Cache)."""

    _attr_entity_category = EntityCategory.DIAGNOSTIC
    _attr_has_entity_name = False
    _attr_device_class = SensorDeviceClass.MONETARY
    _attr_state_class = SensorStateClass.TOTAL
    _attr_suggested_display_precision = 2

    def __init__(
        self,
        coordinator: HomeBudgetFlowCoordinator,
        bank_account_id: int,
        name: str,
        unique_id: str,
    ) -> None:
        super().__init__(coordinator)
        self._bank_account_id = bank_account_id
        self._attr_unique_id = unique_id
        self._attr_name = name

    def _account(self) -> dict[str, Any] | None:
        for acc in self.coordinator.data.get("accounts", []):
            if acc.get("bank_account_id") == self._bank_account_id:
                return acc
        return None

    @property
    def native_value(self) -> float | None:
        acc = self._account()
        if not acc:
            return None
        return _parse_balance(acc.get("last_salary_amount"))

    @property
    def native_unit_of_measurement(self) -> str | None:
        acc = self._account() or {}
        cur = acc.get("currency")
        if cur and str(cur).strip():
            return str(cur).strip().upper()
        return "EUR"

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        acc = self._account() or {}
        return {
            "bank_account_id": self._bank_account_id,
            "last_salary_booking_date": acc.get("last_salary_booking_date"),
        }

    @property
    def device_info(self) -> dict[str, Any]:
        acc = self._account() or {}
        return _account_device_info(
            self.coordinator,
            self._bank_account_id,
            acc.get("name"),
        )
