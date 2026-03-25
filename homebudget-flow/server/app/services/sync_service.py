from __future__ import annotations

"""Ein Sync pro Bankkonto – Status in AccountSyncState, keine Duplikate bei Transaktionen.

Nach erfolgreichem Umsatzabruf: bei neu übernommenen Buchungen werden Zuordnungsregeln des Haushalts
automatisch auf alle noch unkategorisierten Buchungen dieses Haushalts angewendet (wie „Regeln anwenden“).

Abruflogic:
- Saldo: eigene Versuch-/Erfolgszeitstempel (``balance_*_at``); jeder erfolgreiche Abruf → Zeile in
  ``bank_account_balance_snapshots`` (Historie).
- Umsätze: eigene Versuch-/Erfolgszeitstempel (``transactions_*_at``); Zeitraum ab
  ``transactions_success_at`` (mit 1 Tag Puffer) bzw. voller Zeitraum wenn noch nie erfolgreich.
"""

import logging
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import joinedload

from app.db.models import (
    AccountGroup,
    AccountSyncState,
    BankAccount,
    BankAccountBalanceSnapshot,
    BankCredential,
    SyncStatus,
    Transaction,
)
from app.services.bank.fints_runner import FintsCredentials, SkipTransactionsForAutomationTan
from app.services.bank.registry import get_connector
from app.services.bank.transaction_tan_channel import TransactionTanChannel
from app.services.bank_account_provision import normalize_iban
from app.services.category_rules import apply_category_rules_to_uncategorized
from app.services.credential_crypto import decrypt_secret

logger = logging.getLogger(__name__)


