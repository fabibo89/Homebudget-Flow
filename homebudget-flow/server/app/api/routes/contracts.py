"""Contracts v2: Nutzerdefinierte Verträge aus mehreren Regeln (OR)."""

from __future__ import annotations

import json
import hashlib
import re
from typing import Any, Optional

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import joinedload

from app.api.deps import CurrentUser
from app.db.models import BankAccount, Category, CategoryRule, Contract, ContractRule, ContractSuggestionIgnore, Transaction
from app.db.session import get_session
from app.schemas.contracts import (
    ContractApplyResult,
    ContractCreateIn,
    ContractOut,
    ContractRuleCreateIn,
    ContractRuleOut,
    ContractRuleUpdateIn,
    ContractUpdateIn,
    ContractSuggestionOut,
    ContractSuggestionIgnoreOut,
    ContractSuggestionTransactionPreviewOut,
    ContractSuggestionSimilarRuleOut,
)
from app.schemas.transaction import TransactionOut, TransferKind, transaction_to_out
from app.schemas.category_rule_conditions import conditions_for_api, resolved_rule_display_name
from app.services.access import bank_account_ids_visible_to_user, bank_account_visible_to_user
from app.services.contract_recurrence import infer_recurrence_label_de
from app.services.contract_suggestion_similarity import (
    similar_category_rules_for_suggestion,
    similar_rule_out_entries,
)
from app.services.contracts_service import (
    booking_dates_by_contract_ids,
    household_id_for_bank_account,
    fetch_transactions_for_contract_detail,
    apply_contracts_for_bank_account,
    load_transfer_pair_transaction_ids,
)
from app.services.contracts_detection import transaction_is_internal_transfer

router = APIRouter(prefix="/contracts", tags=["contracts"])

_CONTRACT_SUGGESTION_SCAN_LIMIT = 2000

_WS_RE = re.compile(r"\s+")


def _norm_text(s: str) -> str:
    s0 = (s or "").strip().lower()
    s0 = _WS_RE.sub(" ", s0)
    return s0


def _suggestion_fingerprint(bank_account_id: int, conditions: list[dict[str, Any]], normalize_dot_space: bool) -> str:
    payload = json.dumps(
        {"bank_account_id": int(bank_account_id), "normalize_dot_space": bool(normalize_dot_space), "conditions": conditions},
        ensure_ascii=False,
        sort_keys=True,
    )
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()


async def _ignored_suggestion_fingerprints(session: AsyncSession, bank_account_id: int) -> set[str]:
    r = await session.execute(
        select(ContractSuggestionIgnore.fingerprint).where(ContractSuggestionIgnore.bank_account_id == int(bank_account_id)),
    )
    return {str(x) for x in r.scalars().all()}


@router.get("/suggestions/ignored", response_model=list[ContractSuggestionIgnoreOut])
async def list_ignored_contract_suggestions(
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
    bank_account_id: int = Query(..., ge=1),
    limit: int = Query(200, ge=1, le=2000),
) -> list[ContractSuggestionIgnoreOut]:
    if not await bank_account_visible_to_user(session, user, int(bank_account_id)):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Kein Zugriff auf dieses Konto")
    r = await session.execute(
        select(ContractSuggestionIgnore)
        .where(ContractSuggestionIgnore.bank_account_id == int(bank_account_id))
        .order_by(ContractSuggestionIgnore.created_at.desc(), ContractSuggestionIgnore.id.desc())
        .limit(int(limit)),
    )
    rows = r.scalars().all()
    return [
        ContractSuggestionIgnoreOut(
            fingerprint=str(x.fingerprint),
            bank_account_id=int(x.bank_account_id),
            created_at=x.created_at,
        )
        for x in rows
    ]


