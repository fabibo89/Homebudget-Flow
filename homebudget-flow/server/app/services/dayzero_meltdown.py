from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
import logging
from typing import Any, Iterable, Optional

from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import joinedload

from app.app_time import app_today, get_app_tz
from app.db.models import AccountGroup, BankAccount, BankAccountBalanceSnapshot, Transaction, TransferPair
from app.services.tag_zero_rule import bank_account_has_tag_zero_rule, find_tag_zero_matching_transaction


logger = logging.getLogger(__name__)


def _bank_balance_decimal(account: BankAccount) -> Decimal:
    """Kontostand als Decimal; None/ungültig → 0 (vermeidet Decimal('None') / 500 in Meltdown & Chart)."""
    raw = getattr(account, "balance", None)
    if raw is None:
        return Decimal("0").quantize(Decimal("0.01"))
    try:
        return Decimal(str(raw)).quantize(Decimal("0.01"))
    except (ArithmeticError, InvalidOperation, ValueError, TypeError):
        return Decimal("0").quantize(Decimal("0.01"))


def _add_months(d: date, months: int) -> date:
    """Kalendermonate addieren (Tag clampen)."""
    y = d.year + (d.month - 1 + months) // 12
    m = (d.month - 1 + months) % 12 + 1
    # Clamp day to last day of target month
    if m == 12:
        last = date(y + 1, 1, 1) - timedelta(days=1)
    else:
        last = date(y, m + 1, 1) - timedelta(days=1)
    return date(y, m, min(d.day, last.day))


def _date_range(start: date, end_exclusive: date) -> list[date]:
    out: list[date] = []
    cur = start
    while cur < end_exclusive:
        out.append(cur)
        cur = cur + timedelta(days=1)
    return out


def _build_konto_eod_curve(
    days: list[date],
    konto_net_by_day: dict[date, Decimal],
    *,
    konto_opening_pre_tag_zero: Decimal,
    ledger_end: date,
    L: Decimal,
) -> dict[date, Decimal]:
    """Kumulierter Konto-Endsaldo pro Tag (gleiche Regeln wie bisher: Ledger-Grenze, erster Tag = Eröffnung)."""
    konto_eod: dict[date, Decimal] = {}
    krun = konto_opening_pre_tag_zero
    last_ld: Optional[date] = None
    if days:
        ledger_subset = [d for d in days if d <= ledger_end]
        if ledger_subset:
            last_ld = max(ledger_subset)
    for d in days:
        if d > ledger_end:
            konto_eod[d] = L
            continue
        krun = (krun + konto_net_by_day.get(d, Decimal("0"))).quantize(Decimal("0.01"))
        konto_eod[d] = krun.quantize(Decimal("0.01"))
    if days:
        konto_eod[days[0]] = konto_opening_pre_tag_zero.quantize(Decimal("0.01"))
    if last_ld is not None and last_ld != days[0]:
        konto_eod[last_ld] = L.quantize(Decimal("0.01"))
    return konto_eod


def _utc_naive_to_app_date(dt: datetime) -> date:
    """DB-Zeitstempel (naiv = UTC) → Kalendertag in APP_TIMEZONE."""
    aware = dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)
    return aware.astimezone(get_app_tz()).date()


@dataclass(frozen=True)
class DayZeroInputs:
    start: date
    end_exclusive: date
    currency: str
    start_balance: Decimal
    #: Kontostand unmittelbar nach der Tag-Null-Regel-Buchung (None → nicht ermittelbar).
    tag_zero_konto_after_rule: Optional[Decimal] = None
    #: Summe der Beträge ausgehender Umbuchungen im Meltdown-Zeitraum (negativ oder 0); in Start-Saldi eingerechnet.
    outgoing_internal_transfer_adjustment: Decimal = Decimal("0")
    #: Ob der verwendete Tag-Null-Saldo (Snapshot) die Regel-Buchung schon enthält; None = nicht aus Snapshot / unklar.
    tag_zero_balance_includes_rule_booking: Optional[bool] = None
    #: Neuester bekannter Bank-Saldo (Konto · Ist).
    konto_saldo_ist: Decimal = Decimal("0")
    #: Kalendertag des letzten Saldos in APP_TIMEZONE (aus ``balance_at``).
    konto_saldo_ledger_day: Optional[date] = None
    #: True, wenn ``konto_saldo_ledger_day`` vor „heute“ (APP_TIMEZONE) liegt oder kein ``balance_at``.
    konto_saldo_not_tagesaktuell: bool = True
    #: Kontostand am Morgen des Tag-Null-Tags: Sync-Saldo minus Summe aller Buchungen von Tag Null bis Ledger-Tag (roh, vor Regel-/Kurven-Anpassung).
    konto_saldo_morgen_tag_null: Decimal = Decimal("0")
    #: Summe positiver Buchungsbeträge im Meltdown-Zeitraum [start, end_exclusive), inkl. eingehender Umbuchungen.
    einnahmen_summe_tag_zero_zeitraum: Decimal = Decimal("0")
    #: Summe der Buchungsbeträge (Bank-Vorzeichen) aller vertragsverknüpften Buchungen im Zeitraum [start, end_exclusive).
    vertraege_netto_summe_tag_zero_zeitraum: Decimal = Decimal("0")
    #: Konto · ohne Fixkosten: Morgen-Saldo + Einnahmen + Vertrags-Netto im Zeitraum (Tabellen-Spalte Start; Vertrags-Netto typ. ≤ 0).
    konto_morgen_start_inkl_einnahmen: Decimal = Decimal("0")
    #: Eröffnung für die Konto-Ist-Kurve (Regelbetrag und Umbuchungsneutralisation wie im Saldo-Pfad).
    konto_saldo_start_backcalc: Decimal = Decimal("0")


