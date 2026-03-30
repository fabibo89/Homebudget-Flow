from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import joinedload

from app.api.deps import CurrentUser
from app.db.models import BankAccount, Category, CategoryRule, CategoryRuleSuggestionDismissal, Transaction, User
from app.db.session import get_session
from app.schemas.category_rule import (
    CategoryRuleConditionsBody,
    CategoryRuleCreate,
    parse_category_rule_conditions_body,
    CategoryRuleCreatedOut,
    CategoryRuleOut,
    CategoryRuleOverwriteCandidate,
    CategoryRulesListOut,
    CategoryRuleSuggestionDismissCreate,
    CategoryRuleSuggestionOut,
  CategoryRuleSuggestionPreviewBody,
  CategoryRuleSuggestionPreviewOut,
    CategoryRuleSuggestionRestoreBody,
    CategoryRuleSuggestionsBundle,
    CategoryRuleTypeSchema,
    CategoryRuleUpdate,
)
from app.schemas.transaction import transaction_to_out
from app.schemas.category_rule_conditions import (
    conditions_for_api,
    conditions_from_legacy_api_type,
    conditions_to_json,
    derive_rule_type_and_pattern,
    resolved_rule_display_name,
    transaction_matches_conditions,
)
from app.services.category_assignment import ensure_category_is_subcategory_for_assignment
from app.services.access import (
    bank_account_ids_visible_for_user_in_household,
    user_can_access_bank_account,
    user_has_household,
)
from app.services.category_rule_suggestions import (
    compute_category_rule_suggestions,
    suggestion_pattern_norm,
    suggestion_pool_limit,
)
from app.services.category_rules import (
    apply_category_rules_to_uncategorized,
    build_rule_allowed_bank_account_ids,
  first_matching_rule_category_id,
    list_category_rule_overwrite_candidates,
    reverse_category_rule_assignments,
)
from app.services.salary_cache import refresh_salary_cache_for_household
from app.services.default_income_categories import (
    ensure_income_category_tree,
    get_gehalt_category_id,
    income_gehalt_rule_warnings,
)

_SUGGESTIONS_TX_CAP = 20_000
_DISMISS_SAMPLE_CAP = 24

router = APIRouter(prefix="/households", tags=["category-rules"])


def _creator_display(user: User | None) -> str | None:
    if user is None:
        return None
    dn = (user.display_name or "").strip()
    return dn if dn else (user.email or None)


async def _user_map_by_ids(session: AsyncSession, ids: set[int]) -> dict[int, User]:
    if not ids:
        return {}
    r = await session.execute(select(User).where(User.id.in_(ids)))
    return {u.id: u for u in r.scalars().all()}


def _rule_to_out(row: CategoryRule, user_map: dict[int, User]) -> CategoryRuleOut:
    uid = row.created_by_user_id
    disp = None
    if uid is not None:
        disp = _creator_display(user_map.get(uid))
    override_raw = (getattr(row, "display_name_override", None) or "").strip()
    return CategoryRuleOut(
        id=row.id,
        household_id=row.household_id,
        category_id=row.category_id,
        category_missing=bool(getattr(row, "category_missing", False)),
        applies_to_household=row.applies_to_household,
        rule_type=row.rule_type,
        pattern=row.pattern,
        normalize_dot_space=bool(getattr(row, "normalize_dot_space", False)),
        display_name=resolved_rule_display_name(row),
        display_name_override=override_raw if override_raw else None,
        conditions=conditions_for_api(row),
        created_at=row.created_at,
        created_by_user_id=uid,
        created_by_display=disp,
    )


def _parse_rule_conditions_body(body: CategoryRuleConditionsBody) -> list:
    try:
        return parse_category_rule_conditions_body(body)
    except ValueError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e)) from e
    except ValidationError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail=e.errors()) from e


