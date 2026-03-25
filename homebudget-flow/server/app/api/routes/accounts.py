from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import desc, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import joinedload

from app.api.deps import CurrentUser
from app.db.models import (
    AccountGroupMember,
    AccountSyncState,
    BankAccount,
    BankAccountBalanceSnapshot,
    BankCredential,
)
from app.db.session import get_session
from app.schemas.balance_snapshot import BalanceSnapshotOut, BalanceSnapshotUpdate, balance_snapshot_to_out
from app.schemas.household import BankAccountOut, BankAccountUpdate, bank_account_to_out
from app.services.access import user_can_access_bank_account
from app.services.bank_account_provision import normalize_iban
from app.services.salary_cache import refresh_salary_cache_for_bank_account

router = APIRouter(prefix="/accounts", tags=["accounts"])


@router.get("", response_model=list[BankAccountOut])
async def list_my_accounts(
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
) -> list[BankAccountOut]:
    r = await session.execute(
        select(BankAccount)
        .join(AccountGroupMember, AccountGroupMember.account_group_id == BankAccount.account_group_id)
        .where(AccountGroupMember.user_id == user.id)
        .options(joinedload(BankAccount.sync_state), joinedload(BankAccount.account_group))
    )
    rows = r.unique().scalars().all()
    return [bank_account_to_out(a, a.sync_state) for a in rows]


@router.post("/{bank_account_id}/salary-cache/refresh", response_model=BankAccountOut)
async def refresh_salary_cache_for_my_bank_account(
    bank_account_id: int,
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
) -> BankAccountOut:
    """Gehalt-Cache (letztes Datum/Betrag) aus Buchungen neu berechnen."""
    if not await user_can_access_bank_account(session, user.id, bank_account_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "No access to this bank account")
    await refresh_salary_cache_for_bank_account(session, bank_account_id)
    await session.commit()
    r_acc = await session.execute(
        select(BankAccount)
        .where(BankAccount.id == bank_account_id)
        .options(joinedload(BankAccount.sync_state), joinedload(BankAccount.account_group)),
    )
    row = r_acc.unique().scalar_one()
    st_r = await session.execute(select(AccountSyncState).where(AccountSyncState.bank_account_id == row.id))
    sync = st_r.scalar_one_or_none()
    return bank_account_to_out(row, sync)


@router.get("/{bank_account_id}/balance-snapshots", response_model=list[BalanceSnapshotOut])
async def list_balance_snapshots(
    bank_account_id: int,
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
    limit: int = Query(500, ge=1, le=5000),
) -> list[BalanceSnapshotOut]:
    """Neueste Saldo-Snapshots zuerst (je erfolgreichem Sync)."""
    if not await user_can_access_bank_account(session, user.id, bank_account_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "No access to this bank account")
    r = await session.execute(
        select(BankAccountBalanceSnapshot)
        .where(BankAccountBalanceSnapshot.bank_account_id == bank_account_id)
        .order_by(desc(BankAccountBalanceSnapshot.recorded_at))
        .limit(limit)
    )
    rows = r.scalars().all()
    return [balance_snapshot_to_out(s) for s in rows]


async def _refresh_account_balance_from_latest_snapshot(session: AsyncSession, bank_account_id: int) -> None:
    """Wenn Saldo-Snapshots manuell geändert/gelöscht werden, muss `bank_accounts.balance` konsistent bleiben."""
    r_latest = await session.execute(
        select(BankAccountBalanceSnapshot)
        .where(BankAccountBalanceSnapshot.bank_account_id == bank_account_id)
        .order_by(desc(BankAccountBalanceSnapshot.recorded_at))
        .limit(1),
    )
    latest = r_latest.scalar_one_or_none()
    acc = await session.get(BankAccount, bank_account_id)
    if acc is None:
        return
    if latest is None:
        acc.balance_at = None
        return
    acc.balance = latest.balance
    acc.currency = latest.currency
    acc.balance_at = latest.recorded_at