async def _household_id_for_bank_account(session: AsyncSession, account: BankAccount) -> int:
    """Immer explizit laden — kein ``account.account_group`` (Lazy-Load bricht in Async-Kontext mit 500)."""
    ag_id = getattr(account, "account_group_id", None)
    if ag_id is None:
        raise ValueError("BankAccount ohne AccountGroup")
    ag = await session.get(AccountGroup, int(ag_id))
    if ag is None:
        raise ValueError("BankAccount ohne AccountGroup")
    return int(ag.household_id)


async def _konto_balance_after_rule_booking(
    session: AsyncSession,
    *,
    account: BankAccount,
    tag_zero_date: date,
    opening_balance: Decimal,
    txs: list[Transaction],
) -> Optional[Decimal]:
    """Saldo nach Anwendung der Regel-Buchung: Tagesanfangssaldo + Buchungen am Tag bis einschließlich Regel-Tx (Sortierung: id)."""
    hid = await _household_id_for_bank_account(session, account)
    rule_tx = await find_tag_zero_matching_transaction(session, account=account, household_id=hid)
    if rule_tx is None or rule_tx.booking_date != tag_zero_date:
        return None
    day_txs = [t for t in txs if t.booking_date == tag_zero_date]
    day_txs.sort(key=lambda t: t.id)
    cum = opening_balance
    for t in day_txs:
        cum += Decimal(str(t.amount))
        if t.id == rule_tx.id:
            out = cum.quantize(Decimal("0.01"))
            logger.info(
                "DayZero[%s] _konto_balance_after_rule_booking: tag_zero_date=%s opening_balance=%s rule_tx_id=%s "
                "rule_amount=%s result=%s via_day_scan",
                account.id,
                tag_zero_date.isoformat(),
                str(opening_balance),
                getattr(rule_tx, "id", None),
                str(getattr(rule_tx, "amount", None)),
                str(out),
            )
            return out
    out = (opening_balance + Decimal(str(rule_tx.amount))).quantize(Decimal("0.01"))
    logger.info(
        "DayZero[%s] _konto_balance_after_rule_booking: tag_zero_date=%s opening_balance=%s rule_tx_id=%s "
        "rule_amount=%s result=%s via_opening_plus_rule",
        account.id,
        tag_zero_date.isoformat(),
        str(opening_balance),
        getattr(rule_tx, "id", None),
        str(getattr(rule_tx, "amount", None)),
        str(out),
    )
    return out


async def _transfer_tx_ids_for_account(
    session: AsyncSession,
    bank_account_id: int,
    *,
    from_day: date,
    to_day_exclusive: date,
) -> set[int]:
    """IDs von Buchungen **auf diesem Konto**, die als Umbuchung gelten (Zielkonto gesetzt und/oder Paar-Leg hier).

    Nur Transaktionen mit ``bank_account_id`` = betrachtetes Konto — nicht die Gegenbuchung auf dem Partnerkonto.
    """
    r = await session.execute(
        select(Transaction.id)
        .where(
            Transaction.bank_account_id == bank_account_id,
            Transaction.booking_date >= from_day,
            Transaction.booking_date < to_day_exclusive,
            Transaction.transfer_target_bank_account_id.isnot(None),
        )
    )
    out = {int(x[0]) for x in r.all()}
    r_out_leg = await session.execute(
        select(TransferPair.out_transaction_id)
        .join(Transaction, Transaction.id == TransferPair.out_transaction_id)
        .where(
            Transaction.bank_account_id == bank_account_id,
            Transaction.booking_date >= from_day,
            Transaction.booking_date < to_day_exclusive,
        )
    )
    for (oid,) in r_out_leg.all():
        if oid is not None:
            out.add(int(oid))
    r_in_leg = await session.execute(
        select(TransferPair.in_transaction_id)
        .join(Transaction, Transaction.id == TransferPair.in_transaction_id)
        .where(
            Transaction.bank_account_id == bank_account_id,
            Transaction.booking_date >= from_day,
            Transaction.booking_date < to_day_exclusive,
        )
    )
    for (iid,) in r_in_leg.all():
        if iid is not None:
            out.add(int(iid))
    return out


