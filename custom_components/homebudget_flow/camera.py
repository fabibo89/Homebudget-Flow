"""Day-Zero-Saldo-Diagramm als PNG (serverseitig gerendert, JWT)."""

from __future__ import annotations

import logging
from typing import Any

from homeassistant.components.camera import Camera
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.entity import EntityCategory
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN
from .coordinator import HomeBudgetFlowCoordinator
from .sensor import _account_device_info

_LOGGER = logging.getLogger(__name__)

# Minimales 1×1-PNG bei Fehler (gültige Signatur).
_TINY_PNG = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06"
    b"\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01"
    b"\r\n\x2d\xb4\x00\x00\x00\x00IEND\xaeB`\x82"
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    coordinator: HomeBudgetFlowCoordinator = hass.data[DOMAIN][entry.entry_id]
    entities: list[Camera] = []
    for acc in coordinator.data.get("accounts", []):
        dz = acc.get("dayzero")
        if not dz or not dz.get("tag_zero_date"):
            continue
        aid = acc["bank_account_id"]
        name = acc.get("name") or f"Konto {aid}"
        entities.append(
            DayZeroSaldoChartCamera(
                hass,
                coordinator,
                aid,
                f"{name} Day Zero · Saldo-Diagramm",
                f"{DOMAIN}_dayzero_chart_{aid}",
            )
        )
    async_add_entities(entities)


class DayZeroSaldoChartCamera(Camera):
    """Still image: GET /api/ha/dayzero-chart/{id} mit Bearer-Token."""

    _attr_entity_category = EntityCategory.DIAGNOSTIC

    def __init__(
        self,
        hass: HomeAssistant,
        coordinator: HomeBudgetFlowCoordinator,
        bank_account_id: int,
        name: str,
        unique_id: str,
    ) -> None:
        super().__init__()
        self.hass = hass
        self.coordinator = coordinator
        self._bank_account_id = bank_account_id
        self._attr_name = name
        self._attr_unique_id = unique_id

    @property
    def device_info(self) -> dict[str, Any]:
        acc_name = None
        for a in self.coordinator.data.get("accounts", []):
            if a.get("bank_account_id") == self._bank_account_id:
                acc_name = a.get("name")
                break
        return _account_device_info(self.coordinator, self._bank_account_id, acc_name)

    async def async_camera_image(
        self, width: int | None = None, height: int | None = None
    ) -> bytes:
        session = async_get_clientsession(self.hass)
        url = f"{self.coordinator.api_url}/api/ha/dayzero-chart/{self._bank_account_id}"
        try:
            for attempt in range(2):
                token = await self.coordinator.async_bearer_token()
                async with session.get(
                    url,
                    headers={"Authorization": f"Bearer {token}"},
                    timeout=90,
                ) as resp:
                    if resp.status == 401 and attempt == 0:
                        self.coordinator.invalidate_bearer_token()
                        continue
                    if resp.status != 200:
                        _LOGGER.warning(
                            "Day-zero chart HTTP %s for account %s",
                            resp.status,
                            self._bank_account_id,
                        )
                        return _TINY_PNG
                    return await resp.read()
        except TimeoutError:
            _LOGGER.warning("Day-zero chart timeout for account %s", self._bank_account_id)
            return _TINY_PNG
        except OSError as err:
            _LOGGER.warning("Day-zero chart error for account %s: %s", self._bank_account_id, err)
            return _TINY_PNG
