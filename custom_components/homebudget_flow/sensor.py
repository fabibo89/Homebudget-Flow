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
    coordinator = HomeBudgetFlowCoordinator(hass, entry)
    await coordinator.async_config_entry_first_refresh()

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

    async_add_entities(entities)


class HomeBudgetBalanceSensor(
    CoordinatorEntity[HomeBudgetFlowCoordinator], SensorEntity
):
    """Kontostand als Zahl (monetär, für Verlauf & Automatisierungen)."""

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
        return {
            "identifiers": {(DOMAIN, self.coordinator.entry.entry_id)},
            "name": "HomeBudget Flow",
            "manufacturer": "HomeBudget Flow",
            "model": "API",
        }


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
        return {
            "identifiers": {(DOMAIN, self.coordinator.entry.entry_id)},
            "name": "HomeBudget Flow",
            "manufacturer": "HomeBudget Flow",
            "model": "API",
        }


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
        return {
            "identifiers": {(DOMAIN, self.coordinator.entry.entry_id)},
            "name": "HomeBudget Flow",
            "manufacturer": "HomeBudget Flow",
            "model": "API",
        }


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
        return {
            "identifiers": {(DOMAIN, self.coordinator.entry.entry_id)},
            "name": "HomeBudget Flow",
            "manufacturer": "HomeBudget Flow",
            "model": "API",
        }


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
        return {
            "identifiers": {(DOMAIN, self.coordinator.entry.entry_id)},
            "name": "HomeBudget Flow",
            "manufacturer": "HomeBudget Flow",
            "model": "API",
        }