async def _anchor_balance_near_start(
    session: AsyncSession,
    account: BankAccount,
    *,
    start: date,
) -> tuple[Decimal, date]:
    """Anchor-Balance als Snapshot nahe Start, sonst current balance_at.

    Rückgabe: (balance, anchor_day)
    """
    # Nimm den Snapshot mit recorded_at-Datum am nächsten zu start (±7 Tage), sonst den neuesten.
    window_from = datetime.combine(start - timedelta(days=7), datetime.min.time())
    window_to = datetime.combine(start + timedelta(days=7), datetime.max.time())
    r = await session.execute(
        select(BankAccountBalanceSnapshot)
        .where(BankAccountBalanceSnapshot.bank_account_id == account.id)
        .order_by(desc(BankAccountBalanceSnapshot.recorded_at))
        .limit(300)
    )
    rows = list(r.scalars().all())
    best: BankAccountBalanceSnapshot | None = None
    best_dist = None
    for s in rows:
        if s.recorded_at is None:
            continue
        if s.recorded_at < window_from or s.recorded_at > window_to:
            continue
        d = s.recorded_at.date()
        dist = abs((d - start).days)
        if best is None or best_dist is None or dist < best_dist:
            best = s
            best_dist = dist
            if dist == 0:
                break
    if best is None and rows:
        best = rows[0]
    if best is not None:
        try:
            bal = Decimal(str(best.balance)).quantize(Decimal("0.01"))
            return bal, best.recorded_at.date()
        except (ArithmeticError, InvalidOperation, ValueError, TypeError):
            pass
    # Fallback: aktueller Kontostand (balance) am balance_at Tag oder start
    anchor_day = account.balance_at.date() if getattr(account, "balance_at", None) else start
    return _bank_balance_decimal(account), anchor_day


async def _latest_balance_snapshot_for_day(
    session: AsyncSession,
    *,
    account: BankAccount,
    day: date,
) -> Optional[BankAccountBalanceSnapshot]:
    """Neuester (recorded_at) Snapshot exakt an ``day`` (gleicher Kalendertag), falls vorhanden."""
    day_start = datetime.combine(day, datetime.min.time())
    day_end_exclusive = datetime.combine(day + timedelta(days=1), datetime.min.time())
    r = await session.execute(
        select(BankAccountBalanceSnapshot)
        .where(BankAccountBalanceSnapshot.bank_account_id == account.id)
        .where(BankAccountBalanceSnapshot.recorded_at >= day_start)
        .where(BankAccountBalanceSnapshot.recorded_at < day_end_exclusive)
        .order_by(desc(BankAccountBalanceSnapshot.recorded_at))
        .limit(1)
    )
    row = r.scalars().first()
    return row


