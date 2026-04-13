"""Endpunkte für Home Assistant (User-JWT wie nach /api/auth/login)."""

from __future__ import annotations

from datetime import date, datetime
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, status
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import AccountSyncState, BankAccount
from app.services.ha_dayzero_chart import render_dayzero_saldo_png
from app.services.tag_zero_rule import bank_account_has_tag_zero_rule
from app.db.session import get_session
from app.security import decode_token
from app.schemas.dayzero_meltdown import (
    DayZeroMeltdownDay,
    HaDayZeroAccountToday,
    HaDayZeroMeltdownSnapshot,
)
from app.services.dayzero_meltdown import (
    build_ha_dayzero_derived_fields,
    compute_dayzero_meltdown_for_account,
    eligible_accounts_with_tag_zero_rule,
    ha_dayzero_pick_today_row_index,
)

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
    # Spätester erfolgreicher Saldo- oder Umsatz-Sync (max der beiden Zeitstempel).
    last_sync_at: Optional[str] = None
    last_error: Optional[str]
    # Tag Null: Datum aus Tag-Null-Regel (kein gespeicherter Betrag am Konto).
    tag_zero_date: Optional[str] = None


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
        last_sync_at: Optional[str] = None
        if sync:
            ok_times = [t for t in (sync.balance_success_at, sync.transactions_success_at) if t is not None]
            if ok_times:
                last_sync_at = _iso(max(ok_times))
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
                last_sync_at=last_sync_at,
                last_error=sync.last_error if sync else None,
                tag_zero_date=_iso_date(acc.day_zero_date),
            )
        )
    return HaSnapshot(accounts=out)


@router.get("/dayzero-meltdown", response_model=HaDayZeroMeltdownSnapshot)
async def ha_dayzero_meltdown(
    _auth: None = Depends(require_ha_user_jwt),
    session: AsyncSession = Depends(get_session),
) -> HaDayZeroMeltdownSnapshot:
    r = await session.execute(select(BankAccount))
    accounts = eligible_accounts_with_tag_zero_rule(r.scalars().all())

    out: list[HaDayZeroAccountToday] = []
    for acc in accounts:
        d0 = acc.day_zero_date
        if d0 is None:
            out.append(
                HaDayZeroAccountToday(
                    bank_account_id=acc.id,
                    name=acc.name,
                    currency=acc.currency,
                    tag_zero_date=None,
                    period_end_exclusive=None,
                    today=None,
                )
            )
            continue
        inputs, days = await compute_dayzero_meltdown_for_account(
            session,
            account=acc,
            tag_zero_date=d0,
            months=1,
        )
        idx = ha_dayzero_pick_today_row_index(days)
        today_row = days[idx] if days and idx >= 0 else None
        derived = build_ha_dayzero_derived_fields(inputs, days)
        out.append(
            HaDayZeroAccountToday(
                bank_account_id=acc.id,
                name=acc.name,
                currency=acc.currency,
                tag_zero_date=d0.isoformat(),
                period_end_exclusive=inputs.end_exclusive.isoformat(),
                today=DayZeroMeltdownDay(**today_row) if today_row else None,
                konto_ohne_fixkosten_start=derived["konto_ohne_fixkosten_start"],
                konto_ohne_fixkosten_saldo_ist=derived["konto_ohne_fixkosten_saldo_ist"],
                konto_ohne_fixkosten_saldo_soll=derived["konto_ohne_fixkosten_saldo_soll"],
                konto_ohne_fixkosten_saldo_delta_ist_minus_soll=derived[
                    "konto_ohne_fixkosten_saldo_delta_ist_minus_soll"
                ],
                konto_ohne_fixkosten_pfad_heute=derived["konto_ohne_fixkosten_pfad_heute"],
                konto_ohne_fixkosten_geld_pro_tag=derived["konto_ohne_fixkosten_geld_pro_tag"],
                chart_days=derived["chart_days"],
                chart_konto_ist=derived["chart_konto_ist"],
                chart_meltdown_line=derived["chart_meltdown_line"],
                chart_konto_linear_soll=derived["chart_konto_linear_soll"],
            )
        )
    return HaDayZeroMeltdownSnapshot(accounts=out)


@router.get("/dayzero-chart/{bank_account_id}")
async def ha_dayzero_chart_png(
    bank_account_id: int,
    _auth: None = Depends(require_ha_user_jwt),
    session: AsyncSession = Depends(get_session),
) -> Response:
    """PNG: Saldo-Diagramm (Konto Ist, Meltdown-Linie o. Fix, Soll linear) für Home Assistant."""
    acc = await session.get(BankAccount, bank_account_id)
    if acc is None or not bank_account_has_tag_zero_rule(acc):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Bank account not found or no Tag-Null rule")
    d0 = acc.day_zero_date
    if d0 is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No Tag-Null date on account")
    inputs, days = await compute_dayzero_meltdown_for_account(
        session,
        account=acc,
        tag_zero_date=d0,
        months=1,
    )
    derived = build_ha_dayzero_derived_fields(inputs, days)
    png = render_dayzero_saldo_png(
        list(derived["chart_days"]),
        list(derived["chart_konto_ist"]),
        list(derived["chart_meltdown_line"]),
        list(derived["chart_konto_linear_soll"]),
        title=f"Day Zero · {acc.name}",
    )
    return Response(content=png, media_type="image/png")
