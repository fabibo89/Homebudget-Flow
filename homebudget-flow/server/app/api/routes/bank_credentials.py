import asyncio
import base64
import logging
import time
import traceback
from typing import Any, Optional, Union

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.responses import JSONResponse

from app.api.deps import CurrentUser
from app.db.models import BankAccount, BankCredential
from app.services.bank_account_provision import ensure_bank_accounts_from_sepa_accounts
from app.db.session import SessionLocal, get_session
from app.schemas.credentials import (
    BankCredentialCreate,
    BankCredentialFintsTestBody,
    BankCredentialOut,
    BankCredentialUpdate,
    FintsSepaAccountOut,
    FintsTestResult,
)
from app.services.access import user_can_access_account_group
from app.services.bank.fints_runner import FintsCredentials, list_sepa_accounts_sync
from app.services.bank.transaction_tan_channel import (
    PendingSyncJob,
    TransactionTanChannel,
    attach_job_result,
    new_job_id,
    poll_until_tan_needed_or_task_done,
    register_job,
    remove_job,
    take_job,
)
from app.services.credential_crypto import decrypt_secret, encrypt_secret

logger = logging.getLogger(__name__)


def _integrity_chain_text(exc: IntegrityError) -> str:
    """Für Logs/Fehlermeldungen: Kette von orig/__cause__ (asyncpg, sqlite3, …)."""
    parts: list[str] = []
    cur: BaseException | None = exc
    for _ in range(10):
        if cur is None:
            break
        parts.append(str(cur))
        nxt = getattr(cur, "__cause__", None) or getattr(cur, "__context__", None)
        cur = nxt
    return " | ".join(parts)


def _integrity_has_constraint(exc: IntegrityError, *substrings: str) -> bool:
    blob = _integrity_chain_text(exc).lower()
    return any(s.lower() in blob for s in substrings)


def _log_fints_task_exc(exc: BaseException, msg: str) -> None:
    """Volle Traceback zu Background-Task-Fehlern (``logger.exception`` außerhalb ``except`` ist nutzlos)."""
    logger.error("%s: %s", msg, exc, exc_info=exc)


router = APIRouter(prefix="/bank-credentials", tags=["bank-credentials"])


def _credential_to_out(row: BankCredential, fints_log: Optional[str] = None) -> BankCredentialOut:
    return BankCredentialOut(
        id=row.id,
        user_id=row.user_id,
        provider=row.provider,
        fints_blz=row.fints_blz,
        fints_user=row.fints_user,
        fints_endpoint=row.fints_endpoint,
        has_pin=bool(row.pin_encrypted and row.pin_encrypted.strip()),
        created_at=row.created_at,
        fints_log=fints_log,
        fints_verified_ok=bool(getattr(row, "fints_verified_ok", True)),
        fints_verification_message=str(getattr(row, "fints_verification_message", "") or ""),
    )


def _fints_verification_summary(exc: BaseException) -> str:
    """Kurztext für DB/API (ohne kompletten Traceback)."""
    return f"{type(exc).__name__}: {exc}"[:4000]


def _format_fints_failure_save_log(message: str) -> str:
    return (
        "FinTS beim Speichern: fehlgeschlagen — Zugang wurde dennoch gespeichert (nicht verifiziert).\n\n"
        f"{(message or '').strip()}"
    )


def _build_fints_cred_plain(
    fints_blz: str,
    fints_user: str,
    fints_endpoint: str,
    pin_plain: str,
) -> FintsCredentials:
    ep = (fints_endpoint or "").strip() or "https://fints.comdirect.de/fints"
    return FintsCredentials(
        blz=fints_blz.strip(),
        user=fints_user.strip(),
        pin=pin_plain,
        endpoint=ep,
        product_id="",
        tan="",
    )


def _format_sepa_log_on_save(accounts: list[Any]) -> str:
    lines = ["Gefundene Konten (SEPA):"]
    for a in accounts:
        iban = str(getattr(a, "iban", "") or "")
        bic = str(getattr(a, "bic", "") or "")
        accno = str(getattr(a, "accountnumber", "") or "")
        lines.append(f"  IBAN={iban!r}  BIC={bic!r}  Konto={accno!r}")
    if not accounts:
        lines.append("  (keine)")
    return "FinTS beim Speichern: erfolgreich.\n\n" + "\n".join(lines)