async def compute_dayzero_meltdown_for_account(
    session: AsyncSession,
    *,
    account: BankAccount,
    tag_zero_date: date,
    months: int = 1,
) -> tuple[DayZeroInputs, list[dict]]:
    start = tag_zero_date
    end_exclusive = _add_months(start, months)
    days = _date_range(start, end_exclusive)
    if not days:
        L0 = _bank_balance_decimal(account)
        la0 = getattr(account, "balance_at", None)
        ld0 = _utc_naive_to_app_date(la0) if la0 is not None else None
        return (
            DayZeroInputs(
                start=start,
                end_exclusive=end_exclusive,
                currency=account.currency,
                start_balance=Decimal("0"),
                tag_zero_konto_after_rule=None,
                outgoing_internal_transfer_adjustment=Decimal("0"),
                tag_zero_balance_includes_rule_booking=None,
                konto_saldo_ist=L0,
                konto_saldo_ledger_day=ld0,
                konto_saldo_not_tagesaktuell=True,
                konto_saldo_morgen_tag_null=L0,
                einnahmen_summe_tag_zero_zeitraum=Decimal("0"),
                vertraege_netto_summe_tag_zero_zeitraum=Decimal("0"),
                konto_morgen_start_inkl_einnahmen=L0,
                konto_saldo_start_backcalc=Decimal("0"),
            ),
            [],
        )

    anchor_balance, anchor_day = await _anchor_balance_near_start(session, account, start=start)

    # Alle Transaktionen für Balancerechnung: etwas Puffer um anchor/start/end.
    tx_from = min(anchor_day, start) - timedelta(days=3)
    tx_to_exclusive = end_exclusive + timedelta(days=1)
    tx_r = await session.execute(
        select(Transaction)
        .where(
            Transaction.bank_account_id == account.id,
            Transaction.booking_date >= tx_from,
            Transaction.booking_date < tx_to_exclusive,
        )
        .order_by(Transaction.booking_date.asc(), Transaction.id.asc())
    )
    txs = list(tx_r.scalars().all())

    # Tagesnetto (alle) für balances
    net_by_day: dict[date, Decimal] = {d: Decimal("0") for d in days}
    for tx in txs:
        bd = tx.booking_date
        if bd in net_by_day:
            net_by_day[bd] += Decimal(str(tx.amount))

    # Balance am start (Tagesende) aus anchor + delta vom anchor_day bis start
    def sum_net(d_from: date, d_to_inclusive: date) -> Decimal:
        if d_from == d_to_inclusive:
            return Decimal("0")
        step = 1 if d_to_inclusive > d_from else -1
        cur = d_from
        total = Decimal("0")
        while cur != d_to_inclusive:
            cur = cur + timedelta(days=step)
            if cur in net_by_day:
                total += net_by_day[cur] if step == 1 else -net_by_day[cur]
        return total

    # anchor_balance gilt für anchor_day (Tagesende). Transformiere auf start.
    start_balance = anchor_balance + sum_net(anchor_day, start)

    # Priorität: Wenn es für den Tag Null einen expliziten Saldo-Snapshot gibt, nutze diesen.
    # Wenn der Snapshot die Tag-Null-Regelbuchung noch nicht enthält, addieren wir den Regelbetrag nachträglich.
    tag_zero_konto_after_rule: Optional[Decimal] = None
    tag_zero_balance_includes_rule_booking: Optional[bool] = None
    latest_snapshot = await _latest_balance_snapshot_for_day(session, account=account, day=start)
    if latest_snapshot is not None:
        hid = await _household_id_for_bank_account(session, account)
        rule_tx = await find_tag_zero_matching_transaction(session, account=account, household_id=hid)
        base = Decimal(str(latest_snapshot.balance)).quantize(Decimal("0.01"))
        if rule_tx is not None and rule_tx.booking_date == start:
            # Heuristik: Wenn der Snapshot nach der (Import-)Zeit der Regelbuchung entstanden ist,
            # gehen wir davon aus, dass die Buchung bereits im Snapshot steckt.
            # Andernfalls fehlt sie -> base + rule_amount.
            recorded_ok = False
            if latest_snapshot.recorded_at is not None and rule_tx.imported_at is not None:
                # Toleranz: Balance-Snapshot und Tx-Import können in sehr kurzem Abstand passieren
                # (z. B. gleicher Sync-Run). Dann werten wir das als "gleichzeitig" und behandeln
                # den Snapshot so, als ob er die Regelbuchung bereits enthält.
                delta_s = abs((latest_snapshot.recorded_at - rule_tx.imported_at).total_seconds())
                recorded_ok = latest_snapshot.recorded_at >= rule_tx.imported_at or delta_s < 30
            tag_zero_balance_includes_rule_booking = recorded_ok
            tag_zero_konto_after_rule = (
                base if recorded_ok else (base + Decimal(str(rule_tx.amount))).quantize(Decimal("0.01"))
            )
        else:
            tag_zero_konto_after_rule = base

    # Fallback: keine Snapshots für den Tag Null -> bestehende Rückrechen-Logik.
    if tag_zero_konto_after_rule is None:
        tag_zero_konto_after_rule = await _konto_balance_after_rule_booking(
            session,
            account=account,
            tag_zero_date=start,
            opening_balance=start_balance,
            txs=txs,
        )
        tag_zero_balance_includes_rule_booking = True

    transfer_ids = await _transfer_tx_ids_for_account(
        session,
        account.id,
        from_day=start,
        to_day_exclusive=end_exclusive,
    )
    out_adj = Decimal("0")
    for tx in txs:
        if not (start <= tx.booking_date < end_exclusive):
            continue
        if tx.id not in transfer_ids:
            continue
        amt = Decimal(str(tx.amount))
        if amt < 0:
            out_adj += amt

    # Ausgehende Umbuchungen: Start-Saldo + Tag-Null-Konto nach unten korrigieren; Tagesnetto für
    # die Ist-Saldo-Linie ohne erneutes Abziehen am Umbuchungstag (kein Doppel-Abzug im Diagramm).
    if out_adj != 0:
        if tag_zero_konto_after_rule is not None:
            tag_zero_konto_after_rule = (tag_zero_konto_after_rule + out_adj).quantize(Decimal("0.01"))
        start_balance = (start_balance + out_adj).quantize(Decimal("0.01"))

    logger.info(
        "DayZero[%s] debug: tag_zero_date=%s anchor_day=%s "
        "anchor_balance=%s start_balance=%s out_internal_transfer_adj=%s "
        "latest_snapshot_balance=%s latest_snapshot_recorded_at=%s "
        "rule_tx_id=%s rule_amount=%s rule_booking_date=%s rule_imported_at=%s "
        "tag_zero_konto_after_rule=%s",
        account.id,
        start.isoformat(),
        anchor_day.isoformat(),
        str(anchor_balance),
        str(start_balance),
        str(out_adj),
        str(getattr(latest_snapshot, "balance", None)) if latest_snapshot is not None else None,
        getattr(latest_snapshot, "recorded_at", None).isoformat()
        if latest_snapshot is not None and latest_snapshot.recorded_at is not None
        else None,
        getattr(rule_tx, "id", None) if "rule_tx" in locals() else None,
        str(getattr(rule_tx, "amount", None)) if "rule_tx" in locals() else None,
        getattr(rule_tx, "booking_date", None).isoformat()
        if "rule_tx" in locals() and getattr(rule_tx, "booking_date", None) is not None
        else None,
        getattr(rule_tx, "imported_at", None).isoformat()
        if "rule_tx" in locals() and getattr(rule_tx, "imported_at", None) is not None
        else None,
        str(tag_zero_konto_after_rule),
    )

    # Ausgaben/Netto ohne Transfers; Vertrags-Buchungen separat für Balken/Tabelle.
    net_excl_transfers_by_day: dict[date, Decimal] = {d: Decimal("0") for d in days}
    spend_by_day: dict[date, Decimal] = {d: Decimal("0") for d in days}
    spend_excl_contract_by_day: dict[date, Decimal] = {d: Decimal("0") for d in days}
    spend_contract_by_day: dict[date, Decimal] = {d: Decimal("0") for d in days}
    for tx in txs:
        bd = tx.booking_date
        if bd not in spend_by_day:
            continue
        if tx.id in transfer_ids:
            continue
        amt = Decimal(str(tx.amount))
        net_excl_transfers_by_day[bd] += amt
        if amt < 0:
            out_amt = -amt
            spend_by_day[bd] += out_amt
            if getattr(tx, "contract_id", None) is not None:
                spend_contract_by_day[bd] += out_amt
            else:
                spend_excl_contract_by_day[bd] += out_amt

    # --- Konto: Ist = Bank-Saldo; Start = Bank-Rückrechnung + Tag-Null-Regelbetrag + out_adj (ausgehende Umbuchungen) ---
    L = _bank_balance_decimal(account)
    bal_at = getattr(account, "balance_at", None)
    ledger_app: Optional[date] = _utc_naive_to_app_date(bal_at) if bal_at is not None else None
    today_app = app_today()
    period_last = days[-1]
    if ledger_app is None:
        ledger_end = min(period_last, today_app)
        not_tagesaktuell = True
    else:
        ledger_end = min(period_last, max(start, ledger_app))
        not_tagesaktuell = ledger_app < today_app

    total_ledger_net = Decimal("0")
    for tx in txs:
        bd = tx.booking_date
        if bd < start or bd > ledger_end:
            continue
        total_ledger_net += Decimal(str(tx.amount))

    hid_k = await _household_id_for_bank_account(session, account)
    rule_tx_k = await find_tag_zero_matching_transaction(session, account=account, household_id=hid_k)
    rule_amt_k = (
        Decimal(str(rule_tx_k.amount)).quantize(Decimal("0.01"))
        if rule_tx_k is not None and rule_tx_k.booking_date == start
        else Decimal("0")
    )

    konto_bank_opening = (L - total_ledger_net).quantize(Decimal("0.01"))
    konto_saldo_morgen_tag_null = konto_bank_opening
    einnahmen_summe_tag_zero_zeitraum = Decimal("0")
    for tx in txs:
        bd = tx.booking_date
        if not (start <= bd < end_exclusive):
            continue
        amt = Decimal(str(tx.amount))
        if amt > 0:
            einnahmen_summe_tag_zero_zeitraum += amt
    einnahmen_summe_tag_zero_zeitraum = einnahmen_summe_tag_zero_zeitraum.quantize(Decimal("0.01"))
    vertraege_netto_summe_tag_zero_zeitraum = Decimal("0")
    for tx in txs:
        bd = tx.booking_date
        if not (start <= bd < end_exclusive):
            continue
        if getattr(tx, "contract_id", None) is None:
            continue
        vertraege_netto_summe_tag_zero_zeitraum += Decimal(str(tx.amount))
    vertraege_netto_summe_tag_zero_zeitraum = vertraege_netto_summe_tag_zero_zeitraum.quantize(Decimal("0.01"))
    konto_morgen_start_inkl_einnahmen = (
        konto_saldo_morgen_tag_null + einnahmen_summe_tag_zero_zeitraum + vertraege_netto_summe_tag_zero_zeitraum
    ).quantize(Decimal("0.01"))
    # Wie Meltdown: Regel auf den Start; ausgehende Umbuchungen (Summe out_adj ≤ 0) mindern den effektiven Start.
    konto_opening_pre_tag_zero = (konto_bank_opening + rule_amt_k + out_adj).quantize(Decimal("0.01"))

    # Tagespfad: volles Bank-Netto, aber Regelbuchung (einmal) und ausgehende Umbuchungen aus dem Saldo-Verlauf heraus,
    # damit Öffnung + Kumuliertes wieder bei L endet.
    konto_net_by_day: dict[date, Decimal] = {d: net_by_day[d] for d in days}
    if rule_amt_k != 0 and rule_tx_k is not None and rule_tx_k.booking_date in konto_net_by_day:
        konto_net_by_day[rule_tx_k.booking_date] -= rule_amt_k
    for tx in txs:
        bd = tx.booking_date
        if bd < start or bd > ledger_end:
            continue
        if tx.id not in transfer_ids:
            continue
        amt = Decimal(str(tx.amount))
        if amt < 0 and bd in konto_net_by_day:
            konto_net_by_day[bd] -= amt

    # Vertrags-Netto pro Tag (signed) und gleichmäßiger Tagesanteil: Vertrags-Summe ÷ Anzahl Kalendertage.
    contract_net_by_day: dict[date, Decimal] = {d: Decimal("0") for d in days}
    for tx in txs:
        bd = tx.booking_date
        if bd not in contract_net_by_day:
            continue
        if getattr(tx, "contract_id", None) is None:
            continue
        contract_net_by_day[bd] += Decimal(str(tx.amount))

    n_cal = len(days)
    contract_sum_period = sum((contract_net_by_day[d] for d in days), Decimal("0"))
    contract_net_daily_avg = (
        (contract_sum_period / Decimal(n_cal)).quantize(Decimal("0.01")) if n_cal > 0 else Decimal("0")
    )
    konto_net_smooth: dict[date, Decimal] = {
        d: (konto_net_by_day[d] - contract_net_by_day[d] + contract_net_daily_avg).quantize(Decimal("0.01"))
        for d in days
    }

    konto_eod = _build_konto_eod_curve(
        days,
        konto_net_by_day,
        konto_opening_pre_tag_zero=konto_opening_pre_tag_zero,
        ledger_end=ledger_end,
        L=L,
    )
    konto_eod_smooth = _build_konto_eod_curve(
        days,
        konto_net_smooth,
        konto_opening_pre_tag_zero=konto_opening_pre_tag_zero,
        ledger_end=ledger_end,
        L=L,
    )
    kono_ref = konto_opening_pre_tag_zero

    n = len(days)
    denom = max(1, n - 1)
    per_day_fixed = (start_balance / Decimal(denom)) if denom else Decimal("0")

    out: list[dict] = []
    for i, d in enumerate(days):
        # Meltdown · Ist = gleicher Kumulationspfad wie Konto · Ist (Eröffnung, Tag‑Null‑Netto, Regel/Umbuchung).
        konto_bal = konto_eod[d]
        konto_bal_smooth = konto_eod_smooth[d]
        bal_actual = konto_bal
        bal_target = (start_balance * (Decimal(1) - (Decimal(i) / Decimal(denom)))) if denom else Decimal("0")
        # Dynamische Tagesrate: Restbudget / verbleibende Tage inkl. heute.
        # Dadurch ist der Wert am letzten Tag nicht 0 (erst außerhalb des Zeitraums).
        days_left = max(0, n - i)
        per_day_dyn = (bal_actual / Decimal(days_left)) if days_left > 0 else Decimal("0")
        konto_soll = (kono_ref * (Decimal(1) - (Decimal(i) / Decimal(denom)))) if denom else Decimal("0")
        out.append(
            {
                "day": d.isoformat(),
                "balance_actual": str(bal_actual.quantize(Decimal("0.01"))),
                "balance_target": str(bal_target.quantize(Decimal("0.01"))),
                "net_actual": str(net_excl_transfers_by_day.get(d, Decimal("0")).quantize(Decimal("0.01"))),
                "spend_actual": str(spend_by_day.get(d, Decimal("0")).quantize(Decimal("0.01"))),
                "spend_excl_contract": str(spend_excl_contract_by_day.get(d, Decimal("0")).quantize(Decimal("0.01"))),
                "spend_contract": str(spend_contract_by_day.get(d, Decimal("0")).quantize(Decimal("0.01"))),
                "contract_net_daily_avg": str(contract_net_daily_avg.quantize(Decimal("0.01"))),
                "spend_target_fixed": str(per_day_fixed.quantize(Decimal("0.01"))),
                "spend_target_dynamic": str(per_day_dyn.quantize(Decimal("0.01"))),
                "remaining": str(bal_actual.quantize(Decimal("0.01"))),
                "konto_balance_actual": str(konto_bal.quantize(Decimal("0.01"))),
                "konto_balance_excl_contract_smooth": str(konto_bal_smooth.quantize(Decimal("0.01"))),
                "konto_balance_target": str(konto_soll.quantize(Decimal("0.01"))),
            }
        )

    return (
        DayZeroInputs(
            start=start,
            end_exclusive=end_exclusive,
            currency=account.currency,
            start_balance=start_balance,
            tag_zero_konto_after_rule=tag_zero_konto_after_rule,
            outgoing_internal_transfer_adjustment=out_adj,
            tag_zero_balance_includes_rule_booking=tag_zero_balance_includes_rule_booking,
            konto_saldo_ist=L,
            konto_saldo_ledger_day=ledger_app,
            konto_saldo_not_tagesaktuell=not_tagesaktuell,
            konto_saldo_morgen_tag_null=konto_saldo_morgen_tag_null,
            einnahmen_summe_tag_zero_zeitraum=einnahmen_summe_tag_zero_zeitraum,
            vertraege_netto_summe_tag_zero_zeitraum=vertraege_netto_summe_tag_zero_zeitraum,
            konto_morgen_start_inkl_einnahmen=konto_morgen_start_inkl_einnahmen,
            konto_saldo_start_backcalc=konto_opening_pre_tag_zero,
        ),
        out,
    )