async def _generate_contract_suggestions(
    session: AsyncSession,
    *,
    bank_account_id: int,
    limit: int = 30,
) -> list[ContractSuggestionOut]:
    """
    Heuristik (v1): gruppiert unzugeordnete Ausgaben nach (counterparty|description) + Betrag.
    Ergebnis sind Regel-Vorschläge, die der Nutzer bestätigen oder zu bestehenden Verträgen hinzufügen kann.
    """
    # Nur „unkontraktierte“ Ausgaben betrachten, Umbuchungen ausschließen.
    r_txs = await session.execute(
        select(Transaction).where(
            Transaction.bank_account_id == int(bank_account_id),
            Transaction.contract_id.is_(None),
        )
        .order_by(Transaction.booking_date.desc(), Transaction.id.desc())
        .limit(_CONTRACT_SUGGESTION_SCAN_LIMIT),
    )
    txs = r_txs.scalars().all()
    txs_returned = len(txs)
    if not txs:
        return []

    pair_ids = await load_transfer_pair_transaction_ids(session, [int(t.id) for t in txs])

    groups: dict[tuple[str, str], dict[str, Any]] = {}
    for tx in txs:
        if transaction_is_internal_transfer(tx, pair_ids):
            continue
        # nur Ausgaben
        try:
            if not (tx.amount < 0):
                continue
        except Exception:
            continue

        label_raw = tx.counterparty_name or tx.counterparty or ""
        if not label_raw.strip():
            label_raw = tx.description or ""
        label_norm = _norm_text(label_raw)[:128]
        if not label_norm:
            continue

        amt_abs = f"{abs(tx.amount):.2f}"
        key = (label_norm, amt_abs)
        g = groups.get(key)
        if not g:
            g = {"count": 0, "label_raw": label_raw.strip()[:512], "amt_abs": amt_abs, "dates": [], "tx_prev": []}
            groups[key] = g
        g["count"] += 1
        g["dates"].append(tx.booking_date)
        # kleine Vorschau für UI (ohne weitere Joins)
        if len(g["tx_prev"]) < 12:
            try:
                g["tx_prev"].append(
                    {
                        "id": int(tx.id),
                        "booking_date": str(tx.booking_date),
                        "amount": f"{tx.amount:.2f}",
                        "description": (tx.description or "").strip()[:512],
                        "counterparty": (tx.counterparty_name or tx.counterparty or "").strip()[:512] or None,
                    }
                )
            except Exception:
                pass

    # mind. 3 Vorkommen
    candidates = [
        (k, v) for (k, v) in groups.items() if int(v["count"]) >= 3
    ]
    candidates.sort(key=lambda kv: (-(int(kv[1]["count"])), kv[0][0]))
    candidates = candidates[: max(0, int(limit))]

    ignored = await _ignored_suggestion_fingerprints(session, bank_account_id)
    hh_id = await household_id_for_bank_account(session, int(bank_account_id))
    household_cat_rules: list[CategoryRule] = []
    if hh_id is not None:
        r_cr = await session.execute(
            select(CategoryRule)
            .options(joinedload(CategoryRule.category))
            .where(CategoryRule.household_id == int(hh_id)),
        )
        household_cat_rules = list(r_cr.scalars().unique().all())

    out: list[ContractSuggestionOut] = []
    for (label_norm, amt_abs), meta in candidates:
        # Conditions: direction=debit + amount_between around abs + counterparty/description contains_word(label_norm tokenized)
        # Wir nehmen ein Wort-Muster (ganze Wörter) und normalisieren Punkte/Spaces über Flag.
        # Pattern muss min_length=1 sein.
        pat = label_norm.strip()
        if len(pat) > 512:
            pat = pat[:512]
        # Betrag: +/- 0.01
        try:
            a = float(amt_abs)
        except Exception:
            continue
        min_a = max(0.0, a - 0.01)
        max_a = a + 0.01
        conditions: list[dict[str, Any]] = [
            {"type": "direction", "value": "debit"},
            {"type": "amount_between", "min_amount": f"{min_a:.2f}", "max_amount": f"{max_a:.2f}"},
            {"type": "counterparty_contains_word", "pattern": pat},
        ]
        fp = _suggestion_fingerprint(bank_account_id, conditions, True)
        if fp in ignored:
            continue
        rec = infer_recurrence_label_de(list(meta.get("dates") or []))
        sim_rules = similar_category_rules_for_suggestion(conditions, household_cat_rules)
        sim_out = [
            ContractSuggestionSimilarRuleOut(**row) for row in similar_rule_out_entries(sim_rules)
        ]
        tx_prev = meta.get("tx_prev") or []
        prev_out = [
            ContractSuggestionTransactionPreviewOut(**row) for row in tx_prev if isinstance(row, dict)
        ]
        out.append(
            ContractSuggestionOut(
                fingerprint=fp,
                bank_account_id=int(bank_account_id),
                label=str(meta.get("label_raw") or pat).strip()[:512] or pat,
                conditions=conditions,
                normalize_dot_space=True,
                occurrence_count=int(meta["count"]),
                scanned_transactions_returned=txs_returned,
                scan_limit=_CONTRACT_SUGGESTION_SCAN_LIMIT,
                recurrence_label=rec,
                similar_category_rules=sim_out,
                transactions_preview=prev_out,
            )
        )
    return out

