from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta
from decimal import Decimal
import logging
from typing import Iterable, Optional

from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import AccountGroup, BankAccount, BankAccountBalanceSnapshot, Transaction, TransferPair
from app.services.tag_zero_rule import bank_account_has_tag_zero_rule, find_tag_zero_matching_transaction


logger = logging.getLogger(__name__)


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


@dataclass(frozen=True)
class DayZeroInputs:
    start: date
    end_exclusive: date
    currency: str
    start_balance: Decimal
    #: Kontostand unmittelbar nach der Tag-Null-Regel-Buchung (None → nicht ermittelbar).
    tag_zero_konto_after_rule: Optional[Decimal] = None


async def _household_id_for_bank_account(session: AsyncSession, account: BankAccount) -> int:
    if account.account_group is not None:
        return int(account.account_group.household_id)
    ag = await session.get(AccountGroup, account.account_group_id)
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
    """IDs, die als Umbuchung gelten (TransferPair oder explizites Zielkonto)."""
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
    rp = await session.execute(
        select(TransferPair.out_transaction_id, TransferPair.in_transaction_id)
        .join(Transaction, Transaction.id == TransferPair.out_transaction_id)
        .where(
            Transaction.bank_account_id == bank_account_id,
            Transaction.booking_date >= from_day,
            Transaction.booking_date < to_day_exclusive,
        )
    )
    for out_id, in_id in rp.all():
        if out_id is not None:
            out.add(int(out_id))
        if in_id is not None:
            out.add(int(in_id))
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
        return Decimal(str(best.balance)), best.recorded_at.date()
    # Fallback: aktueller Kontostand (balance) am balance_at Tag oder start
    anchor_day = account.balance_at.date() if getattr(account, "balance_at", None) else start
    return Decimal(str(account.balance)), anchor_day


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
        return (
            DayZeroInputs(
                start=start,
                end_exclusive=end_exclusive,
                currency=account.currency,
                start_balance=Decimal("0"),
                tag_zero_konto_after_rule=None,
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
    latest_snapshot = await _latest_balance_snapshot_for_day(session, account=account, day=start)
    if latest_snapshot is not None:
        hid = await _household_id_for_bank_account(session, account)
        rule_tx = await find_tag_zero_matching_transaction(session, account=account, household_id=hid)
        base = Decimal(str(latest_snapshot.balance)).quantize(Decimal("0.01"))
        if rule_tx is not None and rule_tx.booking_date == start:
            # Heuristik: Wenn der Snapshot nach der (Import-)Zeit der Regelbuchung entstanden ist,
            # gehen wir davon aus, dass die Buchung bereits im Snapshot steckt.
            # Andernfalls fehlt sie -> base + rule_amount.
            recorded_ok = (
                latest_snapshot.recorded_at is not None
                and rule_tx.imported_at is not None
                and latest_snapshot.recorded_at >= rule_tx.imported_at
            )
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

    logger.info(
        "DayZero[%s] debug: tag_zero_date=%s anchor_day=%s "
        "anchor_balance=%s start_balance=%s "
        "latest_snapshot_balance=%s latest_snapshot_recorded_at=%s "
        "rule_tx_id=%s rule_amount=%s rule_booking_date=%s rule_imported_at=%s "
        "tag_zero_konto_after_rule=%s",
        account.id,
        start.isoformat(),
        anchor_day.isoformat(),
        str(anchor_balance),
        str(start_balance),
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

    # Ausgaben/Netto ohne Transfers.
    transfer_ids = await _transfer_tx_ids_for_account(
        session,
        account.id,
        from_day=start,
        to_day_exclusive=end_exclusive,
    )
    net_excl_transfers_by_day: dict[date, Decimal] = {d: Decimal("0") for d in days}
    spend_by_day: dict[date, Decimal] = {d: Decimal("0") for d in days}
    for tx in txs:
        bd = tx.booking_date
        if bd not in spend_by_day:
            continue
        if tx.id in transfer_ids:
            continue
        amt = Decimal(str(tx.amount))
        net_excl_transfers_by_day[bd] += amt
        if amt < 0:
            spend_by_day[bd] += (-amt)

    n = len(days)
    denom = max(1, n - 1)
    per_day_fixed = (start_balance / Decimal(denom)) if denom else Decimal("0")

    out: list[dict] = []
    running_balance = start_balance
    for i, d in enumerate(days):
        if i > 0:
            running_balance += net_by_day.get(d, Decimal("0"))
        bal_actual = running_balance
        bal_target = (start_balance * (Decimal(1) - (Decimal(i) / Decimal(denom)))) if denom else Decimal("0")
        # Dynamische Tagesrate: Restbudget / verbleibende Tage inkl. heute.
        # Dadurch ist der Wert am letzten Tag nicht 0 (erst außerhalb des Zeitraums).
        days_left = max(0, n - i)
        per_day_dyn = (bal_actual / Decimal(days_left)) if days_left > 0 else Decimal("0")
        out.append(
            {
                "day": d.isoformat(),
                "balance_actual": str(bal_actual.quantize(Decimal("0.01"))),
                "balance_target": str(bal_target.quantize(Decimal("0.01"))),
                "net_actual": str(net_excl_transfers_by_day.get(d, Decimal("0")).quantize(Decimal("0.01"))),
                "spend_actual": str(spend_by_day.get(d, Decimal("0")).quantize(Decimal("0.01"))),
                "spend_target_fixed": str(per_day_fixed.quantize(Decimal("0.01"))),
                "spend_target_dynamic": str(per_day_dyn.quantize(Decimal("0.01"))),
                "remaining": str(bal_actual.quantize(Decimal("0.01"))),
            }
        )

    return (
        DayZeroInputs(
            start=start,
            end_exclusive=end_exclusive,
            currency=account.currency,
            start_balance=start_balance,
            tag_zero_konto_after_rule=tag_zero_konto_after_rule,
        ),
        out,
    )


def eligible_accounts_with_tag_zero_rule(accounts: Iterable[BankAccount]) -> list[BankAccount]:
    return [a for a in accounts if bank_account_has_tag_zero_rule(a)]