async def list_transfer_transactions_in_meltdown_period(
    session: AsyncSession,
    *,
    bank_account_id: int,
    start: date,
    end_exclusive: date,
) -> list[Transaction]:
    """Alle Buchungen auf dem Konto im Zeitraum, die als Umbuchung markiert sind (TransferPair / Zielkonto)."""
    transfer_ids = await _transfer_tx_ids_for_account(
        session,
        bank_account_id,
        from_day=start,
        to_day_exclusive=end_exclusive,
    )
    if not transfer_ids:
        return []
    r = await session.execute(
        select(Transaction)
        .where(Transaction.id.in_(transfer_ids))
        .options(joinedload(Transaction.contract))
        .order_by(Transaction.booking_date.asc(), Transaction.id.asc()),
    )
    return list(r.unique().scalars().all())


async def list_income_transactions_in_meltdown_period(
    session: AsyncSession,
    *,
    bank_account_id: int,
    start: date,
    end_exclusive: date,
) -> list[Transaction]:
    """Zusätzliche Einnahmen im Zeitraum: positive Beträge, ohne als Umbuchung erkannte Buchungen (kein Doppel mit Umbuchungsliste)."""
    transfer_ids = await _transfer_tx_ids_for_account(
        session,
        bank_account_id,
        from_day=start,
        to_day_exclusive=end_exclusive,
    )
    q = (
        select(Transaction)
        .where(
            Transaction.bank_account_id == bank_account_id,
            Transaction.booking_date >= start,
            Transaction.booking_date < end_exclusive,
            Transaction.amount > 0,
        )
        .options(joinedload(Transaction.contract))
        .order_by(Transaction.booking_date.asc(), Transaction.id.asc())
    )
    if transfer_ids:
        q = q.where(Transaction.id.notin_(transfer_ids))
    r = await session.execute(q)
    return list(r.unique().scalars().all())