def _fints_cred_from_test_body(body: BankCredentialFintsTestBody) -> FintsCredentials:
    ep = (body.fints_endpoint or "").strip() or "https://fints.comdirect.de/fints"
    return FintsCredentials(
        blz=body.fints_blz.strip(),
        user=body.fints_user.strip(),
        pin=body.pin.strip(),
        endpoint=ep,
        product_id="",
        tan="",
    )


async def _body_with_pin_from_db_if_empty(
    session: AsyncSession,
    user: CurrentUser,
    body: BankCredentialFintsTestBody,
) -> BankCredentialFintsTestBody:
    """Leeres Formular-PIN: PIN aus gespeichertem Zugang (gleicher Provider, BLZ, FinTS-User)."""
    if body.pin.strip():
        return body
    prov = (body.provider or "comdirect").strip()
    stmt = select(BankCredential).where(
        BankCredential.user_id == user.id,
        BankCredential.provider == prov,
        BankCredential.fints_blz == body.fints_blz.strip(),
        BankCredential.fints_user == body.fints_user.strip(),
    )
    r = await session.execute(stmt)
    row = r.scalar_one_or_none()
    if row is None or not (row.pin_encrypted or "").strip():
        return body
    try:
        plain = decrypt_secret(row.pin_encrypted)
    except RuntimeError as e:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(e)) from e
    if not plain.strip():
        return body
    return body.model_copy(update={"pin": plain})


def _run_fints_connectivity_test_sync(
    body: BankCredentialFintsTestBody,
    tx_tan_channel: Optional[TransactionTanChannel] = None,
) -> FintsTestResult:
    cred = _fints_cred_from_test_body(body)
    accounts = list_sepa_accounts_sync(cred, tx_tan_channel)
    lines = ["Gefundene Konten (SEPA):"]
    out_acc: list[FintsSepaAccountOut] = []
    for a in accounts:
        iban = str(getattr(a, "iban", "") or "")
        bic = str(getattr(a, "bic", "") or "")
        accno = str(getattr(a, "accountnumber", "") or "")
        lines.append(f"  IBAN={iban!r}  BIC={bic!r}  Konto={accno!r}")
        out_acc.append(FintsSepaAccountOut(iban=iban, bic=bic, accountnumber=accno))
    if not accounts:
        lines.append("  (keine)")
    log = "FinTS-Test (wie fints_test.py): erfolgreich.\n\n" + "\n".join(lines)
    return FintsTestResult(ok=True, log=log, accounts=out_acc)


@router.post("/fints-test", response_model=None)
async def fints_connectivity_test(
    body: BankCredentialFintsTestBody,
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
) -> Union[FintsTestResult, JSONResponse]:
    """Read-only: SEPA-Konten — bei PhotoTAN wie Sync: HTTP 202 + ``POST /api/sync/jobs/…/transaction-tan``."""
    if body.account_group_id is not None:
        if not await user_can_access_account_group(session, user.id, body.account_group_id):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "No access to this account group")
    resolved = await _body_with_pin_from_db_if_empty(session, user, body)
    logger.info(
        "FinTS connectivity test start user_id=%s account_group_id=%s provider=%s blz=%s fints_user=%s",
        user.id,
        resolved.account_group_id,
        resolved.provider,
        resolved.fints_blz,
        resolved.fints_user,
    )

    channel = TransactionTanChannel()
    job_id = new_job_id()

    def work() -> FintsTestResult:
        try:
            result = _run_fints_connectivity_test_sync(resolved, channel)
            logger.info("FinTS connectivity test ok user_id=%s\n%s", user.id, result.log)
            return result
        except Exception as e:  # noqa: BLE001
            log = (
                f"FinTS-Test: fehlgeschlagen.\n\n{type(e).__name__}: {e}\n\n{traceback.format_exc()}"
            )
            logger.exception("FinTS connectivity test failed user_id=%s", user.id)
            return FintsTestResult(ok=False, log=log, accounts=[])

    async def runner() -> None:
        r = await asyncio.to_thread(work)
        attach_job_result(job_id, r.model_dump())

    task = asyncio.create_task(runner())
    register_job(
        PendingSyncJob(
            job_id=job_id,
            channel=channel,
            task=task,
            user_id=user.id,
            created_at=time.time(),
            bank_account_id=None,
        )
    )

    if await poll_until_tan_needed_or_task_done(task, channel):
        j = take_job(job_id, user.id)
        payload = j.result_payload if j is not None else None
        exc = task.exception()
        remove_job(job_id)
        if exc is not None:
            if isinstance(exc, asyncio.CancelledError):
                raise HTTPException(status.HTTP_408_REQUEST_TIMEOUT, "Abgebrochen")
            raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, detail=repr(exc))
        if payload is None:
            raise HTTPException(
                status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Kein FinTS-Testergebnis nach Abschluss.",
            )
        return FintsTestResult.model_validate(payload)

    return _json_needs_fints_tan(job_id, channel)


