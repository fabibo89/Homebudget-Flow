"""
Temporäre Nutzereinstellungen (GET/PATCH), parallel zu GET/PATCH /api/auth/me.
Kann später mit /auth zusammengeführt werden.
"""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import CurrentUser
from app.db.models import User
from app.db.session import get_session
from app.schemas.user_settings import UserSettingsOut, UserSettingsPatch
from app.services.user_settings import apply_user_settings_updates
from app.config import settings

router = APIRouter(prefix="/users", tags=["user-settings"])


def _to_out(user: User) -> UserSettingsOut:
    return UserSettingsOut(
        id=user.id,
        email=user.email,
        display_name=user.display_name,
        all_household_transactions=user.all_household_transactions,
        app_timezone=settings.app_timezone,
    )


@router.get("/me/settings", response_model=UserSettingsOut)
async def get_user_settings(user: CurrentUser) -> UserSettingsOut:
    return _to_out(user)


@router.patch("/me/settings", response_model=UserSettingsOut)
async def patch_user_settings(
    body: UserSettingsPatch,
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
) -> UserSettingsOut:
    updates = body.model_dump(exclude_unset=True)
    if not updates:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Keine Felder zum Aktualisieren.")
    apply_user_settings_updates(user, updates)
    await session.commit()
    await session.refresh(user)
    return _to_out(user)
