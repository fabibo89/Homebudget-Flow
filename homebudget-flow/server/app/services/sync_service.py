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
import json
import re
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import joinedload

from app.db.models import (
    AccountGroup,
    AccountSyncState,
    AccountGroupMember,
    BankAccount,
    BankAccountBalanceSnapshot,
    BankCredential,
    CategoryRule,
    SyncStatus,
    Transaction,
    TransferPair,
)
from app.services.bank.fints_runner import FintsCredentials
from app.services.bank.registry import get_connector
from app.services.bank.transaction_tan_channel import TransactionTanChannel
from app.services.bank_account_provision import normalize_iban
from app.services.category_rules import apply_category_rules_to_uncategorized
from app.services.credential_crypto import decrypt_secret
from app.app_time import app_today
from app.schemas.category_rule_conditions import (
    parse_conditions_json,
    rule_effective_conditions,
    transaction_matches_conditions,
)

logger = logging.getLogger(__name__)

_IBAN_RE = re.compile(r"\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b")


def _extract_iban_from_counterparty(counterparty: str | None) -> str | None:
    """FinTS liefert oft `applicant_iban` in counterparty; wir ziehen eine IBAN raus, falls vorhanden."""
    if not counterparty:
        return None
    raw = str(counterparty).replace(" ", "").upper()
    m = _IBAN_RE.search(raw)
    if not m:
        return None
    try:
        return normalize_iban(m.group(0))
    except Exception:
        return None


def _extract_iban_from_tx(tx) -> str | None:
    """Bevorzugt explizites IBAN-Feld; Fallback: Regex aus Legacy `counterparty`."""
    cp_iban = getattr(tx, "counterparty_iban", None)
    if cp_iban:
        try:
            return normalize_iban(str(cp_iban))
        except Exception:
            return None
    return _extract_iban_from_counterparty(getattr(tx, "counterparty", None))


def _raw_str(raw: object, *keys: str, max_len: int = 512) -> str | None:
    if not isinstance(raw, dict):
        return None
    for k in keys:
        v = raw.get(k)
        if v is None:
            continue
        s = str(v).strip()
        if not s:
            continue
        return s[:max_len]
    return None


def _json_default(x: object) -> str:
    # FinTS/mt940 enthält teils Datentypen (z. B. Amount/DateTime), die nicht JSON-serialisierbar sind.
    # Für Debug/Backfill reicht eine stabile String-Repräsentation.
    try:
        return str(x)
    except Exception:
        return repr(x)


def _safe_json_dumps(obj: object) -> str:
    try:
        return json.dumps(obj or {}, ensure_ascii=True, default=_json_default)
    except Exception:
        # Worst-case: niemals den Sync/Backfill am Raw scheitern lassen.
        return "{}"


def _maybe_set(obj: Transaction, attr: str, value: object) -> bool:
    """Setzt nur, wenn das Ziel-Feld aktuell leer ist."""
    cur = getattr(obj, attr, None)
    if cur is None:
        if value is None:
            return False
        setattr(obj, attr, value)
        return True
    if isinstance(cur, str) and not cur.strip():
        if value is None:
            return False
        setattr(obj, attr, value)
        return True
    if attr == "raw_json":
        # raw_json hat Default '{}' — nur überschreiben, wenn noch "leer".
        if isinstance(cur, str) and cur.strip() in ("{}", "") and isinstance(value, str) and value.strip():
            setattr(obj, attr, value)
            return True
    return False