async def _get_credential_if_access(
    session: AsyncSession,
    user: CurrentUser,
    credential_id: int,
) -> BankCredential:
    row = await session.get(BankCredential, credential_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Credential not found")
    if row.user_id != user.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "No access to this credential")
    return row


def _json_needs_fints_tan(job_id: str, channel: TransactionTanChannel) -> JSONResponse:
    peek = channel.peek_challenge()
    assert peek is not None
    mime, data, hint = peek
    return JSONResponse(
        status_code=status.HTTP_202_ACCEPTED,
        content={
            "status": "needs_transaction_tan",
            "job_id": job_id,
            "bank_account_id": None,
            "challenge_mime": mime,
            "challenge_image_base64": base64.b64encode(data).decode("ascii") if data else "",
            "challenge_hint": hint or None,
        },
    )


async def _persist_bank_credential_create(
    session: AsyncSession,
    user_id: int,
    body: BankCredentialCreate,
    accounts: list[Any],
    *,
    verified_ok: bool = True,
    verification_message: str = "",
) -> tuple[BankCredential, str]:
    pin_plain = body.pin.strip()
    try:
        enc = encrypt_secret(pin_plain)
    except RuntimeError as e:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(e)) from e
    except ValueError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e)) from e

    ver_msg = (verification_message or "")[:4000]
    fints_log = (
        _format_sepa_log_on_save(accounts)
        if verified_ok
        else _format_fints_failure_save_log(ver_msg or "Unbekannter Fehler")
    )
    row = BankCredential(
        user_id=user_id,
        provider=body.provider,
        fints_blz=body.fints_blz,
        fints_user=body.fints_user,
        fints_endpoint=body.fints_endpoint,
        pin_encrypted=enc,
        fints_verified_ok=verified_ok,
        fints_verification_message="" if verified_ok else ver_msg,
    )
    session.add(row)
    try:
        await session.flush()
    except IntegrityError as e:
        await session.rollback()
        chain = _integrity_chain_text(e)
        logger.warning(
            "bank_credentials create flush IntegrityError user_id=%s provider=%s blz=%s fints_user=%s: %s",
            user_id,
            body.provider,
            body.fints_blz,
            body.fints_user,
            chain,
        )
        if _integrity_has_constraint(e, "uq_cred_user_fints_login", "user_fints_login"):
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Es gibt bereits einen FinTS-Zugang mit dieser Kombination aus Provider, BLZ und Benutzer. "
                "Bitte den bestehenden Eintrag bearbeiten oder löschen.",
            ) from e
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"Speichern des FinTS-Zugangs fehlgeschlagen (Datenbank). Technische Info: {chain[:800]}",
        ) from e

    try:
        if verified_ok and accounts:
            await ensure_bank_accounts_from_sepa_accounts(
                session, row, accounts, body.provision_account_group_id
            )
        await session.commit()
        logger.info(
            "bank_credentials created id=%s user_id=%s provision_group=%s provider=%s verified_ok=%s",
            row.id,
            user_id,
            body.provision_account_group_id,
            body.provider,
            verified_ok,
        )
    except IntegrityError as e:
        await session.rollback()
        chain = _integrity_chain_text(e)
        logger.warning(
            "bank_credentials create commit/accounts IntegrityError user_id=%s credential_id=%s: %s",
            user_id,
            getattr(row, "id", None),
            chain,
        )
        if _integrity_has_constraint(e, "uq_bank_provider_iban", "bank_provider_iban"):
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Es gibt bereits ein Bankkonto mit derselben Kombination aus Provider und IBAN. "
                "Bitte bestehendes Konto nutzen oder in den Bankkonten-Einstellungen prüfen.",
            ) from e
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"Speichern fehlgeschlagen (Datenbank). Technische Info: {chain[:800]}",
        ) from e
    await session.refresh(row)
    return row, fints_log