def _utc_now_naive() -> datetime:
    """UTC-Zeitpunkt für DB-Spalten ``DateTime`` ohne ``timezone=True`` (TIMESTAMP WITHOUT TIME ZONE)."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


async def ensure_sync_state(session: AsyncSession, bank_account_id: int) -> AccountSyncState:
    r = await session.execute(select(AccountSyncState).where(AccountSyncState.bank_account_id == bank_account_id))
    st = r.scalar_one_or_none()
    if st:
        return st
    st = AccountSyncState(bank_account_id=bank_account_id, status=SyncStatus.never.value)
    session.add(st)
    await session.flush()
    return st


def _fints_credentials_from_row(row: BankCredential) -> FintsCredentials:
    """PIN aus verschlüsselter DB; leer → FINTS_PIN in fints_runner. Product-ID/TAN: FINTS_*."""
    pin_plain = ""
    if row.pin_encrypted:
        pin_plain = decrypt_secret(row.pin_encrypted)
    return FintsCredentials(
        blz=row.fints_blz,
        user=row.fints_user,
        pin=pin_plain,
        endpoint=row.fints_endpoint or "https://fints.comdirect.de/fints",
        product_id="",
        tan="",
    )


def _iban_for_fints(acc: BankAccount) -> str:
    raw = (acc.iban or "").strip()
    if not raw:
        raise RuntimeError("Bankkonto hat keine IBAN (Sync unmöglich).")
    return normalize_iban(raw)


async def sync_bank_account(
    session: AsyncSession,
    bank_account_id: int,
    tx_tan_channel: TransactionTanChannel | None = None,
) -> None:
    r = await session.execute(
        select(BankAccount)
        .where(BankAccount.id == bank_account_id)
        .options(joinedload(BankAccount.credential))
    )
    acc = r.scalar_one_or_none()
    if acc is None:
        return

    st = await ensure_sync_state(session, bank_account_id)

    if not getattr(acc.credential, "fints_verified_ok", True):
        st.status = SyncStatus.error.value
        st.last_error = (
            "FinTS-Zugang nicht verifiziert (letzte Prüfung fehlgeschlagen). "
            "Bitte unter Bankzugang (FinTS) Daten prüfen und erneut speichern."
        )
        await session.commit()
        return

    st.status = SyncStatus.running.value
    st.last_error = None
    await session.flush()

    try:
        fints_cred = _fints_credentials_from_row(acc.credential)
        connector = get_connector(
            acc.provider,
            fints_credentials=fints_cred,
            tx_tan_channel=tx_tan_channel,
        )

        st.balance_attempt_at = _utc_now_naive()
        await session.flush()

        balance, currency = await connector.fetch_balance(_iban_for_fints(acc))
        acc.balance = balance
        acc.currency = currency
        t_bal = _utc_now_naive()
        acc.balance_at = t_bal
        st.balance_success_at = t_bal
        session.add(
            BankAccountBalanceSnapshot(
                bank_account_id=acc.id,
                balance=balance,
                currency=currency,
                recorded_at=t_bal,
            )
        )

        prior_tx_ok = st.transactions_success_at
        if prior_tx_ok is None:
            from_d: date | None = None
        else:
            from_d = prior_tx_ok.date() - timedelta(days=1)

        st.transactions_attempt_at = _utc_now_naive()
        await session.flush()

        try:
            txs = await connector.fetch_transactions(_iban_for_fints(acc), from_d, date.today())
        except SkipTransactionsForAutomationTan:
            st.last_error = (
                "Umsätze: zusätzliche TAN (z. B. PhotoTAN). "
                "Automatischer Sync holt nur den Saldo — Umsätze bitte in der App synchronisieren."
            )
            st.status = SyncStatus.ok.value
        else:
            logger.info(
                "Sync[%s] received %d transactions (from=%s to=%s)",
                acc.id,
                len(txs),
                from_d.isoformat() if from_d else "all",
                date.today().isoformat(),
            )
            adopted = 0
            skipped_existing = 0
            for tx in txs:
                logger.info(
                    "Sync[%s] received tx ext=%s booking=%s amount=%s %s desc=%s",
                    acc.id,
                    tx.external_id,
                    tx.booking_date.isoformat(),
                    tx.amount,
                    tx.currency,
                    (tx.description or "").strip()[:160],
                )
                existing = await session.execute(
                    select(Transaction).where(
                        Transaction.bank_account_id == acc.id,
                        Transaction.external_id == tx.external_id,
                    )
                )
                if existing.scalar_one_or_none():
                    skipped_existing += 1
                    logger.info(
                        "Sync[%s] skipped existing tx ext=%s booking=%s amount=%s %s",
                        acc.id,
                        tx.external_id,
                        tx.booking_date.isoformat(),
                        tx.amount,
                        tx.currency,
                    )
                    continue
                session.add(
                    Transaction(
                        bank_account_id=acc.id,
                        external_id=tx.external_id,
                        amount=tx.amount,
                        currency=tx.currency,
                        booking_date=tx.booking_date,
                        value_date=tx.value_date,
                        description=tx.description,
                        counterparty=tx.counterparty,
                    )
                )
                adopted += 1
                logger.info(
                    "Sync[%s] adopted tx ext=%s booking=%s amount=%s %s",
                    acc.id,
                    tx.external_id,
                    tx.booking_date.isoformat(),
                    tx.amount,
                    tx.currency,
                )
                if st.cursor_booking_date is None or tx.booking_date > st.cursor_booking_date:
                    st.cursor_booking_date = tx.booking_date

            logger.info(
                "Sync[%s] transactions done: adopted=%d skipped_existing=%d",
                acc.id,
                adopted,
                skipped_existing,
            )
            if adopted > 0:
                await session.flush()
                household_id = await session.scalar(
                    select(AccountGroup.household_id).where(AccountGroup.id == acc.account_group_id),
                )
                if household_id is not None:
                    n_tagged = await apply_category_rules_to_uncategorized(session, int(household_id))
                    if n_tagged:
                        logger.info(
                            "Sync[%s] category rules applied: %d uncategorized transaction(s) tagged "
                            "(household=%s)",
                            acc.id,
                            n_tagged,
                            household_id,
                        )
            st.transactions_success_at = _utc_now_naive()
            st.status = SyncStatus.ok.value
    except NotImplementedError as e:
        st.last_error = str(e)
        st.status = SyncStatus.error.value
    except Exception as e:  # noqa: BLE001
        st.last_error = repr(e)
        st.status = SyncStatus.error.value

    await session.commit()


async def sync_all_configured_accounts(session: AsyncSession) -> None:
    r = await session.execute(select(BankAccount.id))
    ids = [row[0] for row in r.all()]
    for bid in ids:
        await sync_bank_account(session, bid)