async def backfill_missing_transaction_fields_for_account(
    session: AsyncSession,
    *,
    bank_account_id: int,
    tx_tan_channel: TransactionTanChannel | None = None,
) -> dict:
    """Temporär: holt erneut alle Buchungen für ein Konto und füllt fehlende neue Spalten nach."""
    r = await session.execute(
        select(BankAccount)
        .where(BankAccount.id == bank_account_id)
        .options(joinedload(BankAccount.credential)),
    )
    acc = r.scalar_one_or_none()
    if acc is None:
        return {"bank_account_id": bank_account_id, "ok": False, "error": "account_not_found"}

    iban_norm = _iban_for_fints(acc)
    fints_cred = _fints_credentials_from_row(acc.credential)
    connector = get_connector(
        acc.provider,
        fints_credentials=fints_cred,
        tx_tan_channel=tx_tan_channel,
    )

    # Zeitraum: von ältester vorhandener Buchung bis heute. Falls keine: None (=maximal).
    from_d = await session.scalar(
        select(Transaction.booking_date)
        .where(Transaction.bank_account_id == bank_account_id)
        .order_by(Transaction.booking_date.asc())
        .limit(1),
    )

    fetched = await connector.fetch_transactions(iban_norm, from_d, app_today())
    updated = 0
    scanned = 0
    matched = 0

    for tx in fetched:
        scanned += 1
        existing = await session.scalar(
            select(Transaction).where(
                Transaction.bank_account_id == bank_account_id,
                Transaction.external_id == tx.external_id,
            )
        )
        if existing is None:
            # Fallback: falls external_id sich durch bessere Gegenpartei geändert hat, versuchen wir einen weichen Match.
            existing = await session.scalar(
                select(Transaction).where(
                    Transaction.bank_account_id == bank_account_id,
                    Transaction.booking_date == tx.booking_date,
                    Transaction.amount == tx.amount,
                    Transaction.description == tx.description,
                )
            )
        if existing is None:
            continue
        matched += 1

        any_set = False
        any_set |= _maybe_set(existing, "counterparty_name", getattr(tx, "counterparty_name", None))
        any_set |= _maybe_set(existing, "counterparty_iban", getattr(tx, "counterparty_iban", None))
        any_set |= _maybe_set(existing, "counterparty_partner_name", getattr(tx, "counterparty_partner_name", None))
        any_set |= _maybe_set(
            existing,
            "counterparty_bic",
            _raw_str(getattr(tx, "raw", None), "applicant_bic", "partner_bic", "bic", max_len=32),
        )
        any_set |= _maybe_set(existing, "raw_json", _safe_json_dumps(getattr(tx, "raw", None)))
        any_set |= _maybe_set(
            existing,
            "sepa_end_to_end_id",
            _raw_str(
                getattr(tx, "raw", None),
                "end_to_end_reference",
                "end_to_end_id",
                "end_to_end",
                "eref",
                max_len=128,
            ),
        )
        any_set |= _maybe_set(
            existing,
            "sepa_mandate_reference",
            _raw_str(getattr(tx, "raw", None), "mandate_id", "mandate_reference", "mandate", "mref", max_len=128),
        )
        any_set |= _maybe_set(
            existing,
            "sepa_creditor_id",
            _raw_str(getattr(tx, "raw", None), "creditor_id", "creditor_identifier", "creditorid", max_len=64),
        )
        any_set |= _maybe_set(
            existing,
            "bank_reference",
            _raw_str(getattr(tx, "raw", None), "bank_reference", "reference", "ref", max_len=128),
        )
        any_set |= _maybe_set(
            existing,
            "customer_reference",
            _raw_str(getattr(tx, "raw", None), "customer_reference", "kref", max_len=128),
        )
        any_set |= _maybe_set(
            existing,
            "prima_nota",
            _raw_str(getattr(tx, "raw", None), "prima_nota", "primaNota", max_len=64),
        )

        # Optional: Transfer-Target nachziehen, falls wir jetzt eine IBAN haben.
        if existing.transfer_target_bank_account_id is None:
            household_id = await session.scalar(
                select(AccountGroup.household_id).where(AccountGroup.id == acc.account_group_id),
            )
            if household_id is not None:
                iban_to_acc_id = await _household_iban_to_account_id(session, int(household_id))
                other = iban_to_acc_id.get(_extract_iban_from_tx(tx) or "")
                if other and other != acc.id:
                    existing.transfer_target_bank_account_id = other
                    any_set = True

        if any_set:
            updated += 1

    await session.commit()
    return {
        "bank_account_id": bank_account_id,
        "ok": True,
        "from_date": from_d.isoformat() if from_d else None,
        "scanned_fetched": scanned,
        "matched_existing": matched,
        "updated_rows": updated,
    }


