from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import ValidationError
from sqlalchemy import desc, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import joinedload

from app.api.deps import CurrentUser
from app.db.models import (
    AccountGroup,
    AccountGroupMember,
    AccountSyncState,
    BankAccount,
    BankAccountBalanceSnapshot,
    BankCredential,
    CategoryRule,
    Transaction,
)
from app.db.session import get_session
from app.schemas.balance_snapshot import BalanceSnapshotOut, BalanceSnapshotUpdate, balance_snapshot_to_out
from app.schemas.category_rule import parse_category_rule_conditions_body
from app.schemas.household import BankAccountOut, BankAccountUpdate, bank_account_to_out
from app.schemas.tag_zero_rule import TagZeroRuleOut, TagZeroRuleUpsert
from app.services.access import user_can_access_account_group, user_can_access_bank_account
from app.services.bank_account_provision import normalize_iban
from app.services.day_zero_refresh import refresh_day_zero_for_bank_account
from app.schemas.category_rule_conditions import conditions_to_json, parse_conditions_json
from app.services.tag_zero_rule import apply_tag_zero_rule_for_account, find_tag_zero_matching_transaction
from app.services.dayzero_meltdown import (
    compute_dayzero_meltdown_for_account,
    list_contract_transactions_in_meltdown_period,
    list_income_transactions_in_meltdown_period,
    list_transfer_transactions_in_meltdown_period,
)
from app.services.sync_service import delete_transfer_mirror_transactions_for_account
from app.schemas.dayzero_meltdown import DayZeroMeltdownBookingRef, DayZeroMeltdownDay, DayZeroMeltdownOut

router = APIRouter(prefix="/accounts", tags=["accounts"])


def _day_zero_booking_ref(tx: Transaction) -> DayZeroMeltdownBookingRef:
    c = getattr(tx, "contract", None)
    return DayZeroMeltdownBookingRef(
        id=int(tx.id),
        booking_date=tx.booking_date,
        amount=str(Decimal(str(tx.amount)).quantize(Decimal("0.01"))),
        description=(tx.description or "")[:4000],
        counterparty_name=tx.counterparty_name or tx.counterparty,
        transfer_target_bank_account_id=tx.transfer_target_bank_account_id,
        contract_id=tx.contract_id,
        contract_label=c.label if c is not None else None,
    )


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


@router.post("/{bank_account_id}/day-zero/refresh", response_model=BankAccountOut)
async def refresh_day_zero_for_my_bank_account(
    bank_account_id: int,
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
) -> BankAccountOut:
    """Tag-Null-Datum aus konfigurierter Regel und Buchungen neu berechnen."""
    if not await user_can_access_bank_account(session, user.id, bank_account_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "No access to this bank account")
    await refresh_day_zero_for_bank_account(session, bank_account_id)
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


@router.get("/{bank_account_id}/tag-zero-rule", response_model=TagZeroRuleOut)
async def get_tag_zero_rule(
    bank_account_id: int,
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
) -> TagZeroRuleOut:
    if not await user_can_access_bank_account(session, user.id, bank_account_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "No access to this bank account")
    acc = await session.get(BankAccount, bank_account_id)
    if acc is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Bank account not found")

    if acc.tag_zero_rule_category_rule_id is not None:
        return TagZeroRuleOut(
            source="category_rule",
            category_rule_id=acc.tag_zero_rule_category_rule_id,
        )
    if acc.tag_zero_rule_conditions_json and acc.tag_zero_rule_conditions_json.strip():
        return TagZeroRuleOut(
            source="custom",
            category_rule_id=None,
            display_name_override=acc.tag_zero_rule_display_name_override,
            normalize_dot_space=bool(acc.tag_zero_rule_normalize_dot_space),
            conditions=[c.model_dump(mode="json") for c in parse_conditions_json(acc.tag_zero_rule_conditions_json)],
        )
    return TagZeroRuleOut(source="none")