def ha_dayzero_pick_today_row_index(day_rows: list[dict]) -> int:
    """Index der Tabellenzeile für APP_TIMEZONE-„heute“ (clamp auf Periodenanfang/-ende)."""
    if not day_rows:
        return -1
    t = app_today()
    t_iso = t.isoformat()
    for i, row in enumerate(day_rows):
        if row.get("day") == t_iso:
            return i
    first_s = day_rows[0].get("day")
    last_s = day_rows[-1].get("day")
    if not first_s or not last_s:
        return len(day_rows) - 1
    try:
        first = date.fromisoformat(str(first_s)[:10])
        last = date.fromisoformat(str(last_s)[:10])
    except ValueError:
        return len(day_rows) - 1
    if t < first:
        return 0
    if t > last:
        return len(day_rows) - 1
    return len(day_rows) - 1


def ha_konto_ohne_fixkosten_tabellen_start(inp: DayZeroInputs) -> Decimal:
    """Wie DayZero.tsx ``tableKontoMorgenStartInklEinnahmen``: Konto-Startzeile + Vertrags-Netto + abgehende Umbuchungen."""
    return (
        inp.konto_saldo_morgen_tag_null
        + inp.einnahmen_summe_tag_zero_zeitraum
        + inp.vertraege_netto_summe_tag_zero_zeitraum
        + inp.outgoing_internal_transfer_adjustment
    ).quantize(Decimal("0.01"))


