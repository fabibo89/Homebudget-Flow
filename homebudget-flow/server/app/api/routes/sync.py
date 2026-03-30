from __future__ import annotations

import asyncio
import base64
import time
from datetime import date, datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.responses import JSONResponse

from app.api.deps import CurrentUser
from app.db.models import AccountGroupMember, AccountSyncState, BankAccount
from app.db.session import SessionLocal, get_session
from app.services.access import user_can_access_bank_account
from app.services.bank.transaction_tan_channel import (
    PendingSyncJob,
    TransactionTanChannel,
    new_job_id,
    poll_until_tan_needed_or_task_done,
    register_job,
    remove_job,
    take_job,
)
from app.services.sync_service import (
    backfill_missing_transaction_fields_for_account,
    backfill_missing_transaction_fields_for_user,
    recheck_transfer_pairs_for_user,
    sync_all_configured_accounts,
    sync_bank_account,
)

router = APIRouter(prefix="/sync", tags=["sync"])


def _iso(dt: Optional[datetime]) -> Optional[str]:
    return dt.isoformat() if dt else None


def _iso_date(d: Optional[date]) -> Optional[str]:
    return d.isoformat() if d else None


class SyncOverviewRow(BaseModel):
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


class SyncOverviewOut(BaseModel):
    accounts: list[SyncOverviewRow]


@router.get("/overview", response_model=SyncOverviewOut)
async def sync_overview_for_user(
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
) -> SyncOverviewOut:
    """Sync-Status für alle Bankkonten, auf die der Nutzer Zugriff hat (JWT, nicht HA-Token)."""
    r = await session.execute(
        select(BankAccount, AccountSyncState)
        .join(AccountGroupMember, AccountGroupMember.account_group_id == BankAccount.account_group_id)
        .where(AccountGroupMember.user_id == user.id)
        .outerjoin(AccountSyncState, AccountSyncState.bank_account_id == BankAccount.id)
    )
    rows = r.all()
    out: list[SyncOverviewRow] = []
    for acc, sync in rows:
        out.append(
            SyncOverviewRow(
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
    return SyncOverviewOut(accounts=out)


@router.post("/accounts/{bank_account_id}", response_model=None)
async def sync_one(
    bank_account_id: int,
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
):
    """Synchronisiert ein Konto. Bei PhotoTAN für Umsätze: HTTP 202 mit Bild + ``job_id``, dann ``POST .../transaction-tan``."""
    if not await user_can_access_bank_account(session, user.id, bank_account_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "No access")

    channel = TransactionTanChannel()
    job_id = new_job_id()

    async def runner() -> None:
        async with SessionLocal() as s:
            await sync_bank_account(s, bank_account_id, tx_tan_channel=channel)

    task = asyncio.create_task(runner())
    register_job(
        PendingSyncJob(
            job_id=job_id,
            channel=channel,
            task=task,
            user_id=user.id,
            bank_account_id=bank_account_id,
            created_at=time.time(),
        )
    )

    if await poll_until_tan_needed_or_task_done(task, channel):
        remove_job(job_id)
        exc = task.exception()
        if exc is not None:
            if isinstance(exc, asyncio.CancelledError):
                raise HTTPException(status.HTTP_408_REQUEST_TIMEOUT, "Abgebrochen")
            raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, detail=repr(exc))
        return {
            "ok": True,
            "status": "completed",
            "bank_account_id": bank_account_id,
            "job_id": None,
        }

    peek = channel.peek_challenge()
    assert peek is not None
    mime, data, hint = peek
    return JSONResponse(
        status_code=status.HTTP_202_ACCEPTED,
        content={
            "status": "needs_transaction_tan",
            "job_id": job_id,
            "bank_account_id": bank_account_id,
            "challenge_mime": mime,
            "challenge_image_base64": base64.b64encode(data).decode("ascii") if data else "",
            "challenge_hint": hint or None,
        },
    )


@router.post("/accounts/{bank_account_id}/backfill-transactions")
async def backfill_transactions_one(
    bank_account_id: int,
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
):
    """Temporär: Holt alle Buchungen erneut und füllt fehlende Detailfelder nach (ggf. mit TAN-Dialog)."""
    if not await user_can_access_bank_account(session, user.id, bank_account_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "No access")

    channel = TransactionTanChannel()
    job_id = new_job_id()

    async def runner() -> None:
        async with SessionLocal() as s:
            res = await backfill_missing_transaction_fields_for_account(
                s,
                bank_account_id=bank_account_id,
                tx_tan_channel=channel,
            )
            job = take_job(job_id, user.id)
            if job is not None:
                job.result_payload = res

    task = asyncio.create_task(runner())
    register_job(
        PendingSyncJob(
            job_id=job_id,
            channel=channel,
            task=task,
            user_id=user.id,
            bank_account_id=bank_account_id,
            created_at=time.time(),
        )
    )

    if await poll_until_tan_needed_or_task_done(task, channel):
        exc = task.exception()
        remove_job(job_id)
        if exc is not None:
            if isinstance(exc, asyncio.CancelledError):
                raise HTTPException(status.HTTP_408_REQUEST_TIMEOUT, "Abgebrochen")
            raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, detail=repr(exc))
        return {"ok": True, "status": "completed", "job_id": None, "bank_account_id": bank_account_id}

    peek = channel.peek_challenge()
    assert peek is not None
    mime, data, hint = peek
    return JSONResponse(
        status_code=status.HTTP_202_ACCEPTED,
        content={
            "status": "needs_transaction_tan",
            "job_id": job_id,
            "bank_account_id": bank_account_id,
            "challenge_mime": mime,
            "challenge_image_base64": base64.b64encode(data).decode("ascii") if data else "",
            "challenge_hint": hint or None,
        },
    )


