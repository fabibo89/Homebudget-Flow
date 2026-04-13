"""Datenabruf für HomeBudget Flow (Snapshot-API)."""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import time
from datetime import timedelta
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .const import (
    CONF_API_URL,
    CONF_EMAIL,
    CONF_PASSWORD,
    CONF_SCAN_INTERVAL_SECONDS,
    DEFAULT_SCAN_INTERVAL_SECONDS,
    DOMAIN,
    MIN_SCAN_INTERVAL_SECONDS,
)

_LOGGER = logging.getLogger(__name__)


def scan_interval_seconds(entry: ConfigEntry) -> int:
    """Aktualisierungsintervall aus Entry-Optionen."""
    raw = entry.options.get(CONF_SCAN_INTERVAL_SECONDS, DEFAULT_SCAN_INTERVAL_SECONDS)
    try:
        sec = int(raw)
    except (TypeError, ValueError):
        sec = DEFAULT_SCAN_INTERVAL_SECONDS
    return max(sec, MIN_SCAN_INTERVAL_SECONDS)


def _jwt_expires_at(token: str) -> float | None:
    """exp aus JWT-Payload (ohne Signaturprüfung, nur Cache)."""
    try:
        parts = token.split(".")
        if len(parts) != 3:
            return None
        pad = "=" * (-len(parts[1]) % 4)
        raw = base64.urlsafe_b64decode(parts[1] + pad)
        payload = json.loads(raw.decode("utf-8"))
        exp = payload.get("exp")
        return float(exp) if exp is not None else None
    except (ValueError, TypeError, json.JSONDecodeError, OSError):
        return None


class HomeBudgetFlowCoordinator(DataUpdateCoordinator[dict[str, Any]]):
    """Lädt /api/ha/snapshot periodisch (App-Login → JWT)."""

    def __init__(self, hass, entry: ConfigEntry) -> None:
        self.entry = entry
        self.api_url = entry.data[CONF_API_URL].rstrip("/")
        self._email = entry.data.get(CONF_EMAIL)
        self._password = entry.data.get(CONF_PASSWORD)
        self._jwt_cached: str | None = None
        self._jwt_lock = asyncio.Lock()
        interval = scan_interval_seconds(entry)
        super().__init__(
            hass,
            _LOGGER,
            name=DOMAIN,
            update_interval=timedelta(seconds=interval),
        )

    async def _async_get_bearer_token(self) -> str:
        async with self._jwt_lock:
            now = time.time()
            if self._jwt_cached:
                exp = _jwt_expires_at(self._jwt_cached)
                if exp is not None and exp > now + 60:
                    return self._jwt_cached

            if not self._email or self._password is None or self._password == "":
                raise UpdateFailed("Missing app credentials")

            session = async_get_clientsession(self.hass)
            async with session.post(
                f"{self.api_url}/api/auth/login",
                json={"email": self._email.strip(), "password": self._password},
                timeout=30,
            ) as resp:
                if resp.status != 200:
                    raise UpdateFailed(f"Login HTTP {resp.status}")
                data = await resp.json()
                token = data.get("access_token")
                if not token:
                    raise UpdateFailed("Login response missing token")
                self._jwt_cached = str(token)
                return self._jwt_cached

    async def async_bearer_token(self) -> str:
        """Gültiges JWT für zusätzliche HA-Endpunkte (z. B. Diagramm-PNG)."""
        return await self._async_get_bearer_token()

    def invalidate_bearer_token(self) -> None:
        """Nach 401 erneut einloggen (z. B. Kameraabruf)."""
        self._jwt_cached = None

    async def _async_update_data(self) -> dict[str, Any]:
        session = async_get_clientsession(self.hass)
        try:
            bearer = await self._async_get_bearer_token()
        except UpdateFailed:
            raise
        except (TimeoutError, OSError, KeyError, TypeError) as err:
            raise UpdateFailed(str(err)) from err

        headers = {"Authorization": f"Bearer {bearer}"}
        try:
            for attempt in range(2):
                async with session.get(
                    f"{self.api_url}/api/ha/snapshot",
                    headers=headers,
                    timeout=30,
                ) as resp:
                    if resp.status == 401:
                        if attempt == 0:
                            self._jwt_cached = None
                            bearer = await self._async_get_bearer_token()
                            headers = {"Authorization": f"Bearer {bearer}"}
                            continue
                        raise UpdateFailed("Unauthorized")
                    if resp.status != 200:
                        raise UpdateFailed(f"HTTP {resp.status}")
                    try:
                        snapshot = await resp.json()
                    except (ValueError, TypeError) as err:
                        raise UpdateFailed("Invalid JSON") from err

                dayzero: dict[str, Any] = {"accounts": []}
                async with session.get(
                    f"{self.api_url}/api/ha/dayzero-meltdown",
                    headers=headers,
                    timeout=60,
                ) as dz_resp:
                    if dz_resp.status == 200:
                        try:
                            dayzero = await dz_resp.json()
                        except (ValueError, TypeError):
                            dayzero = {"accounts": []}
                    elif dz_resp.status == 401:
                        if attempt == 0:
                            self._jwt_cached = None
                            bearer = await self._async_get_bearer_token()
                            headers = {"Authorization": f"Bearer {bearer}"}
                            continue
                        raise UpdateFailed("Unauthorized")

                dz_by_id = {
                    int(a["bank_account_id"]): a
                    for a in dayzero.get("accounts", [])
                    if a.get("bank_account_id") is not None
                }
                for acc in snapshot.get("accounts", []):
                    aid = acc.get("bank_account_id")
                    if aid is not None and aid in dz_by_id:
                        acc["dayzero"] = dz_by_id[aid]
                return snapshot
        except TimeoutError as err:
            raise UpdateFailed("Timeout") from err
        except OSError as err:
            raise UpdateFailed(str(err)) from err
