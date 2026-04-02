from __future__ import annotations

import base64
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import Response
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import CurrentUser
from app.db.models import Category, CategoryRule, Transaction, User
from app.db.session import get_session
from app.schemas.category import CategoryCreate, CategoryOut, CategoryUpdate
from app.services.access import user_has_household
from app.services.category_colors import effective_color, normalize_hex
from app.services.default_income_categories import ensure_income_category_tree
from app.services.day_zero_refresh import refresh_day_zero_for_household

router = APIRouter(prefix="/households", tags=["categories"])


def _creator_display(row: Category, user_map: dict[int, User]) -> Optional[str]:
    if row.created_by_user_id is None:
        return None
    u = user_map.get(row.created_by_user_id)
    if u is None:
        return None
    dn = (u.display_name or "").strip()
    return dn if dn else (u.email or None)


async def _user_map_for_category_rows(session: AsyncSession, rows: list[Category]) -> dict[int, User]:
    ids = {c.created_by_user_id for c in rows if c.created_by_user_id is not None}
    if not ids:
        return {}
    r = await session.execute(select(User).where(User.id.in_(ids)))
    return {u.id: u for u in r.scalars().all()}


def _sibling_index_for(rows: list[Category], cat: Category) -> tuple[Optional[int], Optional[int]]:
    if cat.parent_id is None:
        return None, None
    sibs = sorted((r for r in rows if r.parent_id == cat.parent_id), key=lambda r: r.id)
    for i, r in enumerate(sibs):
        if r.id == cat.id:
            return i, len(sibs)
    return 0, max(1, len(sibs))


def _row_to_out(
    row: Category,
    *,
    parent_hex: Optional[str],
    children_out: list[CategoryOut],
    user_map: dict[int, User],
    auto_sibling_index: Optional[int] = None,
    auto_sibling_count: Optional[int] = None,
) -> CategoryOut:
    is_child = row.parent_id is not None
    eff = effective_color(
        parent_color_hex=parent_hex,
        own_color_hex=row.color_hex,
        is_child=is_child,
        auto_sibling_index=auto_sibling_index,
        auto_sibling_count=auto_sibling_count,
    )
    return CategoryOut(
        id=row.id,
        household_id=row.household_id,
        name=row.name,
        parent_id=row.parent_id,
        color_hex=row.color_hex,
        effective_color_hex=eff,
        icon_emoji=row.icon_emoji,
        image_mime=row.image_mime,
        has_image=bool(row.image_base64 and row.image_mime),
        created_by_user_id=row.created_by_user_id,
        created_by_display=_creator_display(row, user_map),
        children=children_out,
    )


async def _build_tree(
    session: AsyncSession,
    household_id: int,
) -> list[CategoryOut]:
    r = await session.execute(
        select(Category).where(Category.household_id == household_id).order_by(Category.id)
    )
    rows = list(r.scalars().all())
    user_map = await _user_map_for_category_rows(session, rows)
    by_parent: dict[Optional[int], list[Category]] = {}
    for c in rows:
        by_parent.setdefault(c.parent_id, []).append(c)

    def build_node(row: Category) -> CategoryOut:
        parent_color = None
        s_idx: Optional[int] = None
        s_n: Optional[int] = None
        if row.parent_id is not None:
            pr = next((x for x in rows if x.id == row.parent_id), None)
            if pr:
                parent_color = pr.color_hex or normalize_hex(None)
            s_idx, s_n = _sibling_index_for(rows, row)
        subs = sorted(by_parent.get(row.id, []), key=lambda r: r.id)
        child_out = [build_node(ch) for ch in subs]
        return _row_to_out(
            row,
            parent_hex=parent_color if row.parent_id else None,
            children_out=child_out,
            user_map=user_map,
            auto_sibling_index=s_idx,
            auto_sibling_count=s_n,
        )

    roots = by_parent.get(None, [])
    return [build_node(root) for root in roots]


def _parent_hex_for_child(rows: list[Category], child: Category) -> Optional[str]:
    if child.parent_id is None:
        return None
    pr = next((x for x in rows if x.id == child.parent_id), None)
    if pr is None:
        return None
    return normalize_hex(pr.color_hex)