@router.post("/backfill-transactions")
async def backfill_transactions_all(
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """Temporär: Backfill für alle Konten des Users (ohne TAN-Dialog, TAN-erforderliche Konten können fehlschlagen)."""
    return await backfill_missing_transaction_fields_for_user(session, user_id=int(user.id))


@router.post("/recheck-transfer-pairs")
async def recheck_transfer_pairs_all(
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """Temporär: prüft TransferPair-Umbuchungen für alle Konten des Users nach."""
    return await recheck_transfer_pairs_for_user(session, user_id=int(user.id))


class TransactionTanBody(BaseModel):
    tan: str = Field(..., min_length=1, max_length=64)


@router.post("/jobs/{job_id}/transaction-tan")
async def submit_transaction_tan(
    job_id: str,
    body: TransactionTanBody,
    user: CurrentUser,
) -> dict:
    job = take_job(job_id, user.id)
    if job is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Job unbekannt oder abgelaufen")
    job.channel.provide_tan(body.tan)
    try:
        await asyncio.wait_for(job.task, timeout=620.0)
    except asyncio.TimeoutError:
        job.task.cancel()
        remove_job(job_id)
        raise HTTPException(status.HTTP_504_GATEWAY_TIMEOUT, "Sync-Zeitüberschreitung nach TAN") from None
    result_extra = job.result_payload
    remove_job(job_id)
    exc = job.task.exception()
    if exc is not None:
        if isinstance(exc, asyncio.CancelledError):
            raise HTTPException(status.HTTP_408_REQUEST_TIMEOUT, "Abgebrochen")
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, detail=repr(exc))
    out: dict = {
        "ok": True,
        "status": "completed",
        "bank_account_id": job.bank_account_id,
    }
    if result_extra is not None:
        out["result"] = result_extra
    return out


@router.get("/jobs/{job_id}")
async def get_sync_job(job_id: str, user: CurrentUser) -> dict:
    """Status eines laufenden Sync-Jobs (Challenge erneut abrufen, falls nötig)."""
    job = take_job(job_id, user.id)
    if job is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Job unbekannt oder abgelaufen")

    if job.task.done():
        exc = job.task.exception()
        result_extra = job.result_payload
        remove_job(job_id)
        if exc is not None:
            if isinstance(exc, asyncio.CancelledError):
                raise HTTPException(status.HTTP_408_REQUEST_TIMEOUT, "Abgebrochen")
            raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, detail=repr(exc))
        done: dict = {"status": "completed", "bank_account_id": job.bank_account_id}
        if result_extra is not None:
            done["result"] = result_extra
        return done

    peek = job.channel.peek_challenge()
    if peek is not None:
        mime, data, hint = peek
        return {
            "status": "needs_transaction_tan",
            "job_id": job_id,
            "bank_account_id": job.bank_account_id,
            "challenge_mime": mime,
            "challenge_image_base64": base64.b64encode(data).decode("ascii") if data else "",
            "challenge_hint": hint or None,
        }
    return {"status": "running", "job_id": job_id, "bank_account_id": job.bank_account_id}


@router.post("/all")
async def sync_all(user: CurrentUser, session: AsyncSession = Depends(get_session)) -> dict:
    """Alle Konten — ohne interaktive Umsatz-TAN (Cron-Verhalten pro Konto)."""
    await sync_all_configured_accounts(session)
    return {"ok": True}
