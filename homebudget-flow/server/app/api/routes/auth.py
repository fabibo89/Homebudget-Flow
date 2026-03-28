from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import CurrentUser
from app.db.models import User
from app.db.session import get_session
from app.schemas.auth import LoginIn, RegisterIn, TokenOut, UserMeOut, UserMePatch
from app.security import create_access_token, hash_password, verify_password
from app.services.user_settings import apply_user_settings_updates

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/register", response_model=TokenOut)
async def register(body: RegisterIn, session: AsyncSession = Depends(get_session)) -> TokenOut:
    exists = await session.execute(select(User).where(User.email == body.email))
    if exists.scalar_one_or_none():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Email already registered")
    user = User(
        email=body.email,
        hashed_password=hash_password(body.password),
        display_name=body.display_name or body.email.split("@")[0],
    )
    session.add(user)
    await session.commit()
    await session.refresh(user)
    token = create_access_token(user.email)
    return TokenOut(access_token=token)


@router.post("/login", response_model=TokenOut)
async def login(body: LoginIn, session: AsyncSession = Depends(get_session)) -> TokenOut:
    r = await session.execute(select(User).where(User.email == body.email))
    user = r.scalar_one_or_none()
    if user is None or not verify_password(body.password, user.hashed_password):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid credentials")
    return TokenOut(access_token=create_access_token(user.email))


@router.get("/me", response_model=UserMeOut)
async def get_me(user: CurrentUser) -> UserMeOut:
    return UserMeOut(
        id=user.id,
        email=user.email,
        display_name=user.display_name,
        all_household_transactions=user.all_household_transactions,
    )


@router.patch("/me", response_model=UserMeOut)
async def patch_me(
    body: UserMePatch,
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
) -> UserMeOut:
    updates = body.model_dump(exclude_unset=True)
    if not updates:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Keine Felder zum Aktualisieren.")
    apply_user_settings_updates(user, updates)
    await session.commit()
    await session.refresh(user)
    return UserMeOut(
        id=user.id,
        email=user.email,
        display_name=user.display_name,
        all_household_transactions=user.all_household_transactions,
    )