async def _transaction_counts_for_contract_ids(
    session: AsyncSession,
    contract_ids: list[int],
) -> dict[int, int]:
    if not contract_ids:
        return {}
    r = await session.execute(
        select(Transaction.contract_id, func.count(Transaction.id))
        .where(Transaction.contract_id.in_(contract_ids))
        .group_by(Transaction.contract_id),
    )
    return {int(cid): int(n) for cid, n in r.all() if cid is not None}


def _rule_out(r: ContractRule) -> ContractRuleOut:
    cr = r.category_rule
    if cr is None:
        return ContractRuleOut(
            id=r.id,
            contract_id=r.contract_id,
            category_rule_id=int(r.category_rule_id),
            category_rule_display_name="",
            category_id=None,
            category_name=None,
            enabled=bool(r.enabled),
            priority=int(r.priority or 0),
            conditions=[],
            normalize_dot_space=False,
            display_name_override=None,
            created_at=r.created_at,
            updated_at=r.updated_at,
        )
    cat: Category | None = cr.category
    return ContractRuleOut(
        id=r.id,
        contract_id=r.contract_id,
        category_rule_id=int(r.category_rule_id),
        category_rule_display_name=resolved_rule_display_name(cr),
        category_id=cr.category_id,
        category_name=cat.name if cat else None,
        enabled=bool(r.enabled),
        priority=int(r.priority or 0),
        conditions=conditions_for_api(cr),
        normalize_dot_space=bool(cr.normalize_dot_space),
        display_name_override=cr.display_name_override,
        created_at=r.created_at,
        updated_at=r.updated_at,
    )


async def _ensure_category_rule_for_contract(
    session: AsyncSession,
    contract: Contract,
    category_rule_id: int,
) -> CategoryRule:
    hh = await household_id_for_bank_account(session, int(contract.bank_account_id))
    if hh is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Konto ohne Haushalt")
    cr = await session.get(CategoryRule, int(category_rule_id))
    if cr is None or int(cr.household_id) != int(hh):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Kategorie-Regel unbekannt oder gehört nicht zum Haushalt dieses Kontos",
        )
    if cr.category_missing:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Kategorie-Regel ist ungültig (Zielkategorie fehlt)",
        )
    return cr


async def _contract_out(
    session: AsyncSession,
    c: Contract,
    *,
    transaction_count: Optional[int] = None,
    recurrence_label: Optional[str] = None,
) -> ContractOut:
    acc_name = c.bank_account.name if c.bank_account else ""
    if transaction_count is None:
        cnt_map = await _transaction_counts_for_contract_ids(session, [int(c.id)])
        transaction_count = int(cnt_map.get(int(c.id), 0))
    if recurrence_label is None:
        dates_map = await booking_dates_by_contract_ids(session, [int(c.id)])
        recurrence_label = infer_recurrence_label_de(dates_map.get(int(c.id), []))
    return ContractOut(
        id=c.id,
        bank_account_id=c.bank_account_id,
        bank_account_name=acc_name,
        label=c.label,
        rules=[_rule_out(r) for r in (c.rules or [])],
        transaction_count=int(transaction_count),
        recurrence_label=str(recurrence_label or ""),
        created_at=c.created_at,
        updated_at=c.updated_at,
    )