@router.put("/{bank_account_id}/tag-zero-rule", response_model=TagZeroRuleOut)
async def upsert_tag_zero_rule(
    bank_account_id: int,
    body: TagZeroRuleUpsert,
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
) -> TagZeroRuleOut:
    if not await user_can_access_bank_account(session, user.id, bank_account_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "No access to this bank account")
    acc_r = await session.execute(
        select(BankAccount)
        .where(BankAccount.id == bank_account_id)
        .options(joinedload(BankAccount.account_group)),
    )
    acc = acc_r.unique().scalar_one_or_none()
    if acc is None or acc.account_group is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Bank account not found")
    household_id = acc.account_group.household_id

    if body.source == "none":
        acc.tag_zero_rule_category_rule_id = None
        acc.tag_zero_rule_conditions_json = None
        acc.tag_zero_rule_normalize_dot_space = False
        acc.tag_zero_rule_display_name_override = None
        # Kein Regel-Match mehr -> Tag Null zurücksetzen.
        acc.day_zero_date = None
        await session.commit()
        return TagZeroRuleOut(source="none")

    if body.source == "category_rule":
        if body.category_rule_id is None:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "category_rule_id ist erforderlich.")
        r = await session.execute(
            select(CategoryRule).where(
                CategoryRule.id == body.category_rule_id,
                CategoryRule.household_id == household_id,
            ),
        )
        rule = r.scalar_one_or_none()
        if rule is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Kategorie-Regel nicht gefunden.")
        acc.tag_zero_rule_category_rule_id = rule.id
        acc.tag_zero_rule_conditions_json = None
        acc.tag_zero_rule_normalize_dot_space = False
        acc.tag_zero_rule_display_name_override = None
        await apply_tag_zero_rule_for_account(session, account=acc, household_id=int(household_id))
        await session.commit()
        return TagZeroRuleOut(source="category_rule", category_rule_id=rule.id)

    # custom — gleiche Bedingungs-Payload wie Kategorie-Regeln
    try:
        conds = parse_category_rule_conditions_body(body)
    except ValueError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e)) from e
    except ValidationError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail=e.errors()) from e
    acc.tag_zero_rule_category_rule_id = None
    acc.tag_zero_rule_conditions_json = conditions_to_json(conds)
    acc.tag_zero_rule_normalize_dot_space = bool(body.normalize_dot_space)
    acc.tag_zero_rule_display_name_override = (body.display_name_override or "").strip()[:512] or None
    await apply_tag_zero_rule_for_account(session, account=acc, household_id=int(household_id))
    await session.commit()
    return TagZeroRuleOut(
        source="custom",
        display_name_override=acc.tag_zero_rule_display_name_override,
        normalize_dot_space=bool(acc.tag_zero_rule_normalize_dot_space),
        conditions=[c.model_dump(mode="json") for c in conds],
    )