async def _persist_bank_credential_update(
    session: AsyncSession,
    user: CurrentUser,
    credential_id: int,
    body: BankCredentialUpdate,
    accounts: list[Any],
    *,
    verified_ok: bool = True,
    verification_message: str = "",
) -> tuple[BankCredential, str]:
    row = await _get_credential_if_access(session, user, credential_id)
    data = body.model_dump(exclude_unset=True)

    ver_msg = (verification_message or "")[:4000]
    fints_log = (
        _format_sepa_log_on_save(accounts)
        if verified_ok
        else _format_fints_failure_save_log(ver_msg or "Unbekannter Fehler")
    )

    row.fints_verified_ok = verified_ok
    row.fints_verification_message = "" if verified_ok else ver_msg

    if "provider" in data and data["provider"] is not None:
        row.provider = str(data["provider"]).strip()
    if "fints_blz" in data and data["fints_blz"] is not None:
        v = str(data["fints_blz"]).strip()
        if not v:
            raise HTTPException(422, "fints_blz darf nicht leer sein.")
        row.fints_blz = v
    if "fints_user" in data and data["fints_user"] is not None:
        v = str(data["fints_user"]).strip()
        if not v:
            raise HTTPException(422, "fints_user darf nicht leer sein.")
        row.fints_user = v
    if "fints_endpoint" in data and data["fints_endpoint"] is not None:
        row.fints_endpoint = str(data["fints_endpoint"]).strip()

    if "pin" in data and data["pin"] is not None:
        pin_val = str(data["pin"]).strip()
        if pin_val:
            try:
                row.pin_encrypted = encrypt_secret(pin_val)
            except RuntimeError as e:
                raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(e)) from e
            except ValueError as e:
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e)) from e

    try:
        await session.flush()
    except IntegrityError as e:
        await session.rollback()
        chain = _integrity_chain_text(e)
        logger.warning("bank_credentials update flush IntegrityError id=%s user_id=%s: %s", row.id, user.id, chain)
        if _integrity_has_constraint(e, "uq_cred_user_fints_login", "user_fints_login"):
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Konflikt: Es gibt bereits einen anderen FinTS-Zugang mit dieser Kombination aus Provider, BLZ und Benutzer.",
            ) from e
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"Aktualisieren des FinTS-Zugangs fehlgeschlagen (Datenbank). Technische Info: {chain[:800]}",
        ) from e

    try:
        if verified_ok and accounts:
            provision_gid = await _provision_group_for_credential(
                session,
                user,
                row,
                data.get("provision_account_group_id"),
            )
            await ensure_bank_accounts_from_sepa_accounts(session, row, accounts, provision_gid)
        await session.commit()
        await session.refresh(row)
        logger.info("bank_credentials updated id=%s user_id=%s verified_ok=%s", row.id, user.id, verified_ok)
    except IntegrityError as e:
        await session.rollback()
        chain = _integrity_chain_text(e)
        logger.warning("bank_credentials update commit/accounts IntegrityError id=%s: %s", row.id, chain)
        if _integrity_has_constraint(e, "uq_cred_user_fints_login", "user_fints_login"):
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Konflikt: Es gibt bereits einen anderen FinTS-Zugang mit dieser Kombination aus Provider, BLZ und Benutzer.",
            ) from e
        if _integrity_has_constraint(e, "uq_bank_provider_iban", "bank_provider_iban"):
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Es gibt bereits ein Bankkonto mit derselben Kombination aus Provider und IBAN.",
            ) from e
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"Speichern fehlgeschlagen (Datenbank). Technische Info: {chain[:800]}",
        ) from e

    return row, fints_log