@router.get("/{household_id}/category-rules", response_model=CategoryRulesListOut)
async def list_category_rules(
    household_id: int,
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
) -> CategoryRulesListOut:
    if not await user_has_household(session, user.id, household_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Kein Zugriff auf diesen Haushalt.")
    await ensure_income_category_tree(session, household_id, created_by_user_id=user.id)
    await session.commit()
    r = await session.execute(
        select(CategoryRule)
        .where(CategoryRule.household_id == household_id)
        .order_by(CategoryRule.id.desc()),
    )
    rows = list(r.scalars().all())
    uids = {x.created_by_user_id for x in rows if x.created_by_user_id is not None}
    user_map = await _user_map_by_ids(session, uids)
    rules = [_rule_to_out(x, user_map) for x in rows]
    gehalt_id = await get_gehalt_category_id(session, household_id)
    warnings = income_gehalt_rule_warnings(rows, gehalt_id)
    broken = sum(1 for x in rows if x.category_id is None or getattr(x, "category_missing", False))
    if broken:
        warnings = [
            *warnings,
            f"{broken} Zuordnungsregel(n) ohne gültige Kategorie — bitte im Dialog „Regel bearbeiten“ neu zuordnen.",
        ]
    return CategoryRulesListOut(rules=rules, warnings=warnings)


def _dismissal_to_suggestion(row: CategoryRuleSuggestionDismissal) -> CategoryRuleSuggestionOut:
    try:
        labels = json.loads(row.sample_labels_json or "[]")
    except json.JSONDecodeError:
        labels = []
    if not isinstance(labels, list):
        labels = []
    return CategoryRuleSuggestionOut(
        rule_type=CategoryRuleTypeSchema(row.rule_type),
        pattern=row.pattern_display,
        transaction_count=row.snapshot_transaction_count,
        distinct_label_count=row.snapshot_distinct_label_count,
        sample_labels=[str(x) for x in labels],
    )


@router.get(
    "/{household_id}/category-rule-suggestions",
    response_model=CategoryRuleSuggestionsBundle,
)
async def list_category_rule_suggestions(
    household_id: int,
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
) -> CategoryRuleSuggestionsBundle:
    """Muster-Vorschläge aus unkategorisierten Buchungen; ignorierte separat (Snapshot)."""
    if not await user_has_household(session, user.id, household_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Kein Zugriff auf diesen Haushalt.")
    await ensure_income_category_tree(session, household_id, created_by_user_id=user.id)
    await session.commit()

    dismiss_r = await session.execute(
        select(CategoryRuleSuggestionDismissal)
        .where(CategoryRuleSuggestionDismissal.household_id == household_id)
        .order_by(CategoryRuleSuggestionDismissal.created_at.desc()),
    )
    dismissals = list(dismiss_r.scalars().all())
    dismissed_keys = {(d.rule_type, d.pattern_norm) for d in dismissals}
    ignored = [_dismissal_to_suggestion(d) for d in dismissals]

    account_ids = await bank_account_ids_visible_for_user_in_household(session, user, household_id)
    if not account_ids:
        return CategoryRuleSuggestionsBundle(active=[], ignored=ignored)

    rules_r = await session.execute(
        select(CategoryRule)
        .where(CategoryRule.household_id == household_id)
        .order_by(CategoryRule.id.desc()),
    )
    rules = list(rules_r.scalars().all())

    tx_r = await session.execute(
        select(Transaction)
        .where(
            Transaction.bank_account_id.in_(account_ids),
            Transaction.category_id.is_(None),
        )
        .order_by(Transaction.booking_date.desc(), Transaction.id.desc())
        .limit(_SUGGESTIONS_TX_CAP),
    )
    txs = list(tx_r.scalars().all())
    rule_allowed = await build_rule_allowed_bank_account_ids(session, household_id, rules)
    raw = compute_category_rule_suggestions(
        txs,
        rules,
        rule_allowed,
        max_suggestions=suggestion_pool_limit(len(dismissals)),
    )

    active: list[CategoryRuleSuggestionOut] = []
    for row in raw:
        key = (row["rule_type"], suggestion_pattern_norm(row["pattern"]))
        if key in dismissed_keys:
            continue
        active.append(CategoryRuleSuggestionOut(**row))

    return CategoryRuleSuggestionsBundle(active=active, ignored=ignored)


@router.post(
    "/{household_id}/category-rule-suggestions/preview",
    response_model=CategoryRuleSuggestionPreviewOut,
)
async def preview_category_rule_suggestion(
    household_id: int,
    body: CategoryRuleSuggestionPreviewBody,
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
) -> CategoryRuleSuggestionPreviewOut:
    """Zeigt Buchungen, die auf einen Vorschlag passen, gruppiert nach Beispiel-Labels."""
    if not await user_has_household(session, user.id, household_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Kein Zugriff auf diesen Haushalt.")

    rt = body.rule_type.value
    if rt not in (
        CategoryRuleTypeSchema.counterparty_contains.value,
        CategoryRuleTypeSchema.description_contains.value,
    ):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Nur Vorschläge vom Typ „enthält“ können als Vorschau angezeigt werden.",
        )

    account_ids = await bank_account_ids_visible_for_user_in_household(session, user, household_id)
    if not account_ids:
        return CategoryRuleSuggestionPreviewOut(rule_type=body.rule_type, pattern=body.pattern, truncated=False, groups=[])

    rules_r = await session.execute(
        select(CategoryRule)
        .where(CategoryRule.household_id == household_id)
        .order_by(CategoryRule.id.desc()),
    )
    rules = list(rules_r.scalars().all())
    rule_allowed = await build_rule_allowed_bank_account_ids(session, household_id, rules)

    conds = conditions_from_legacy_api_type(rt, body.pattern)

    # Gleicher Suchbereich wie bei GET category-rule-suggestions (unkategorisiert, neueste zuerst)
    tx_r = await session.execute(
        select(Transaction)
        .where(
            Transaction.bank_account_id.in_(account_ids),
            Transaction.category_id.is_(None),
        )
        .order_by(Transaction.booking_date.desc(), Transaction.id.desc())
        .limit(_SUGGESTIONS_TX_CAP),
    )
    txs = list(tx_r.scalars().all())

    sample_set = {str(x).strip() for x in (body.sample_labels or []) if str(x).strip()}

    groups: dict[str, list] = {lab: [] for lab in sample_set}
    other: list = []
    total = 0
    truncated = False

    for tx in txs:
        # nur Buchungen, die nicht schon durch bestehende Regeln getroffen würden
        if first_matching_rule_category_id(tx, rules, rule_allowed) is not None:
            continue
        if not transaction_matches_conditions(tx, conds):
            continue

        label = (
            (tx.counterparty or "").strip()
            if rt
            in (
                CategoryRuleTypeSchema.counterparty_contains.value,
                CategoryRuleTypeSchema.counterparty_contains_word.value,
            )
            else (tx.description or "").strip()
        )
        out_tx = transaction_to_out(tx)

        if sample_set and label in groups:
            if len(groups[label]) < body.limit_per_label and total < body.limit_total:
                groups[label].append(out_tx)
                total += 1
            else:
                truncated = True
        else:
            if total < body.limit_total:
                other.append(out_tx)
                total += 1
            else:
                truncated = True

        if total >= body.limit_total:
            truncated = True
            break

    out_groups = []
    for lab in (body.sample_labels or []):
        l = str(lab).strip()
        if not l:
            continue
        tx_list = groups.get(l) or []
        if tx_list:
            out_groups.append({"label": l, "transactions": tx_list})
    if other:
        out_groups.append({"label": "Weitere Treffer", "transactions": other})

    return CategoryRuleSuggestionPreviewOut(
        rule_type=body.rule_type,
        pattern=body.pattern,
        truncated=truncated,
        groups=out_groups,
    )


@router.post(
    "/{household_id}/category-rule-suggestion-dismissals",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def dismiss_category_rule_suggestion(
    household_id: int,
    body: CategoryRuleSuggestionDismissCreate,
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
) -> None:
    if not await user_has_household(session, user.id, household_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Kein Zugriff auf diesen Haushalt.")

    rt = body.rule_type.value
    if rt not in (
        CategoryRuleTypeSchema.counterparty_contains.value,
        CategoryRuleTypeSchema.description_contains.value,
    ):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Nur Vorschläge vom Typ „enthält“ können ignoriert werden.",
        )

    disp = body.pattern.strip()[:512]
    pn = suggestion_pattern_norm(body.pattern)
    if not pn:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Muster darf nicht leer sein.")

    samples = [str(x) for x in body.sample_labels[:_DISMISS_SAMPLE_CAP]]
    payload = json.dumps(samples, ensure_ascii=False)

    r = await session.execute(
        select(CategoryRuleSuggestionDismissal).where(
            CategoryRuleSuggestionDismissal.household_id == household_id,
            CategoryRuleSuggestionDismissal.rule_type == rt,
            CategoryRuleSuggestionDismissal.pattern_norm == pn,
        ),
    )
    existing = r.scalar_one_or_none()
    if existing is None:
        session.add(
            CategoryRuleSuggestionDismissal(
                household_id=household_id,
                rule_type=rt,
                pattern_norm=pn,
                pattern_display=disp,
                snapshot_transaction_count=body.transaction_count,
                snapshot_distinct_label_count=body.distinct_label_count,
                sample_labels_json=payload,
            ),
        )
    else:
        existing.pattern_display = disp
        existing.snapshot_transaction_count = body.transaction_count
        existing.snapshot_distinct_label_count = body.distinct_label_count
        existing.sample_labels_json = payload

    await session.commit()


@router.delete(
    "/{household_id}/category-rule-suggestion-dismissals",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def restore_category_rule_suggestion(
    household_id: int,
    body: CategoryRuleSuggestionRestoreBody,
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
) -> None:
    if not await user_has_household(session, user.id, household_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Kein Zugriff auf diesen Haushalt.")

    rt = body.rule_type.value
    pn = suggestion_pattern_norm(body.pattern)
    if not pn:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Muster darf nicht leer sein.")

    r = await session.execute(
        select(CategoryRuleSuggestionDismissal).where(
            CategoryRuleSuggestionDismissal.household_id == household_id,
            CategoryRuleSuggestionDismissal.rule_type == rt,
            CategoryRuleSuggestionDismissal.pattern_norm == pn,
        ),
    )
    row = r.scalar_one_or_none()
    if row is not None:
        await session.delete(row)
        await session.commit()


@router.post(
    "/{household_id}/category-rules",
    response_model=CategoryRuleCreatedOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_category_rule(
    household_id: int,
    body: CategoryRuleCreate,
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
) -> CategoryRuleCreatedOut:
    if not await user_has_household(session, user.id, household_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Kein Zugriff auf diesen Haushalt.")

    await ensure_income_category_tree(session, household_id, created_by_user_id=user.id)

    cat = await session.get(Category, body.category_id)
    if cat is None or cat.household_id != household_id:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Kategorie unbekannt oder gehört nicht zu diesem Haushalt.",
        )
    ensure_category_is_subcategory_for_assignment(cat)

    conds = _parse_rule_conditions_body(body)
    rt, pat = derive_rule_type_and_pattern(conds)
    cj = conditions_to_json(conds)

    ovr = (body.display_name_override or "").strip()
    row = CategoryRule(
        household_id=household_id,
        category_id=body.category_id,
        category_missing=False,
        rule_type=rt,
        pattern=(pat or "")[:512],
        display_name_override=ovr if ovr else None,
        normalize_dot_space=body.normalize_dot_space,
        conditions_json=cj,
        created_by_user_id=user.id,
        applies_to_household=body.applies_to_household,
    )
    session.add(row)
    await session.flush()

    n_updated = 0
    overwrite_candidates: list[CategoryRuleOverwriteCandidate] = []
    overwrite_truncated = False
    if body.apply_to_uncategorized:
        n_updated = await apply_category_rules_to_uncategorized(session, household_id)
        rows, overwrite_truncated = await list_category_rule_overwrite_candidates(
            session,
            user,
            household_id,
        )
        overwrite_candidates = [
            CategoryRuleOverwriteCandidate(
                transaction_id=r.transaction_id,
                bank_account_id=r.bank_account_id,
                booking_date=r.booking_date,
                amount=r.amount,
                currency=r.currency,
                description=r.description,
                counterparty=r.counterparty,
                current_category_id=r.current_category_id,
                current_category_name=r.current_category_name,
                suggested_category_id=r.suggested_category_id,
                suggested_category_name=r.suggested_category_name,
            )
            for r in rows
        ]

    if body.also_assign_transaction_id is not None:
        r_tx = await session.execute(
            select(Transaction)
            .where(Transaction.id == body.also_assign_transaction_id)
            .options(
                joinedload(Transaction.bank_account).joinedload(BankAccount.account_group),
            ),
        )
        tx = r_tx.unique().scalar_one_or_none()
        if tx is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Buchung nicht gefunden.")
        hh = tx.bank_account.account_group.household_id
        if hh != household_id:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Buchung gehört nicht zu diesem Haushalt.",
            )
        if not await user_can_access_bank_account(session, user.id, tx.bank_account_id):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Kein Zugriff auf diese Buchung.")
        tx.category_id = body.category_id

    if body.also_assign_transaction_id is not None:
        await refresh_salary_cache_for_household(session, household_id)

    await session.commit()
    await session.refresh(row)
    umap = await _user_map_by_ids(session, {row.created_by_user_id} if row.created_by_user_id else set())
    base = _rule_to_out(row, umap)
    return CategoryRuleCreatedOut(
        **base.model_dump(),
        transactions_updated=n_updated,
        category_overwrite_candidates=overwrite_candidates,
        category_overwrite_truncated=overwrite_truncated,
    )


@router.patch(
    "/{household_id}/category-rules/{rule_id}",
    response_model=CategoryRuleCreatedOut,
)
async def update_category_rule(
    household_id: int,
    rule_id: int,
    body: CategoryRuleUpdate,
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
) -> CategoryRuleCreatedOut:
    if not await user_has_household(session, user.id, household_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Kein Zugriff auf diesen Haushalt.")

    await ensure_income_category_tree(session, household_id, created_by_user_id=user.id)

    row = await session.get(CategoryRule, rule_id)
    if row is None or row.household_id != household_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Regel nicht gefunden.")

    cat = await session.get(Category, body.category_id)
    if cat is None or cat.household_id != household_id:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Kategorie unbekannt oder gehört nicht zu diesem Haushalt.",
        )
    ensure_category_is_subcategory_for_assignment(cat)

    conds = _parse_rule_conditions_body(body)
    rt, pat = derive_rule_type_and_pattern(conds)
    cj = conditions_to_json(conds)

    row.category_id = body.category_id
    row.category_missing = False
    row.rule_type = rt
    row.pattern = (pat or "")[:512]
    row.conditions_json = cj
    row.applies_to_household = body.applies_to_household
    if "display_name_override" in body.model_fields_set:
        ovr = (body.display_name_override or "").strip()
        row.display_name_override = ovr if ovr else None
    if "normalize_dot_space" in body.model_fields_set:
        row.normalize_dot_space = bool(body.normalize_dot_space)

    n_updated = 0
    overwrite_candidates: list[CategoryRuleOverwriteCandidate] = []
    overwrite_truncated = False
    if body.apply_to_uncategorized:
        n_updated = await apply_category_rules_to_uncategorized(session, household_id)
        rows, overwrite_truncated = await list_category_rule_overwrite_candidates(
            session,
            user,
            household_id,
        )
        overwrite_candidates = [
            CategoryRuleOverwriteCandidate(
                transaction_id=r.transaction_id,
                bank_account_id=r.bank_account_id,
                booking_date=r.booking_date,
                amount=r.amount,
                currency=r.currency,
                description=r.description,
                counterparty=r.counterparty,
                current_category_id=r.current_category_id,
                current_category_name=r.current_category_name,
                suggested_category_id=r.suggested_category_id,
                suggested_category_name=r.suggested_category_name,
            )
            for r in rows
        ]

    await session.commit()
    await session.refresh(row)
    umap = await _user_map_by_ids(session, {row.created_by_user_id} if row.created_by_user_id else set())
    base = _rule_to_out(row, umap)
    return CategoryRuleCreatedOut(
        **base.model_dump(),
        transactions_updated=n_updated,
        category_overwrite_candidates=overwrite_candidates,
        category_overwrite_truncated=overwrite_truncated,
    )


@router.delete(
    "/{household_id}/category-rules/{rule_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_category_rule(
    household_id: int,
    rule_id: int,
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
) -> None:
    if not await user_has_household(session, user.id, household_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Kein Zugriff auf diesen Haushalt.")

    row = await session.get(CategoryRule, rule_id)
    if row is None or row.household_id != household_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Regel nicht gefunden.")

    await session.delete(row)
    await session.commit()


@router.post(
    "/{household_id}/category-rules/{rule_id}/reverse",
    response_model=CategoryRuleCreatedOut,
)
async def reverse_category_rule(
    household_id: int,
    rule_id: int,
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
) -> CategoryRuleCreatedOut:
    """Setzt Kategorie auf NULL für alle Buchungen, die in diese Regel fallen."""
    if not await user_has_household(session, user.id, household_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Kein Zugriff auf diesen Haushalt.")

    row = await session.get(CategoryRule, rule_id)
    if row is None or row.household_id != household_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Regel nicht gefunden.")

    u = await session.get(User, user.id)
    if u is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Nicht angemeldet.")

    n_updated = await reverse_category_rule_assignments(
        session,
        user=u,
        household_id=household_id,
        rule=row,
    )

    await session.commit()
    await session.refresh(row)
    umap = await _user_map_by_ids(session, {row.created_by_user_id} if row.created_by_user_id else set())
    base = _rule_to_out(row, umap)
    return CategoryRuleCreatedOut(
        **base.model_dump(),
        transactions_updated=n_updated,
        category_overwrite_candidates=[],
        category_overwrite_truncated=False,
    )
