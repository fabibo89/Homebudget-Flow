"""Endpunkte für Home Assistant (User-JWT wie nach /api/auth/login)."""

from __future__ import annotations

from datetime import date, datetime
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import AccountSyncState, BankAccount
from app.db.session import get_session
from app.security import decode_token

router = APIRouter(prefix="/ha", tags=["home-assistant"])


def _iso(dt: Optional[datetime]) -> Optional[str]:
    return dt.isoformat() if dt else None


def _iso_date(d: Optional[date]) -> Optional[str]:
    return d.isoformat() if d else None


class HaAccountSnapshot(BaseModel):
    bank_account_id: int
    name: str
    iban: Optional[str]
    balance: str
    currency: str
    sync_status: str
    balance_attempt_at: Optional[str]
    balance_success_at: Optional[str]
    transactions_attempt_at: Optional[str]
    transactions_success_at: Optional[str]
    last_error: Optional[str]
    last_salary_booking_date: Optional[str] = None
    last_salary_amount: Optional[str] = None


class HaSnapshot(BaseModel):
    accounts: list[HaAccountSnapshot]


async def require_ha_user_jwt(authorization: Optional[str] = Header(None)) -> None:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Missing bearer token")
    token = authorization.removeprefix("Bearer ").strip()
    if decode_token(token):
        return
    raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid token")


@router.get("/snapshot", response_model=HaSnapshot)
async def ha_snapshot(
    _auth: None = Depends(require_ha_user_jwt),
    session: AsyncSession = Depends(get_session),
) -> HaSnapshot:
    r = await session.execute(select(BankAccount))
    accounts = r.scalars().all()
    out: list[HaAccountSnapshot] = []
    for acc in accounts:
        st = await session.execute(
            select(AccountSyncState).where(AccountSyncState.bank_account_id == acc.id)
        )
        sync = st.scalar_one_or_none()
        out.append(
            HaAccountSnapshot(
                bank_account_id=acc.id,
                name=acc.name,
                iban=acc.iban,
                balance=str(acc.balance),
                currency=acc.currency,
                sync_status=sync.status if sync else "unknown",
                balance_attempt_at=_iso(sync.balance_attempt_at) if sync else None,
                balance_success_at=_iso(sync.balance_success_at) if sync else None,
                transactions_attempt_at=_iso(sync.transactions_attempt_at) if sync else None,
                transactions_success_at=_iso(sync.transactions_success_at) if sync else None,
                last_error=sync.last_error if sync else None,
                last_salary_booking_date=_iso_date(acc.last_salary_booking_date),
                last_salary_amount=(
                    str(acc.last_salary_amount) if acc.last_salary_amount is not None else None
                ),
            )
        )
    return HaSnapshot(accounts=out)