async def _provision_group_for_credential(
    session: AsyncSession,
    user: CurrentUser,
    row: BankCredential,
    provision_account_group_id: Optional[int],
) -> int:
    if provision_account_group_id is not None:
        if not await user_can_access_account_group(session, user.id, provision_account_group_id):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "No access to this account group")
        return provision_account_group_id
    r = await session.execute(
        select(BankAccount.account_group_id).where(BankAccount.credential_id == row.id).limit(1)
    )
    inferred = r.scalar_one_or_none()
    if inferred is not None:
        return inferred
    raise HTTPException(
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        "Bitte provision_account_group_id angeben (noch kein Bankkonto mit diesem FinTS-Zugang).",
    )


@router.post("", response_model=None)
async def create_bank_credential(
    body: BankCredentialCreate,
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
) -> Union[BankCredentialOut, JSONResponse]:
    """FinTS-Prüfung; bei PhotoTAN HTTP 202, dann ``POST /api/sync/jobs/{job_id}/transaction-tan``."""
    if not await user_can_access_account_group(session, user.id, body.provision_account_group_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "No access to this account group")

    pin_plain = body.pin.strip()
    cred = _build_fints_cred_plain(
        body.fints_blz,
        body.fints_user,
        body.fints_endpoint,
        pin_plain,
    )
    channel = TransactionTanChannel()
    job_id = new_job_id()
    user_id = user.id
    save_on_fail = body.save_on_fints_failure

    async def runner() -> None:
        try:
            accounts = await asyncio.to_thread(list_sepa_accounts_sync, cred, channel)
        except BaseException as e:
            if isinstance(e, asyncio.CancelledError):
                raise
            if not save_on_fail:
                raise
            _log_fints_task_exc(e, f"FinTS discover on create user_id={user_id} (saved unverified)")
            msg = _fints_verification_summary(e)
            async with SessionLocal() as s:
                row, flog = await _persist_bank_credential_create(
                    s, user_id, body, [], verified_ok=False, verification_message=msg
                )
            attach_job_result(job_id, _credential_to_out(row, fints_log=flog).model_dump())
            return

        if not accounts:
            if not save_on_fail:
                raise ValueError("FinTS meldet keine SEPA-Konten. Zugang nicht gespeichert.")
            async with SessionLocal() as s:
                row, flog = await _persist_bank_credential_create(
                    s,
                    user_id,
                    body,
                    [],
                    verified_ok=False,
                    verification_message="FinTS meldet keine SEPA-Konten.",
                )
            attach_job_result(job_id, _credential_to_out(row, fints_log=flog).model_dump())
            return

        async with SessionLocal() as s:
            row, flog = await _persist_bank_credential_create(
                s, user_id, body, accounts, verified_ok=True, verification_message=""
            )
        attach_job_result(job_id, _credential_to_out(row, fints_log=flog).model_dump())

    task = asyncio.create_task(runner())
    register_job(
        PendingSyncJob(
            job_id=job_id,
            channel=channel,
            task=task,
            user_id=user.id,
            created_at=time.time(),
            bank_account_id=None,
        )
    )

    if await poll_until_tan_needed_or_task_done(task, channel):
        j = take_job(job_id, user.id)
        payload = j.result_payload if j is not None else None
        exc = task.exception()
        remove_job(job_id)
        if exc is not None:
            if isinstance(exc, HTTPException):
                raise exc
            if isinstance(exc, ValueError):
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
            if isinstance(exc, RuntimeError):
                _log_fints_task_exc(exc, f"FinTS discover on create user_id={user.id} (RuntimeError)")
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
            _log_fints_task_exc(exc, f"FinTS discover on create user_id={user.id}")
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                f"FinTS-Prüfung fehlgeschlagen: {exc}",
            ) from exc
        if payload is None:
            raise HTTPException(
                status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Kein Ergebnis nach FinTS (Anlage).",
            )
        return BankCredentialOut.model_validate(payload)

    return _json_needs_fints_tan(job_id, channel)


@router.get("", response_model=list[BankCredentialOut])
async def list_my_bank_credentials(
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
) -> list[BankCredentialOut]:
    r = await session.execute(select(BankCredential).where(BankCredential.user_id == user.id))
    rows = r.scalars().all()
    return [_credential_to_out(x) for x in rows]


@router.get("/{credential_id}", response_model=BankCredentialOut)
async def get_bank_credential(
    credential_id: int,
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
) -> BankCredentialOut:
    row = await _get_credential_if_access(session, user, credential_id)
    return _credential_to_out(row)


