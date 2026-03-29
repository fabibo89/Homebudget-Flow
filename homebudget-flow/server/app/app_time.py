"""Kalender- und Anzeige-Logik in APP_TIMEZONE (siehe config.settings).

DB-Zeitstempel bleiben UTC (naiv); „heute“ für Sync-Umsätze und Cron bezieht sich auf den Kalendertag
in der konfigurierten Zeitzone.
"""

from __future__ import annotations

import logging
from datetime import date, datetime
from functools import lru_cache
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.config import settings

logger = logging.getLogger(__name__)


@lru_cache(maxsize=1)
def get_app_tz() -> ZoneInfo:
    try:
        return ZoneInfo(settings.app_timezone)
    except ZoneInfoNotFoundError:
        logger.warning("Unbekannte APP_TIMEZONE=%r — Fallback Europe/Berlin", settings.app_timezone)
        return ZoneInfo("Europe/Berlin")


def app_today() -> date:
    """Kalendertag in APP_TIMEZONE (z. B. Umsatzabruf „bis heute“)."""
    return datetime.now(get_app_tz()).date()