async def backfill_missing_transaction_fields_for_user(
    session: AsyncSession,
    *,
    user_id: int,
) -> dict:
    """Temporär: Backfill für alle Konten, auf die der Nutzer Zugriff hat (ohne TAN-Dialog)."""
    r = await session.execute(
        select(BankAccount.id)
        .join(AccountGroupMember, AccountGroupMember.account_group_id == BankAccount.account_group_id)
        .where(AccountGroupMember.user_id == user_id),
    )
    acc_ids = [int(x) for (x,) in r.fetchall()]
    results: list[dict] = []
    for acc_id in acc_ids:
        try:
            results.append(
                await backfill_missing_transaction_fields_for_account(
                    session,
                    bank_account_id=acc_id,
                    tx_tan_channel=None,
                )
            )
        except Exception as e:  # noqa: BLE001
            results.append({"bank_account_id": acc_id, "ok": False, "error": repr(e)})
    return {"ok": True, "accounts": results}


async def recheck_transfer_pairs_for_user(
    session: AsyncSession,
    *,
    user_id: int,
) -> dict:
    """Temporär: prüft für alle Konten des Users Umbuchungs-Paare nach."""
    r = await session.execute(
        select(BankAccount.id, AccountGroup.household_id)
        .join(AccountGroupMember, AccountGroupMember.account_group_id == BankAccount.account_group_id)
        .join(AccountGroup, AccountGroup.id == BankAccount.account_group_id)
        .where(AccountGroupMember.user_id == user_id),
    )
    accs = [(int(aid), int(hid)) for (aid, hid) in r.fetchall() if hid is not None]

    total_candidates = 0
    total_paired_attempts = 0

    for acc_id, hid in accs:
        # Kandidaten: haben transfer_target und sind noch in keinem TransferPair.
        tx_r = await session.execute(
            select(Transaction.id)
            .where(
                Transaction.bank_account_id == acc_id,
                Transaction.transfer_target_bank_account_id.is_not(None),
                ~select(TransferPair.id)
                .where(
                    (TransferPair.out_transaction_id == Transaction.id)
                    | (TransferPair.in_transaction_id == Transaction.id),
                )
                .exists(),
            )
        )
        tx_ids = [int(x) for (x,) in tx_r.fetchall()]
        total_candidates += len(tx_ids)
        for tx_id in tx_ids:
            total_paired_attempts += 1
            await _try_pair_transfer(session, household_id=hid, tx_id=tx_id)

    await session.commit()
    return {
        "ok": True,
        "accounts": len(accs),
        "candidates": total_candidates,
        "pair_attempts": total_paired_attempts,
    }

async def _household_iban_to_account_id(session: AsyncSession, household_id: int) -> dict[str, int]:
    r = await session.execute(
        select(BankAccount.id, BankAccount.iban)
        .join(AccountGroup, AccountGroup.id == BankAccount.account_group_id)
        .where(AccountGroup.household_id == household_id)
    )
    out: dict[str, int] = {}
    for acc_id, iban in r.fetchall():
        try:
            out[normalize_iban(str(iban))] = int(acc_id)
        except Exception:
            continue
    return out