@router.get("/{household_id}/categories", response_model=list[CategoryOut])
async def list_categories(
    household_id: int,
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
) -> list[CategoryOut]:
    if not await user_has_household(session, user.id, household_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Kein Zugriff auf diesen Haushalt.")
    await ensure_income_category_tree(session, household_id, created_by_user_id=user.id)
    await session.commit()
    return await _build_tree(session, household_id)


@router.post("/{household_id}/categories", response_model=CategoryOut, status_code=status.HTTP_201_CREATED)
async def create_category(
    household_id: int,
    body: CategoryCreate,
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
) -> CategoryOut:
    if not await user_has_household(session, user.id, household_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Kein Zugriff auf diesen Haushalt.")

    parent: Category | None = None
    if body.parent_id is not None:
        parent = await session.get(Category, body.parent_id)
        if parent is None or parent.household_id != household_id:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Ungültige Hauptkategorie.")
        if parent.parent_id is not None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Nur eine Ebene: Unterkategorien dürfen keine Kinder haben.")
        color_val = body.color_hex
    else:
        if not body.color_hex:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Hauptkategorien brauchen color_hex (#RRGGBB).")
        color_val = body.color_hex

    if body.image_base64 and not body.image_mime:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Bild: image_mime angeben (z. B. image/png).")
    if body.image_mime and not body.image_base64:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Bild: image_base64 angeben.")

    row = Category(
        household_id=household_id,
        name=body.name.strip(),
        parent_id=body.parent_id,
        color_hex=color_val,
        icon_emoji=body.icon_emoji,
        image_mime=body.image_mime,
        image_base64=body.image_base64,
        created_by_user_id=user.id,
    )
    session.add(row)
    await session.flush()

    if body.parent_id is None:
        sonst = Category(
            household_id=household_id,
            name="Sonstiges",
            parent_id=row.id,
            color_hex=None,
            icon_emoji=None,
            image_mime=None,
            image_base64=None,
            created_by_user_id=user.id,
        )
        session.add(sonst)

    await session.commit()
    await session.refresh(row)

    r = await session.execute(select(Category).where(Category.household_id == household_id))
    all_rows = list(r.scalars().all())
    user_map = await _user_map_for_category_rows(session, all_rows)
    ph = _parent_hex_for_child(all_rows, row)
    si, sn = _sibling_index_for(all_rows, row)

    if body.parent_id is None:
        subs = sorted([x for x in all_rows if x.parent_id == row.id], key=lambda r: r.id)
        phex = row.color_hex or normalize_hex(None)
        child_out = [
            _row_to_out(
                ch,
                parent_hex=phex,
                children_out=[],
                user_map=user_map,
                auto_sibling_index=i,
                auto_sibling_count=len(subs),
            )
            for i, ch in enumerate(subs)
        ]
        return _row_to_out(
            row,
            parent_hex=None,
            children_out=child_out,
            user_map=user_map,
            auto_sibling_index=None,
            auto_sibling_count=None,
        )

    return _row_to_out(
        row,
        parent_hex=ph,
        children_out=[],
        user_map=user_map,
        auto_sibling_index=si,
        auto_sibling_count=sn,
    )


@router.patch("/{household_id}/categories/{category_id}", response_model=CategoryOut)
async def update_category(
    household_id: int,
    category_id: int,
    body: CategoryUpdate,
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
) -> CategoryOut:
    if not await user_has_household(session, user.id, household_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Kein Zugriff auf diesen Haushalt.")
    row = await session.get(Category, category_id)
    if row is None or row.household_id != household_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Kategorie nicht gefunden.")

    data = body.model_dump(exclude_unset=True)
    if "clear_image" in data:
        data.pop("clear_image")
    if body.clear_image:
        row.image_mime = None
        row.image_base64 = None
    if "name" in data and data["name"] is not None:
        row.name = str(data["name"]).strip()
    if "color_hex" in body.model_fields_set:
        if row.parent_id is None:
            if body.color_hex is None:
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Hauptkategorie braucht eine Farbe.")
            row.color_hex = body.color_hex
        else:
            row.color_hex = body.color_hex
    if "icon_emoji" in body.model_fields_set:
        row.icon_emoji = body.icon_emoji
    if "image_mime" in body.model_fields_set and not body.clear_image:
        row.image_mime = body.image_mime
    if "image_base64" in body.model_fields_set and not body.clear_image:
        row.image_base64 = body.image_base64
    if body.image_base64 and not body.clear_image and body.image_mime is None and row.image_mime is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Bild: image_mime angeben.")

    await session.commit()
    await session.refresh(row)
    r = await session.execute(select(Category).where(Category.household_id == household_id))
    all_rows = list(r.scalars().all())
    user_map = await _user_map_for_category_rows(session, all_rows)
    ph = _parent_hex_for_child(all_rows, row)
    subs = sorted([x for x in all_rows if x.parent_id == row.id], key=lambda r: r.id)
    phex = row.color_hex or normalize_hex(None)
    child_out = [
        _row_to_out(
            ch,
            parent_hex=phex,
            children_out=[],
            user_map=user_map,
            auto_sibling_index=i,
            auto_sibling_count=len(subs),
        )
        for i, ch in enumerate(subs)
    ]
    si, sn = _sibling_index_for(all_rows, row)
    return _row_to_out(
        row,
        parent_hex=ph,
        children_out=child_out,
        user_map=user_map,
        auto_sibling_index=si,
        auto_sibling_count=sn,
    )


@router.delete("/{household_id}/categories/{category_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_category(
    household_id: int,
    category_id: int,
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
) -> None:
    if not await user_has_household(session, user.id, household_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Kein Zugriff auf diesen Haushalt.")
    row = await session.get(Category, category_id)
    if row is None or row.household_id != household_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Kategorie nicht gefunden.")

    r_sub = await session.execute(select(Category).where(Category.parent_id == category_id))
    subs = list(r_sub.scalars().all())
    clear_ids = [category_id] + [s.id for s in subs]
    await session.execute(
        update(CategoryRule)
        .where(CategoryRule.category_id.in_(clear_ids))
        .values(category_id=None, category_missing=True),
    )
    await session.execute(update(Transaction).where(Transaction.category_id.in_(clear_ids)).values(category_id=None))
    await refresh_day_zero_for_household(session, household_id)
    for sub in subs:
        await session.delete(sub)
    await session.delete(row)
    await session.commit()


@router.get("/{household_id}/categories/{category_id}/image")
async def get_category_image(
    household_id: int,
    category_id: int,
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
):
    if not await user_has_household(session, user.id, household_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Kein Zugriff auf diesen Haushalt.")
    row = await session.get(Category, category_id)
    if row is None or row.household_id != household_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Kategorie nicht gefunden.")
    if not row.image_base64 or not row.image_mime:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Kein Bild.")
    raw = base64.b64decode(row.image_base64)
    return Response(content=raw, media_type=row.image_mime)