async def _get_contract_for_user(session: AsyncSession, user, contract_id: int) -> Contract:
    r = await session.execute(
        select(Contract)
        .where(Contract.id == contract_id)
        .options(
            joinedload(Contract.bank_account).joinedload(BankAccount.account_group),
            joinedload(Contract.rules)
            .joinedload(ContractRule.category_rule)
            .joinedload(CategoryRule.category),
        ),
    )
    c = r.unique().scalar_one_or_none()
    if c is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Vertrag nicht gefunden")
    if not await bank_account_visible_to_user(session, user, c.bank_account_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Kein Zugriff")
    return c


@router.get("", response_model=list[ContractOut])
async def list_contracts(
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
    bank_account_id: Optional[int] = Query(
        None,
        ge=1,
        description="Nur Verträge dieses Kontos; weglassen = alle sichtbaren Konten",
    ),
) -> list[ContractOut]:
    if bank_account_id is not None:
        if not await bank_account_visible_to_user(session, user, bank_account_id):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Kein Zugriff auf dieses Konto")
        scope_ids = [bank_account_id]
    else:
        scope_ids = await bank_account_ids_visible_to_user(session, user)
        if not scope_ids:
            return []

    q = (
        select(Contract)
        .where(Contract.bank_account_id.in_(scope_ids))
        .options(
            joinedload(Contract.bank_account),
            joinedload(Contract.rules)
            .joinedload(ContractRule.category_rule)
            .joinedload(CategoryRule.category),
        )
        .order_by(Contract.updated_at.desc(), Contract.id.desc())
    )
    r = await session.execute(q)
    rows = r.unique().scalars().all()
    ids = [int(c.id) for c in rows]
    counts = await _transaction_counts_for_contract_ids(session, ids)
    dates_map = await booking_dates_by_contract_ids(session, ids)
    rec_by_id = {cid: infer_recurrence_label_de(dates_map.get(cid, [])) for cid in ids}
    return [
        await _contract_out(
            session,
            c,
            transaction_count=int(counts.get(int(c.id), 0)),
            recurrence_label=rec_by_id.get(int(c.id), "unbekannt"),
        )
        for c in rows
    ]


@router.post("", response_model=ContractOut, status_code=status.HTTP_201_CREATED)
async def create_contract(
    body: ContractCreateIn,
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
) -> ContractOut:
    if not await bank_account_visible_to_user(session, user, body.bank_account_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Kein Zugriff auf dieses Konto")
    c = Contract(bank_account_id=body.bank_account_id, label=body.label.strip()[:512])
    session.add(c)
    await session.flush()
    # eager load account for output
    await session.refresh(c)
    await session.commit()
    r = await session.execute(
        select(Contract)
        .where(Contract.id == c.id)
        .options(
            joinedload(Contract.bank_account),
            joinedload(Contract.rules)
            .joinedload(ContractRule.category_rule)
            .joinedload(CategoryRule.category),
        ),
    )
    row = r.unique().scalar_one()
    return await _contract_out(
        session,
        row,
        transaction_count=0,
        recurrence_label="noch keine Buchungen",
    )


@router.patch("/{contract_id}", response_model=ContractOut)
async def update_contract(
    contract_id: int,
    body: ContractUpdateIn,
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
) -> ContractOut:
    c = await _get_contract_for_user(session, user, contract_id)
    c.label = body.label.strip()[:512]
    c.updated_at = datetime.utcnow()
    await session.commit()
    return await _contract_out(session, c)


@router.delete("/{contract_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_contract(
    contract_id: int,
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
) -> None:
    c = await _get_contract_for_user(session, user, contract_id)
    await session.delete(c)
    await session.commit()
    return None


@router.get("/{contract_id}/transactions", response_model=list[TransactionOut])
async def list_contract_transactions(
    contract_id: int,
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
    limit: int = Query(500, ge=1, le=2000),
) -> list[TransactionOut]:
    from app.api.routes.transactions import _transfer_kind_map_for_transactions
    from app.db.models import Category
    from app.services.transaction_enrichment import enrichment_list_meta_for_transactions

    c = await _get_contract_for_user(session, user, contract_id)

    raw_rows = await fetch_transactions_for_contract_detail(session, c, limit=limit)
    if not raw_rows:
        return []

    ids = [int(t.id) for t in raw_rows]
    q = (
        select(Transaction)
        .where(Transaction.id.in_(ids))
        .options(
            joinedload(Transaction.category)
            .joinedload(Category.parent)
            .selectinload(Category.children),
            joinedload(Transaction.contract),
        )
    )
    r = await session.execute(q)
    by_id = {int(x.id): x for x in r.unique().scalars().all()}
    rows = [by_id[i] for i in ids if i in by_id]
    ids = [x.id for x in rows]
    meta_map = await enrichment_list_meta_for_transactions(session, ids)
    transfer_kind_map = await _transfer_kind_map_for_transactions(
        session,
        current_user_id=user.id,
        rows=rows,
    )
    return [
        transaction_to_out(
            x,
            enrichment_preview_lines=meta_map[x.id].preview_lines,
            transfer_kind=transfer_kind_map.get(x.id, TransferKind.none),
        )
        for x in rows
    ]


@router.post("/{contract_id}/rules", response_model=ContractRuleOut, status_code=status.HTTP_201_CREATED)
async def create_contract_rule(
    contract_id: int,
    body: ContractRuleCreateIn,
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
) -> ContractRuleOut:
    c = await _get_contract_for_user(session, user, contract_id)
    _ = await _ensure_category_rule_for_contract(session, c, int(body.category_rule_id))
    dup = await session.execute(
        select(ContractRule.id).where(
            ContractRule.contract_id == int(c.id),
            ContractRule.category_rule_id == int(body.category_rule_id),
        ),
    )
    if dup.first():
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Diese Kategorie-Regel ist bereits mit diesem Vertrag verknüpft",
        )
    r = ContractRule(
        contract_id=c.id,
        category_rule_id=int(body.category_rule_id),
        enabled=bool(body.enabled),
        priority=int(body.priority),
        conditions_json="[]",
        normalize_dot_space=False,
        display_name_override=None,
    )
    session.add(r)
    await session.commit()
    await session.refresh(r)
    r2 = await session.execute(
        select(ContractRule)
        .where(ContractRule.id == r.id)
        .options(
            joinedload(ContractRule.category_rule).joinedload(CategoryRule.category),
        ),
    )
    row = r2.unique().scalar_one()
    return _rule_out(row)


@router.patch("/rules/{rule_id}", response_model=ContractRuleOut)
async def update_contract_rule(
    rule_id: int,
    body: ContractRuleUpdateIn,
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
) -> ContractRuleOut:
    r0 = await session.get(ContractRule, rule_id)
    if r0 is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Regel nicht gefunden")
    # access via parent contract
    c = await _get_contract_for_user(session, user, int(r0.contract_id))
    # ensure rule still belongs to loaded contract
    if int(r0.contract_id) != int(c.id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Kein Zugriff")

    if body.enabled is not None:
        r0.enabled = bool(body.enabled)
    if body.priority is not None:
        r0.priority = int(body.priority)

    r0.updated_at = datetime.utcnow()
    await session.commit()
    r2 = await session.execute(
        select(ContractRule)
        .where(ContractRule.id == r0.id)
        .options(
            joinedload(ContractRule.category_rule).joinedload(CategoryRule.category),
        ),
    )
    row = r2.unique().scalar_one()
    return _rule_out(row)


@router.delete("/rules/{rule_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_contract_rule(
    rule_id: int,
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
) -> None:
    r0 = await session.get(ContractRule, rule_id)
    if r0 is None:
        return None
    _ = await _get_contract_for_user(session, user, int(r0.contract_id))
    await session.delete(r0)
    await session.commit()
    return None


@router.post("/{contract_id}/apply", response_model=ContractApplyResult)
async def apply_contract(
    contract_id: int,
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
) -> ContractApplyResult:
    c = await _get_contract_for_user(session, user, contract_id)
    n = await apply_contracts_for_bank_account(session, c.bank_account_id)
    await session.commit()
    return ContractApplyResult(ok=True, transactions_updated=n)


@router.post("/reset-assignments", response_model=ContractApplyResult)
async def reset_contract_assignments(
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
    bank_account_id: int = Query(..., ge=1),
) -> ContractApplyResult:
    """
    Setzt alle transaction.contract_id für ein Konto zurück (NULL).
    Hilfreich, wenn alte Vertragszuordnungen Vorschläge blockieren.
    """
    if not await bank_account_visible_to_user(session, user, int(bank_account_id)):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Kein Zugriff auf dieses Konto")
    r = await session.execute(
        select(Transaction.id).where(
            Transaction.bank_account_id == int(bank_account_id),
            Transaction.contract_id.is_not(None),
        )
    )
    tx_ids = [int(x) for x in r.scalars().all()]
    if not tx_ids:
        return ContractApplyResult(ok=True, transactions_updated=0)
    r2 = await session.execute(
        select(Transaction).where(Transaction.id.in_(tx_ids)),
    )
    rows = r2.scalars().all()
    for tx in rows:
        tx.contract_id = None
    await session.commit()
    return ContractApplyResult(ok=True, transactions_updated=len(rows))


@router.get("/suggestions", response_model=list[ContractSuggestionOut])
async def list_contract_suggestions(
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
    bank_account_id: int = Query(..., ge=1),
    limit: int = Query(30, ge=1, le=200),
) -> list[ContractSuggestionOut]:
    if not await bank_account_visible_to_user(session, user, int(bank_account_id)):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Kein Zugriff auf dieses Konto")
    return await _generate_contract_suggestions(session, bank_account_id=int(bank_account_id), limit=int(limit))


@router.post("/suggestions/{fingerprint}/ignore", status_code=status.HTTP_204_NO_CONTENT)
async def ignore_contract_suggestion(
    fingerprint: str,
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
    bank_account_id: int = Query(..., ge=1),
) -> None:
    if not await bank_account_visible_to_user(session, user, int(bank_account_id)):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Kein Zugriff auf dieses Konto")
    fp = (fingerprint or "").strip()
    if not fp:
        return None
    r = ContractSuggestionIgnore(bank_account_id=int(bank_account_id), fingerprint=fp[:64])
    session.add(r)
    try:
        await session.commit()
    except Exception:
        # Duplicate ignore is fine
        await session.rollback()
    return None


@router.delete("/suggestions/{fingerprint}/ignore", status_code=status.HTTP_204_NO_CONTENT)
async def unignore_contract_suggestion(
    fingerprint: str,
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
    bank_account_id: int = Query(..., ge=1),
) -> None:
    if not await bank_account_visible_to_user(session, user, int(bank_account_id)):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Kein Zugriff auf dieses Konto")
    fp = (fingerprint or "").strip()
    if not fp:
        return None
    r = await session.execute(
        select(ContractSuggestionIgnore).where(
            ContractSuggestionIgnore.bank_account_id == int(bank_account_id),
            ContractSuggestionIgnore.fingerprint == fp[:64],
        ),
    )
    row = r.scalar_one_or_none()
    if row is None:
        return None
    await session.delete(row)
    await session.commit()
    return None