async def _try_pair_transfer(
    session: AsyncSession,
    *,
    household_id: int,
    tx_id: int,
) -> None:
    """Versucht, eine neue (oder gerade eingefügte) Umbuchungs-Buchung mit der Gegenbuchung zu paaren."""
    tx = await session.get(Transaction, tx_id)
    if tx is None:
        return
    other_acc_id = tx.transfer_target_bank_account_id
    if other_acc_id is None:
        return
    # Schon gepaart?
    r_existing = await session.execute(
        select(TransferPair).where(
            (TransferPair.out_transaction_id == tx.id) | (TransferPair.in_transaction_id == tx.id)
        )
    )
    if r_existing.scalar_one_or_none() is not None:
        return

    # Kandidaten: Zielkonto aus transfer_target, Betrag exakt gegenläufig, gleiche Währung, Datum ±2 Tage.
    # Wichtig: Für eingehende Buchung fehlt die Sender-IBAN oft. Daher ist transfer_target auf der Ausgangsbuchung
    # der Trigger; die Gegenbuchung wird über Betrag/Datum gefunden.
    start = tx.booking_date - timedelta(days=2)
    end = tx.booking_date + timedelta(days=2)
    want_amount = Decimal("0") - (tx.amount or Decimal("0"))

    cand_q = (
        select(Transaction)
        .where(
            Transaction.bank_account_id == int(other_acc_id),
            Transaction.currency == tx.currency,
            Transaction.amount == want_amount,
            Transaction.booking_date >= start,
            Transaction.booking_date <= end,
            ~select(TransferPair.id)
            .where(
                (TransferPair.out_transaction_id == Transaction.id)
                | (TransferPair.in_transaction_id == Transaction.id),
            )
            .exists(),
        )
        .order_by(Transaction.booking_date.asc(), Transaction.id.asc())
        .limit(10)
    )
    r = await session.execute(cand_q)
    cands = r.scalars().all()
    if not cands:
        return

    # Falls es mehrere Treffer gibt, wollen wir nicht raten.
    if len(cands) != 1:
        return
    other = cands[0]

    # Richtung festlegen: out = negative amount, in = positive amount
    if tx.amount < 0:
        out_tx, in_tx = tx, other
    else:
        out_tx, in_tx = other, tx
    if out_tx.amount >= 0 or in_tx.amount <= 0:
        return

    # Gegenbuchung soll ebenfalls "wissen", wohin sie gehört.
    if in_tx.transfer_target_bank_account_id is None:
        in_tx.transfer_target_bank_account_id = int(out_tx.bank_account_id)

    session.add(
        TransferPair(
            household_id=int(household_id),
            out_transaction_id=int(out_tx.id),
            in_transaction_id=int(in_tx.id),
        )
    )



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