@router.get("/{bank_account_id}/dayzero-meltdown", response_model=DayZeroMeltdownOut)
async def dayzero_meltdown_for_account(
    bank_account_id: int,
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
    months: int = Query(1, ge=1, le=3),
) -> DayZeroMeltdownOut:
    if not await user_can_access_bank_account(session, user.id, bank_account_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "No access to this bank account")
    acc_r = await session.execute(
        select(BankAccount)
        .where(BankAccount.id == bank_account_id)
        .options(joinedload(BankAccount.account_group)),
    )
    acc = acc_r.unique().scalar_one_or_none()
    if acc is None or acc.account_group is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Bank account not found")
    if acc.day_zero_date is None:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Kein Tag-Null-Datum am Konto gesetzt (Regel anlegen/ausführen).",
        )
    inputs, days = await compute_dayzero_meltdown_for_account(
        session,
        account=acc,
        tag_zero_date=acc.day_zero_date,
        months=months,
    )
    sb = inputs.konto_saldo_start_backcalc.quantize(Decimal("0.01"))
    tx_match = await find_tag_zero_matching_transaction(
        session,
        account=acc,
        household_id=int(acc.account_group.household_id),
    )
    rule_booking = None
    if tx_match is not None:
        rb = tx_match.amount.quantize(Decimal("0.01")) + inputs.outgoing_internal_transfer_adjustment
        rule_booking = str(rb.quantize(Decimal("0.01")))
    tx_transfer = await list_transfer_transactions_in_meltdown_period(
        session,
        bank_account_id=acc.id,
        start=inputs.start,
        end_exclusive=inputs.end_exclusive,
    )
    # Meltdown-Start (Anzeige) = Summe aller positiven Buchungen im Zeitraum (inkl. eingehender Umbuchungen) —
    # identisch zu ``einnahmen_summe_tag_zero_zeitraum`` (siehe DayZeroInputs).
    meltdown_start_display = str(inputs.einnahmen_summe_tag_zero_zeitraum.quantize(Decimal("0.01")))
    tx_contract = await list_contract_transactions_in_meltdown_period(
        session,
        bank_account_id=acc.id,
        start=inputs.start,
        end_exclusive=inputs.end_exclusive,
    )
    tx_income = await list_income_transactions_in_meltdown_period(
        session,
        bank_account_id=acc.id,
        start=inputs.start,
        end_exclusive=inputs.end_exclusive,
    )
    bal_at_iso = acc.balance_at.isoformat() if getattr(acc, "balance_at", None) is not None else None
    return DayZeroMeltdownOut(
        bank_account_id=acc.id,
        tag_zero_date=acc.day_zero_date,
        tag_zero_amount=str(sb),
        tag_zero_rule_booking_amount=rule_booking,
        meltdown_start_amount=meltdown_start_display,
        tag_zero_saldo_includes_rule_booking=inputs.tag_zero_balance_includes_rule_booking,
        period_start=inputs.start,
        period_end_exclusive=inputs.end_exclusive,
        currency=inputs.currency,
        days=[DayZeroMeltdownDay(**d) for d in days],
        transfer_bookings=[_day_zero_booking_ref(t) for t in tx_transfer],
        contract_bookings=[_day_zero_booking_ref(t) for t in tx_contract],
        income_bookings=[_day_zero_booking_ref(t) for t in tx_income],
        konto_saldo_ist=str(inputs.konto_saldo_ist.quantize(Decimal("0.01"))),
        konto_saldo_ist_at=bal_at_iso,
        konto_saldo_ledger_day=inputs.konto_saldo_ledger_day,
        konto_saldo_not_tagesaktuell=inputs.konto_saldo_not_tagesaktuell,
        konto_saldo_start_backcalc=str(inputs.konto_saldo_start_backcalc.quantize(Decimal("0.01"))),
        konto_saldo_morgen_tag_null=str(inputs.konto_saldo_morgen_tag_null.quantize(Decimal("0.01"))),
        einnahmen_summe_tag_zero_zeitraum=str(inputs.einnahmen_summe_tag_zero_zeitraum.quantize(Decimal("0.01"))),
        vertraege_netto_summe_tag_zero_zeitraum=str(
            inputs.vertraege_netto_summe_tag_zero_zeitraum.quantize(Decimal("0.01"))
        ),
        konto_morgen_start_inkl_einnahmen=str(inputs.konto_morgen_start_inkl_einnahmen.quantize(Decimal("0.01"))),
    )


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
        prev_credential_id = row.credential_id
        if cid is None:
            row.credential_id = None
        else:
            cr = await session.get(BankCredential, cid)
            if cr is None or cr.user_id != user.id:
                raise HTTPException(
                    status.HTTP_403_FORBIDDEN,
                    "Ungültiger FinTS-Zugang (nicht dein gespeicherter Zugang).",
                )
            row.credential_id = cr.id
        if prev_credential_id is None and row.credential_id is not None:
            await delete_transfer_mirror_transactions_for_account(session, bank_account_id=row.id)

    if "account_group_id" in data and data["account_group_id"] is not None:
        new_gid = int(data["account_group_id"])
        if new_gid != row.account_group_id:
            if row.account_group is None:
                raise HTTPException(
                    status.HTTP_500_INTERNAL_SERVER_ERROR,
                    "Interner Fehler: Kontogruppe nicht geladen.",
                )
            if not await user_can_access_account_group(session, user.id, new_gid):
                raise HTTPException(
                    status.HTTP_403_FORBIDDEN,
                    "Kein Zugriff auf diese Kontogruppe.",
                )
            new_g = await session.get(AccountGroup, new_gid)
            if new_g is None:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "Kontogruppe nicht gefunden.")
            if new_g.household_id != row.account_group.household_id:
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    "Kontogruppe muss zum selben Haushalt gehören wie das Konto.",
                )
            row.account_group_id = new_gid

    try:
        await session.commit()
    except IntegrityError as e:
        await session.rollback()
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Konflikt: Provider und IBAN sind bereits vergeben.",
        ) from e

    r_out = await session.execute(
        select(BankAccount)
        .where(BankAccount.id == bank_account_id)
        .options(joinedload(BankAccount.account_group)),
    )
    row = r_out.unique().scalar_one()

    st_r = await session.execute(
        select(AccountSyncState).where(AccountSyncState.bank_account_id == row.id)
    )
    sync = st_r.scalar_one_or_none()
    return bank_account_to_out(row, sync)