def ha_saldo_referenz_meltdown_line_series(days: list[dict], ref: Decimal) -> list[Decimal]:
    """Meltdown-Linie (ohne Fixkosten): Start ``ref``, pro Tag − ``spend_excl_contract`` (wie Web-UI)."""
    run = ref
    out: list[Decimal] = []
    for row in days:
        excl = Decimal(str(row.get("spend_excl_contract", "0")))
        s = excl if excl >= 0 else Decimal("0")
        run = (run - s).quantize(Decimal("0.01"))
        out.append(run)
    return out


def ha_konto_linear_soll_from_referenz(n: int, ref: Decimal) -> list[Decimal]:
    """Lineare Soll-Rampe von ``ref`` auf 0 über die Periodenlänge (wie Referenz-linear im Diagramm)."""
    if n <= 0:
        return []
    denom = max(1, n - 1)
    return [
        (ref * (Decimal(1) - Decimal(i) / Decimal(denom))).quantize(Decimal("0.01")) for i in range(n)
    ]


def build_ha_dayzero_derived_fields(inp: DayZeroInputs, days: list[dict]) -> dict[str, Any]:
    """Zusatzfelder + Chart-Reihen für Home Assistant (Konto · ohne Fixkosten / Geld pro Tag)."""
    if not days:
        return {
            "konto_ohne_fixkosten_start": None,
            "konto_ohne_fixkosten_saldo_ist": None,
            "konto_ohne_fixkosten_saldo_soll": None,
            "konto_ohne_fixkosten_saldo_delta_ist_minus_soll": None,
            "konto_ohne_fixkosten_pfad_heute": None,
            "konto_ohne_fixkosten_geld_pro_tag": None,
            "chart_days": [],
            "chart_konto_ist": [],
            "chart_meltdown_line": [],
            "chart_konto_linear_soll": [],
        }
    ref = ha_konto_ohne_fixkosten_tabellen_start(inp)
    line = ha_saldo_referenz_meltdown_line_series(days, ref)
    linear = ha_konto_linear_soll_from_referenz(len(days), ref)
    idx = ha_dayzero_pick_today_row_index(days)
    if idx < 0:
        idx = len(days) - 1
    day_row = days[idx]
    pfad = line[idx]
    n = len(days)
    days_left = max(0, n - idx)
    geld_pt = (
        (pfad / Decimal(days_left)).quantize(Decimal("0.01")) if days_left > 0 else Decimal("0")
    )
    # Saldo-Tabelle „Konto · ohne Fixkosten“: Ist = Bank-Saldo (wie Web, bevorzugt ``konto_saldo_ist``).
    try:
        ist_day = Decimal(str(day_row.get("konto_balance_actual", "0"))).quantize(Decimal("0.01"))
    except (ArithmeticError, ValueError, TypeError):
        ist_day = Decimal("0")
    ist_sync = inp.konto_saldo_ist.quantize(Decimal("0.01"))
    ist = ist_sync if ist_sync.is_finite() else ist_day
    denom = max(1, n - 1)
    soll = (ref * (Decimal(1) - Decimal(idx) / Decimal(denom))).quantize(Decimal("0.01"))
    delta = (ist - soll).quantize(Decimal("0.01"))
    return {
        "konto_ohne_fixkosten_start": str(ref),
        "konto_ohne_fixkosten_saldo_ist": str(ist),
        "konto_ohne_fixkosten_saldo_soll": str(soll),
        "konto_ohne_fixkosten_saldo_delta_ist_minus_soll": str(delta),
        "konto_ohne_fixkosten_pfad_heute": str(pfad),
        "konto_ohne_fixkosten_geld_pro_tag": str(geld_pt),
        "chart_days": [str(row.get("day", "")) for row in days],
        "chart_konto_ist": [
            str(Decimal(str(row.get("konto_balance_actual", "0"))).quantize(Decimal("0.01"))) for row in days
        ],
        "chart_meltdown_line": [str(x) for x in line],
        "chart_konto_linear_soll": [str(x) for x in linear],
    }


async def list_contract_transactions_in_meltdown_period(
    session: AsyncSession,
    *,
    bank_account_id: int,
    start: date,
    end_exclusive: date,
) -> list[Transaction]:
    """Buchungen im Zeitraum mit gesetztem ``contract_id`` (bestätigter Vertrag)."""
    r = await session.execute(
        select(Transaction)
        .where(
            Transaction.bank_account_id == bank_account_id,
            Transaction.booking_date >= start,
            Transaction.booking_date < end_exclusive,
            Transaction.contract_id.isnot(None),
        )
        .options(joinedload(Transaction.contract))
        .order_by(Transaction.booking_date.asc(), Transaction.id.asc()),
    )
    return list(r.unique().scalars().all())


def eligible_accounts_with_tag_zero_rule(accounts: Iterable[BankAccount]) -> list[BankAccount]:
    return [a for a in accounts if bank_account_has_tag_zero_rule(a)]