def _mask_iban(iban: str) -> str:
    """Datenschutzfreundlich: nur Land+***+letzte 4 Zeichen loggen."""
    s = normalize_iban(iban or "")
    if not s:
        return ""
    if len(s) <= 6:
        return s
    return f"{s[:2]}***{s[-4:]}"


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
        iban_norm = _iban_for_fints(acc)
        logger.info(
            "Sync[%s] start provider=%s iban=%s",
            acc.id,
            acc.provider,
            _mask_iban(iban_norm),
        )
        fints_cred = _fints_credentials_from_row(acc.credential)
        connector = get_connector(
            acc.provider,
            fints_credentials=fints_cred,
            tx_tan_channel=tx_tan_channel,
        )

        st.balance_attempt_at = _utc_now_naive()
        await session.flush()

        try:
            prior_tx_ok = st.transactions_success_at
            if prior_tx_ok is None:
                from_d: date | None = None
            else:
                from_d = prior_tx_ok.date() - timedelta(days=1)

            st.transactions_attempt_at = _utc_now_naive()
            await session.flush()

            snap = await connector.fetch_snapshot(iban_norm, from_d, app_today())
            balance, currency = snap.balance, snap.currency
        except Exception as e:  # noqa: BLE001
            # Wichtig: auch bei Balance-Fehlschlag Umsätze-Versuch-Zeitstempel speichern,
            # damit die UI/DB konsistent signalisiert: Umsätze wurden zumindest versucht
            # (und nicht erst nach erfolgreichem Balance-Abruf).
            raise
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

        if snap.transactions_skipped:
            st.last_error = (
                "Umsätze: zusätzliche TAN (z. B. PhotoTAN). "
                "Automatischer Sync holt nur den Saldo — Umsätze bitte in der App synchronisieren."
            )
            st.status = SyncStatus.ok.value
        else:
            household_id = await session.scalar(
                select(AccountGroup.household_id).where(AccountGroup.id == acc.account_group_id),
            )
            iban_to_acc_id: dict[str, int] = {}
            if household_id is not None:
                iban_to_acc_id = await _household_iban_to_account_id(session, int(household_id))
            # Tag Null Regel vorbereiten (pro Konto: Kategorie-Regel referenzieren oder eigene Bedingungen).
            tag_zero_conds = None
            tag_zero_norm = False
            if getattr(acc, "tag_zero_rule_category_rule_id", None) is not None and household_id is not None:
                rule = await session.get(CategoryRule, int(acc.tag_zero_rule_category_rule_id))
                if rule is not None and int(rule.household_id) == int(household_id):
                    tag_zero_conds = rule_effective_conditions(rule)
                    tag_zero_norm = bool(getattr(rule, "normalize_dot_space", False))
            if tag_zero_conds is None:
                raw = getattr(acc, "tag_zero_rule_conditions_json", None)
                if raw and str(raw).strip():
                    tag_zero_conds = parse_conditions_json(str(raw))
                    tag_zero_norm = bool(getattr(acc, "tag_zero_rule_normalize_dot_space", False))
            txs = snap.transactions
            logger.info(
                "Sync[%s] received %d transactions (from=%s to=%s)",
                acc.id,
                len(txs),
                from_d.isoformat() if from_d else "all",
                app_today().isoformat(),
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
                row = Transaction(
                        bank_account_id=acc.id,
                        transfer_target_bank_account_id=(
                            lambda iban: (
                                None
                                if not iban
                                else (
                                    None
                                    if iban_to_acc_id.get(iban) == acc.id
                                    else iban_to_acc_id.get(iban)
                                )
                            )
                        )(_extract_iban_from_tx(tx)),
                        external_id=tx.external_id,
                        amount=tx.amount,
                        currency=tx.currency,
                        booking_date=tx.booking_date,
                        value_date=tx.value_date,
                        description=tx.description,
                        counterparty=tx.counterparty,
                        counterparty_name=getattr(tx, "counterparty_name", None),
                        counterparty_iban=getattr(tx, "counterparty_iban", None),
                        counterparty_partner_name=getattr(tx, "counterparty_partner_name", None),
                        counterparty_bic=_raw_str(
                            getattr(tx, "raw", None),
                            "applicant_bic",
                            "partner_bic",
                            "bic",
                            max_len=32,
                        ),
                        raw_json=_safe_json_dumps(getattr(tx, "raw", None)),
                        sepa_end_to_end_id=_raw_str(
                            getattr(tx, "raw", None),
                            "end_to_end_reference",
                            "end_to_end_id",
                            "end_to_end",
                            "eref",
                            max_len=128,
                        ),
                        sepa_mandate_reference=_raw_str(
                            getattr(tx, "raw", None),
                            "mandate_id",
                            "mandate_reference",
                            "mandate",
                            "mref",
                            max_len=128,
                        ),
                        sepa_creditor_id=_raw_str(
                            getattr(tx, "raw", None),
                            "creditor_id",
                            "creditor_identifier",
                            "creditorid",
                            max_len=64,
                        ),
                        bank_reference=_raw_str(
                            getattr(tx, "raw", None),
                            "bank_reference",
                            "reference",
                            "ref",
                            max_len=128,
                        ),
                        customer_reference=_raw_str(
                            getattr(tx, "raw", None),
                            "customer_reference",
                            "kref",
                            max_len=128,
                        ),
                        prima_nota=_raw_str(
                            getattr(tx, "raw", None),
                            "prima_nota",
                            "primaNota",
                            max_len=64,
                        ),
                )
                session.add(row)
                adopted += 1
                await session.flush()
                if household_id is not None:
                    await _try_pair_transfer(session, household_id=int(household_id), tx_id=int(row.id))
                # Tag Null: wenn Regel passt, Datum/Betrag am Konto setzen (nur nach vorne).
                if tag_zero_conds:
                    try:
                        if transaction_matches_conditions(row, tag_zero_conds, normalize_dot_space=tag_zero_norm):
                            cur_d = acc.day_zero_date
                            if cur_d is None or row.booking_date >= cur_d:
                                acc.day_zero_date = row.booking_date
                    except Exception:
                        # Matching darf Sync nicht abbrechen (z. B. kaputte Regel-Konfiguration).
                        pass
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
        logger.exception(
            "Sync[%s] failed (NotImplementedError) provider=%s iban=%s",
            acc.id,
            acc.provider,
            _mask_iban(acc.iban or ""),
        )
        st.last_error = str(e)
        st.status = SyncStatus.error.value
    except Exception as e:  # noqa: BLE001
        logger.exception(
            "Sync[%s] failed provider=%s iban=%s",
            acc.id,
            acc.provider,
            _mask_iban(acc.iban or ""),
        )
        st.last_error = repr(e)
        st.status = SyncStatus.error.value

    await session.commit()


async def sync_all_configured_accounts(session: AsyncSession) -> None:
    r = await session.execute(select(BankAccount.id))
    ids = [row[0] for row in r.all()]
    for bid in ids:
        await sync_bank_account(session, bid)
