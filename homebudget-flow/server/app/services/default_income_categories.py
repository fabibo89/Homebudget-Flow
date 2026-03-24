"""Standard-Hauptkategorie Geldeingang mit Unterkategorien Gehalt und Sonstiges."""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Category

INCOME_ROOT_NAME = "Geldeingang"
INCOME_SUB_GEHALT = "Gehalt"
INCOME_SUB_SONST = "Sonstiges"
INCOME_ROOT_COLOR = "#16a34a"


async def _load_income_root(session: AsyncSession, household_id: int) -> Category | None:
    r = await session.execute(
        select(Category)
        .where(
            Category.household_id == household_id,
            Category.parent_id.is_(None),
            Category.name == INCOME_ROOT_NAME,
        )
        .order_by(Category.id.asc())
        .limit(1),
    )
    return r.scalar_one_or_none()


async def ensure_income_category_tree(
    session: AsyncSession,
    household_id: int,
    *,
    created_by_user_id: int | None,
) -> None:
    """Legt Geldeingang → Gehalt & Sonstiges an, falls noch nicht vorhanden.

    Widerstandsfähig gegen parallele Requests (Savepoint + IntegrityError, siehe Unique-Index in init_db).
    """
    root = await _load_income_root(session, household_id)
    if root is None:
        candidate = Category(
            household_id=household_id,
            name=INCOME_ROOT_NAME,
            parent_id=None,
            color_hex=INCOME_ROOT_COLOR,
            icon_emoji=None,
            image_mime=None,
            image_base64=None,
            created_by_user_id=created_by_user_id,
        )
        async with session.begin_nested():
            session.add(candidate)
            try:
                await session.flush()
            except IntegrityError:
                pass
        root = await _load_income_root(session, household_id)
    if root is None:
        return

    for sub_name in (INCOME_SUB_GEHALT, INCOME_SUB_SONST):
        ex = await session.scalar(
            select(Category.id)
            .where(
                Category.parent_id == root.id,
                Category.name == sub_name,
            )
            .limit(1),
        )
        if ex is not None:
            continue
        sub = Category(
            household_id=household_id,
            name=sub_name,
            parent_id=root.id,
            color_hex=None,
            icon_emoji=None,
            image_mime=None,
            image_base64=None,
            created_by_user_id=created_by_user_id,
        )
        async with session.begin_nested():
            session.add(sub)
            try:
                await session.flush()
            except IntegrityError:
                pass

    await session.flush()


async def get_gehalt_category_id(session: AsyncSession, household_id: int) -> int | None:
    root_id = await session.scalar(
        select(Category.id)
        .where(
            Category.household_id == household_id,
            Category.parent_id.is_(None),
            Category.name == INCOME_ROOT_NAME,
        )
        .order_by(Category.id.asc())
        .limit(1),
    )
    if root_id is None:
        return None
    return await session.scalar(
        select(Category.id).where(
            Category.household_id == household_id,
            Category.parent_id == root_id,
            Category.name == INCOME_SUB_GEHALT,
        ),
    )


def income_gehalt_rule_warnings(rules: list, gehalt_category_id: int | None) -> list[str]:
    if gehalt_category_id is None:
        return []
    if not any(getattr(r, "category_id", None) == gehalt_category_id for r in rules):
        return [
            "Es gibt keine Zuordnungsregel für die Unterkategorie „Gehalt“ unter „Geldeingang“. "
            "Ohne solche Regel werden Gehaltseingänge nicht gezielt automatisch erkannt.",
        ]
    return []