@router.patch("/{credential_id}", response_model=None)
async def update_bank_credential(
    credential_id: int,
    body: BankCredentialUpdate,
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
) -> Union[BankCredentialOut, JSONResponse]:
    row = await _get_credential_if_access(session, user, credential_id)

    data = body.model_dump(exclude_unset=True)

    eff_blz = str(data["fints_blz"]).strip() if data.get("fints_blz") is not None else row.fints_blz
    eff_user = str(data["fints_user"]).strip() if data.get("fints_user") is not None else row.fints_user
    eff_ep = (
        str(data["fints_endpoint"]).strip()
        if data.get("fints_endpoint") is not None
        else (row.fints_endpoint or "https://fints.comdirect.de/fints")
    )
    if not eff_blz or not eff_user:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "BLZ und FinTS-Benutzer dürfen nicht leer sein.",
        )

    pin_plain = ""
    if data.get("pin") is not None and str(data["pin"]).strip():
        pin_plain = str(data["pin"]).strip()
    elif row.pin_encrypted and row.pin_encrypted.strip():
        try:
            pin_plain = decrypt_secret(row.pin_encrypted)
        except RuntimeError as e:
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(e)) from e

    cred = _build_fints_cred_plain(eff_blz, eff_user, eff_ep, pin_plain)
    channel = TransactionTanChannel()
    job_id = new_job_id()
    save_on_fail = body.save_on_fints_failure if body.save_on_fints_failure is not None else True

    async def runner() -> None:
        try:
            accounts = await asyncio.to_thread(list_sepa_accounts_sync, cred, channel)
        except BaseException as e:
            if isinstance(e, asyncio.CancelledError):
                raise
            if not save_on_fail:
                raise
            _log_fints_task_exc(e, f"FinTS discover on update id={credential_id} (saved unverified)")
            msg = _fints_verification_summary(e)
            async with SessionLocal() as s:
                row_out, flog = await _persist_bank_credential_update(
                    s, user, credential_id, body, [], verified_ok=False, verification_message=msg
                )
            attach_job_result(job_id, _credential_to_out(row_out, fints_log=flog).model_dump())
            return

        if not accounts:
            if not save_on_fail:
                raise ValueError("FinTS meldet keine SEPA-Konten. Änderungen nicht gespeichert.")
            async with SessionLocal() as s:
                row_out, flog = await _persist_bank_credential_update(
                    s,
                    user,
                    credential_id,
                    body,
                    [],
                    verified_ok=False,
                    verification_message="FinTS meldet keine SEPA-Konten.",
                )
            attach_job_result(job_id, _credential_to_out(row_out, fints_log=flog).model_dump())
            return

        async with SessionLocal() as s:
            row_out, flog = await _persist_bank_credential_update(
                s, user, credential_id, body, accounts, verified_ok=True, verification_message=""
            )
        attach_job_result(job_id, _credential_to_out(row_out, fints_log=flog).model_dump())

    task = asyncio.create_task(runner())
    register_job(
        PendingSyncJob(
            job_id=job_id,
            channel=channel,
            task=task,
            user_id=user.id,
            created_at=time.time(),
            bank_account_id=None,
        )
    )

    if await poll_until_tan_needed_or_task_done(task, channel):
        j = take_job(job_id, user.id)
        payload = j.result_payload if j is not None else None
        exc = task.exception()
        remove_job(job_id)
        if exc is not None:
            if isinstance(exc, HTTPException):
                raise exc
            if isinstance(exc, ValueError):
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
            if isinstance(exc, RuntimeError):
                _log_fints_task_exc(exc, f"FinTS discover on update id={credential_id} (RuntimeError)")
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
            _log_fints_task_exc(exc, f"FinTS discover on update id={credential_id}")
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                f"FinTS-Prüfung fehlgeschlagen: {exc}",
            ) from exc
        if payload is None:
            raise HTTPException(
                status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Kein Ergebnis nach FinTS (Update).",
            )
        return BankCredentialOut.model_validate(payload)

    return _json_needs_fints_tan(job_id, channel)


@router.delete("/{credential_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_bank_credential(
    credential_id: int,
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
) -> None:
    row = await _get_credential_if_access(session, user, credential_id)
    await session.delete(row)
    await session.commit()
