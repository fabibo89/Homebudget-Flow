"""Contracts v2: nutzerdefinierte Verträge aus mehreren Regeln (OR) + Zuordnung zu Buchungen."""

from __future__ import annotations

from datetime import date
from typing import Optional

from sqlalchemy import or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import joinedload

from app.db.models import (
    AccountGroup,
    BankAccount,
    Contract,
    ContractRule,
    Transaction,
    TransferPair,
)
from app.schemas.category_rule_conditions import (
    rule_effective_conditions,
    transaction_matches_conditions,
)
from app.services.contracts_detection import transaction_is_internal_transfer


async def household_id_for_bank_account(session: AsyncSession, bank_account_id: int) -> Optional[int]:
    r = await session.execute(
        select(AccountGroup.household_id)
        .select_from(BankAccount)
        .join(AccountGroup, AccountGroup.id == BankAccount.account_group_id)
        .where(BankAccount.id == bank_account_id),
    )
    row = r.first()
    return int(row[0]) if row else None


async def load_transfer_pair_transaction_ids(
    session: AsyncSession,
    transaction_ids: list[int],
) -> set[int]:
    """Alle Buchungs-IDs, die in einem TransferPair vorkommen (bei Teil-Menge werden beide Beine des Paares geliefert)."""
    if not transaction_ids:
        return set()
    r = await session.execute(
        select(TransferPair.out_transaction_id, TransferPair.in_transaction_id).where(
            or_(
                TransferPair.out_transaction_id.in_(transaction_ids),
                TransferPair.in_transaction_id.in_(transaction_ids),
            ),
        ),
    )
    out: set[int] = set()
    for oid, iid in r.all():
        out.add(int(oid))
        out.add(int(iid))
    return out


async def transaction_ids_on_bank_account(session: AsyncSession, bank_account_id: int) -> list[int]:
    r = await session.execute(select(Transaction.id).where(Transaction.bank_account_id == bank_account_id))
    return [int(i) for i in r.scalars().all()]


async def booking_dates_by_contract_ids(
    session: AsyncSession,
    contract_ids: list[int],
) -> dict[int, list[date]]:
    """Eindeutige Buchungsdaten pro Vertrag, aufsteigend sortiert."""
    if not contract_ids:
        return {}
    out: dict[int, list[date]] = {int(cid): [] for cid in contract_ids}
    r = await session.execute(
        select(Transaction.contract_id, Transaction.booking_date).where(
            Transaction.contract_id.in_(contract_ids),
        ),
    )
    for cid, bd in r.all():
        if cid is None or bd is None:
            continue
        ic = int(cid)
        if ic in out:
            out[ic].append(bd)
    for ic in out:
        out[ic] = sorted(set(out[ic]))
    return out


def _rule_matches_transaction(tx: Transaction, rule: ContractRule) -> bool:
    if not rule.enabled:
        return False
    cr = rule.category_rule
    if cr is None or cr.category_missing:
        return False
    conds = rule_effective_conditions(cr)
    return transaction_matches_conditions(tx, conds, normalize_dot_space=bool(cr.normalize_dot_space))


async def apply_contracts_for_bank_account(session: AsyncSession, bank_account_id: int) -> int:
    """
    Ordnet Buchungen auf einem Konto anhand der Vertragsregeln zu.
    Strategie: erste passende Regel gewinnt; Reihenfolge: Contract.id ASC, Rule.priority ASC, Rule.id ASC.
    Umbuchungen (TransferPair/Target) werden ausgeschlossen.
    """
    # Alle Transaktionen im Speicher, um TransferPairs einmalig zu berechnen
    r_all = await session.execute(select(Transaction).where(Transaction.bank_account_id == bank_account_id))
    txs = r_all.scalars().all()
    if not txs:
        return 0
    pair_ids = await load_transfer_pair_transaction_ids(session, [int(t.id) for t in txs])

    r_contracts = await session.execute(
        select(Contract)
        .where(Contract.bank_account_id == bank_account_id)
        .options(joinedload(Contract.rules).joinedload(ContractRule.category_rule))
        .order_by(Contract.id.asc()),
    )
    contracts = r_contracts.unique().scalars().all()
    if not contracts:
        # Wenn keine Verträge existieren: alle Links entfernen
        res = await session.execute(
            update(Transaction).where(Transaction.bank_account_id == bank_account_id).values(contract_id=None),
        )
        return int(res.rowcount or 0)

    updated = 0
    for tx in txs:
        if transaction_is_internal_transfer(tx, pair_ids):
            # interne Umbuchung: nie als Vertrag labeln
            if tx.contract_id is not None:
                tx.contract_id = None
                updated += 1
            continue

        # Nur Ausgaben typischerweise als Vertrag; kann über Direction-Condition erweitert werden.
        # Hier bewusst keine harte Einschränkung: DirectionCondition kann "all" sein.
        match_contract_id: Optional[int] = None
        for c in contracts:
            for rule in c.rules:
                if _rule_matches_transaction(tx, rule):
                    match_contract_id = int(c.id)
                    break
            if match_contract_id is not None:
                break

        have = tx.contract_id
        if match_contract_id != have:
            tx.contract_id = match_contract_id
            updated += 1

    return updated


async def fetch_transactions_for_contract_detail(
    session: AsyncSession,
    contract: Contract,
    *,
    limit: int = 2000,
) -> list[Transaction]:
    acc_tx_ids = await transaction_ids_on_bank_account(session, contract.bank_account_id)
    pair_ids = await load_transfer_pair_transaction_ids(session, acc_tx_ids)
    r = await session.execute(
        select(Transaction)
        .where(Transaction.contract_id == contract.id)
        .order_by(Transaction.booking_date.desc(), Transaction.id.desc())
        .limit(limit),
    )
    return [t for t in r.scalars().all() if not transaction_is_internal_transfer(t, pair_ids)]