@router.patch(
    "/{bank_account_id}/balance-snapshots/{snapshot_id}",
    response_model=BalanceSnapshotOut,
)
async def update_balance_snapshot(
    bank_account_id: int,
    snapshot_id: int,
    body: BalanceSnapshotUpdate,
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
) -> BalanceSnapshotOut:
    if not await user_can_access_bank_account(session, user.id, bank_account_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "No access to this bank account")
    row = await session.get(BankAccountBalanceSnapshot, snapshot_id)
    if row is None or row.bank_account_id != bank_account_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Balance snapshot not found")

    data = body.model_dump(exclude_unset=True)
    if "balance" in data and data["balance"] is not None:
        row.balance = data["balance"]
    if "currency" in data and data["currency"] is not None:
        row.currency = str(data["currency"]).strip().upper() or row.currency
    if "recorded_at" in data and data["recorded_at"] is not None:
        row.recorded_at = data["recorded_at"]

    await _refresh_account_balance_from_latest_snapshot(session, bank_account_id)
    await session.commit()
    await session.refresh(row)
    return balance_snapshot_to_out(row)


@router.delete(
    "/{bank_account_id}/balance-snapshots/{snapshot_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_balance_snapshot(
    bank_account_id: int,
    snapshot_id: int,
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
) -> None:
    if not await user_can_access_bank_account(session, user.id, bank_account_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "No access to this bank account")
    row = await session.get(BankAccountBalanceSnapshot, snapshot_id)
    if row is None or row.bank_account_id != bank_account_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Balance snapshot not found")
    await session.delete(row)
    await _refresh_account_balance_from_latest_snapshot(session, bank_account_id)
    await session.commit()


@router.patch("/{bank_account_id}", response_model=BankAccountOut)
async def update_my_bank_account(
    bank_account_id: int,
    body: BankAccountUpdate,
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
) -> BankAccountOut:
    if not await user_can_access_bank_account(session, user.id, bank_account_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "No access to this bank account")
    r_acc = await session.execute(
        select(BankAccount)
        .where(BankAccount.id == bank_account_id)
        .options(joinedload(BankAccount.account_group))
    )
    row = r_acc.unique().scalar_one_or_none()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Bank account not found")

    data = body.model_dump(exclude_unset=True)

    eff_provider = str(data["provider"]).strip() if data.get("provider") is not None else row.provider
    eff_iban = normalize_iban(str(data["iban"])) if data.get("iban") is not None else row.iban
    if ("provider" in data or "iban" in data) and (eff_provider, eff_iban) != (row.provider, row.iban):
        dup = await session.execute(
            select(BankAccount.id).where(
                BankAccount.provider == eff_provider,
                BankAccount.iban == eff_iban,
                BankAccount.id != row.id,
            )
        )
        if dup.scalar_one_or_none() is not None:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Ein anderes Konto nutzt bereits dieselbe Kombination aus Provider und IBAN.",
            )

    if "name" in data and data["name"] is not None:
        v = str(data["name"]).strip()
        if not v:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "name darf nicht leer sein.")
        row.name = v
    if "iban" in data:
        if data["iban"] is None or str(data["iban"]).strip() == "":
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "IBAN darf nicht leer sein.")
        iban_norm = normalize_iban(str(data["iban"]))
        if len(iban_norm) < 15:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Ungültige IBAN.")
        row.iban = iban_norm
    if "currency" in data and data["currency"] is not None:
        row.currency = str(data["currency"]).strip().upper()
    if "provider" in data and data["provider"] is not None:
        row.provider = str(data["provider"]).strip()

    if "credential_id" in data:
        cid = data["credential_id"]
        if cid is None:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "FinTS-Zugang ist Pflicht und kann nicht entfernt werden.",
            )
        cr = await session.get(BankCredential, cid)
        if cr is None or cr.user_id != user.id:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                "Ungültiger FinTS-Zugang (nicht dein gespeicherter Zugang).",
            )
        row.credential_id = cr.id

    try:
        await session.commit()
        await session.refresh(row)
    except IntegrityError as e:
        await session.rollback()
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Konflikt: Provider und IBAN sind bereits vergeben.",
        ) from e

    st_r = await session.execute(
        select(AccountSyncState).where(AccountSyncState.bank_account_id == row.id)
    )
    sync = st_r.scalar_one_or_none()
    return bank_account_to_out(row, sync)
