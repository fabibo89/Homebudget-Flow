"""Config Flow und Options Flow für HomeBudget Flow."""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import voluptuous as vol
from homeassistant import config_entries
from homeassistant.const import CONF_SCAN_INTERVAL
from homeassistant.core import callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.selector import (
    NumberSelector,
    NumberSelectorConfig,
    NumberSelectorMode,
    TextSelector,
    TextSelectorConfig,
    TextSelectorType,
)

from .const import (
    CONF_API_URL,
    CONF_EMAIL,
    CONF_PASSWORD,
    CONF_SCAN_INTERVAL_SECONDS,
    DEFAULT_SCAN_INTERVAL,
    DEFAULT_SCAN_INTERVAL_SECONDS,
    DOMAIN,
    MIN_SCAN_INTERVAL_SECONDS,
)


class ApiAuthError(Exception):
    """API hat 401/403 geliefert."""


class ApiConnectError(Exception):
    """Snapshot nicht erreichbar oder ungültige Antwort."""


def _normalize_api_url(url: str) -> str:
    return url.strip().rstrip("/")


def _scan_interval_to_seconds(value: Any) -> int:
    if value is None:
        return DEFAULT_SCAN_INTERVAL_SECONDS
    if isinstance(value, timedelta):
        sec = int(value.total_seconds())
    elif isinstance(value, dict):
        sec = int(value.get("seconds", 0)) + int(value.get("minutes", 0)) * 60 + int(value.get("hours", 0)) * 3600
    else:
        return DEFAULT_SCAN_INTERVAL_SECONDS
    return max(sec, MIN_SCAN_INTERVAL_SECONDS)


def _default_scan_minutes(p: dict[str, Any]) -> int:
    try:
        return max(1, min(1440, int(p.get("scan_interval_minutes", 15))))
    except (TypeError, ValueError):
        return 15


def _user_schema(partial: dict[str, Any] | None) -> vol.Schema:
    p = partial or {}
    return vol.Schema(
        {
            vol.Required(CONF_API_URL, default=p.get(CONF_API_URL, "")): TextSelector(
                TextSelectorConfig(type=TextSelectorType.TEXT)
            ),
            vol.Required(CONF_EMAIL, default=p.get(CONF_EMAIL, "")): TextSelector(
                TextSelectorConfig(type=TextSelectorType.TEXT)
            ),
            vol.Required(CONF_PASSWORD, default=p.get(CONF_PASSWORD, "")): TextSelector(
                TextSelectorConfig(type=TextSelectorType.PASSWORD)
            ),
            vol.Optional(
                "scan_interval_minutes",
                default=_default_scan_minutes(p),
            ): NumberSelector(
                NumberSelectorConfig(
                    min=1,
                    max=1440,
                    mode=NumberSelectorMode.BOX,
                    unit_of_measurement="min",
                )
            ),
        }
    )


async def _async_validate_snapshot(hass, api_url: str, bearer: str) -> None:
    session = async_get_clientsession(hass)
    headers = {"Authorization": f"Bearer {bearer}"}
    url = _normalize_api_url(api_url)
    async with session.get(
        f"{url}/api/ha/snapshot",
        headers=headers,
        timeout=30,
    ) as resp:
        if resp.status in (401, 403):
            raise ApiAuthError
        if resp.status != 200:
            raise ApiConnectError


async def _async_login_jwt(hass, api_url: str, email: str, password: str) -> str:
    session = async_get_clientsession(hass)
    base = _normalize_api_url(api_url)
    async with session.post(
        f"{base}/api/auth/login",
        json={"email": email.strip(), "password": password},
        timeout=30,
    ) as resp:
        if resp.status in (401, 403):
            raise ApiAuthError
        if resp.status != 200:
            raise ApiConnectError
        data = await resp.json()
        token = data.get("access_token")
        if not token:
            raise ApiConnectError
        return str(token)


class HomeBudgetFlowConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Einrichtung über UI oder YAML-Import."""

    VERSION = 2

    @staticmethod
    @callback
    def async_get_options_flow(
        config_entry: config_entries.ConfigEntry,
    ) -> config_entries.OptionsFlow:
        return HomeBudgetFlowOptionsFlow()

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> config_entries.ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            email = (user_input.get(CONF_EMAIL) or "").strip()
            password = user_input.get(CONF_PASSWORD) or ""
            if not email or not password:
                errors["base"] = "missing_credentials"
            else:
                try:
                    jwt = await _async_login_jwt(
                        self.hass,
                        user_input[CONF_API_URL],
                        email,
                        password,
                    )
                    await _async_validate_snapshot(
                        self.hass, user_input[CONF_API_URL], jwt
                    )
                except ApiAuthError:
                    errors["base"] = "invalid_auth"
                except (ApiConnectError, TimeoutError, OSError):
                    errors["base"] = "cannot_connect"

            if not errors:
                await self.async_set_unique_id(_normalize_api_url(user_input[CONF_API_URL]))
                self._abort_if_unique_id_configured()
                minutes = int(user_input.get("scan_interval_minutes", 15))
                minutes = max(1, min(minutes, 1440))
                url_norm = _normalize_api_url(user_input[CONF_API_URL])
                return self.async_create_entry(
                    title="HomeBudget Flow",
                    data={
                        CONF_API_URL: url_norm,
                        CONF_EMAIL: email,
                        CONF_PASSWORD: password,
                    },
                    options={
                        CONF_SCAN_INTERVAL_SECONDS: minutes * 60,
                    },
                )

        return self.async_show_form(
            step_id="user",
            data_schema=_user_schema(user_input if errors else None),
            errors=errors,
        )

    async def async_step_import(
        self, import_config: dict[str, Any]
    ) -> config_entries.ConfigFlowResult:
        """Import aus configuration.yaml."""
        api_url = import_config.get(CONF_API_URL)
        email = (import_config.get(CONF_EMAIL) or "").strip()
        password = import_config.get(CONF_PASSWORD)
        if not api_url or not email or password is None or password == "":
            return self.async_abort(reason="import_failed")

        url_norm = _normalize_api_url(api_url)
        await self.async_set_unique_id(url_norm)
        self._abort_if_unique_id_configured()

        sec = _scan_interval_to_seconds(
            import_config.get(CONF_SCAN_INTERVAL, DEFAULT_SCAN_INTERVAL)
        )

        try:
            jwt = await _async_login_jwt(self.hass, url_norm, email, password)
            await _async_validate_snapshot(self.hass, url_norm, jwt)
        except (ApiAuthError, ApiConnectError, TimeoutError, OSError):
            return self.async_abort(reason="import_failed")

        return self.async_create_entry(
            title="HomeBudget Flow",
            data={
                CONF_API_URL: url_norm,
                CONF_EMAIL: email,
                CONF_PASSWORD: password,
            },
            options={
                CONF_SCAN_INTERVAL_SECONDS: sec,
            },
        )


class HomeBudgetFlowOptionsFlow(config_entries.OptionsFlow):
    """Intervall nachträglich ändern."""

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> config_entries.ConfigFlowResult:
        if user_input is not None:
            minutes = int(user_input["scan_interval_minutes"])
            minutes = max(1, min(minutes, 1440))
            return self.async_create_entry(
                title="",
                data={CONF_SCAN_INTERVAL_SECONDS: minutes * 60},
            )

        current_sec = self.config_entry.options.get(
            CONF_SCAN_INTERVAL_SECONDS, DEFAULT_SCAN_INTERVAL_SECONDS
        )
        try:
            current_minutes = max(1, int(current_sec) // 60)
        except (TypeError, ValueError):
            current_minutes = 15

        schema = vol.Schema(
            {
                vol.Required(
                    "scan_interval_minutes", default=current_minutes
                ): NumberSelector(
                    NumberSelectorConfig(
                        min=1,
                        max=1440,
                        mode=NumberSelectorMode.BOX,
                        unit_of_measurement="min",
                    )
                ),
            }
        )

        return self.async_show_form(step_id="init", data_schema=schema)
