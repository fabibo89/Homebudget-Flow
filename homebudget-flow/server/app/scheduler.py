from apscheduler.schedulers.asyncio import AsyncIOScheduler

from app.app_time import get_app_tz
from app.config import settings
from app.db.session import SessionLocal
from app.services.sync_service import sync_all_configured_accounts

scheduler = AsyncIOScheduler(timezone=get_app_tz())


async def _daily_sync() -> None:
    async with SessionLocal() as session:
        await sync_all_configured_accounts(session)


def setup_scheduler() -> None:
    scheduler.add_job(
        _daily_sync,
        "cron",
        hour=settings.sync_cron_hour,
        minute=settings.sync_cron_minute,
        id="daily_bank_sync",
        replace_existing=True,
    )
    scheduler.start()
