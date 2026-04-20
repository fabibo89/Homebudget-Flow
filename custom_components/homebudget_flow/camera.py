"""Day-Zero-Saldo-Diagramm als JPEG (serverseitig gerendert, JWT)."""

from __future__ import annotations

import base64
import logging
from typing import Any

from aiohttp import web
from homeassistant.components.camera import Camera, async_get_still_stream
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.entity import EntityCategory
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import UpdateFailed

from .const import DOMAIN
from .coordinator import HomeBudgetFlowCoordinator
from .sensor import _account_device_info, _coordinator_account_row

_LOGGER = logging.getLogger(__name__)

# Mini-JPEG (Fehler-Fallback; MJPEG-Großansicht erwartet JPEG-Frames).
_TINY_JPEG = base64.b64decode(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwAooooA/9k="
)


def _tiny_jpeg() -> bytes:
    return _TINY_JPEG


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    coordinator: HomeBudgetFlowCoordinator = hass.data[DOMAIN][entry.entry_id]
    entities: list[Camera] = []
    for acc in coordinator.data.get("accounts", []):
        # Snapshot liefert tag_zero_date (Konto-Day-Zero); dayzero-Payload kann fehlen, Diagramm-API reicht mit Regel+Datum.
        if not acc.get("tag_zero_date"):
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
    """Still image: GET /api/ha/dayzero-chart/{id}?format=jpeg mit Bearer-Token."""

    _attr_entity_category = EntityCategory.DIAGNOSTIC
    # Großansicht = MJPEG aus Stills: nicht schneller pollen als nötig (Server rendert Matplotlib).
    _attr_frame_interval = 10.0

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
        self.content_type = "image/jpeg"
        # Letztes gültiges Diagramm: Karten-Vorschau füllt den Cache, Stream-Großansicht hat sofort Bytes (Browser-Timeout).
        self._last_chart_jpeg: bytes | None = None

    @property
    def device_info(self) -> dict[str, Any]:
        row = _coordinator_account_row(self.coordinator, self._bank_account_id)
        acc_name = row.get("name") if row else None
        return _account_device_info(self.coordinator, self._bank_account_id, acc_name)

    async def handle_async_mjpeg_stream(self, request: web.Request) -> web.StreamResponse | None:
        """Erster MJPEG-Frame sofort (Cache oder Mini-JPEG), danach HA-Standardloop.

        Ohne das kann die Großansicht leer bleiben: der Browser wartet auf den ersten
        Multipart-Frame, während async_camera_image erst vom Server kommt.
        """
        boot = self._last_chart_jpeg or _tiny_jpeg()
        primed = False

        async def image_cb() -> bytes | None:
            nonlocal primed
            if not primed:
                primed = True
                return boot
            return await self.async_camera_image()

        return await async_get_still_stream(
            request, image_cb, self.content_type, self.frame_interval
        )

    async def async_camera_image(
        self, width: int | None = None, height: int | None = None
    ) -> bytes:
        session = async_get_clientsession(self.hass)
        url = (
            f"{self.coordinator.api_url}/api/ha/dayzero-chart/"
            f"{self._bank_account_id}?format=jpeg"
        )
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
                        return _tiny_jpeg()
                    raw = await resp.read()
                    if raw.startswith(b"\xff\xd8\xff"):
                        self._last_chart_jpeg = raw
                        return raw
                    _LOGGER.warning(
                        "Day-zero chart: expected JPEG for account %s, got %s bytes",
                        self._bank_account_id,
                        len(raw),
                    )
                    return _tiny_jpeg()
        except TimeoutError:
            _LOGGER.warning("Day-zero chart timeout for account %s", self._bank_account_id)
            return _tiny_jpeg()
        except (OSError, UpdateFailed) as err:
            _LOGGER.warning("Day-zero chart error for account %s: %s", self._bank_account_id, err)
            return _tiny_jpeg()
        except Exception:
            _LOGGER.exception("Day-zero chart failed for account %s", self._bank_account_id)
            return _tiny_jpeg()
