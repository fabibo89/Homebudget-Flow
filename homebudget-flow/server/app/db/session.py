from collections.abc import AsyncGenerator
from decimal import Decimal

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.config import settings
from app.db.base import Base
from app.services.transaction_external_id import compute_stable_transaction_external_id

engine = create_async_engine(
    settings.database_url,
    echo=False,
)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)


async def _ensure_users_all_household_column(conn) -> None:
    """ORM-Spalte nachträglich: create_all legt keine neuen Spalten auf bestehenden Tabellen an."""
    url = settings.database_url.lower()
    if "sqlite" in url:
        r = await conn.execute(text("PRAGMA table_info(users)"))
        cols = [row[1] for row in r.fetchall()]
        if cols and "all_household_transactions" not in cols:
            await conn.execute(
                text(
                    "ALTER TABLE users ADD COLUMN all_household_transactions BOOLEAN NOT NULL DEFAULT 0",
                ),
            )
        return
    if "postgresql" in url:
        await conn.execute(
            text(
                "ALTER TABLE users ADD COLUMN IF NOT EXISTS all_household_transactions "
                "BOOLEAN NOT NULL DEFAULT FALSE",
            ),
        )


async def _ensure_category_rules_created_by_user_id(conn) -> None:
    """Regel-Ersteller (Nutzer-ID); Legacy-Zeilen bleiben NULL."""
    url = settings.database_url.lower()
    if "sqlite" in url:
        r = await conn.execute(text("PRAGMA table_info(category_rules)"))
        cols = [row[1] for row in r.fetchall()]
        if cols and "created_by_user_id" not in cols:
            await conn.execute(
                text("ALTER TABLE category_rules ADD COLUMN created_by_user_id INTEGER REFERENCES users(id)"),
            )
        return
    if "postgresql" in url:
        await conn.execute(
            text(
                "ALTER TABLE category_rules ADD COLUMN IF NOT EXISTS created_by_user_id INTEGER "
                "REFERENCES users(id) ON DELETE SET NULL",
            ),
        )


async def _ensure_category_rules_applies_to_household(conn) -> None:
    """Geltungsbereich der Regel (Haushalt vs. Konten des Erstellers)."""
    url = settings.database_url.lower()
    if "sqlite" in url:
        r = await conn.execute(text("PRAGMA table_info(category_rules)"))
        cols = [row[1] for row in r.fetchall()]
        if cols and "applies_to_household" not in cols:
            await conn.execute(
                text("ALTER TABLE category_rules ADD COLUMN applies_to_household BOOLEAN NOT NULL DEFAULT 1"),
            )
        return
    if "postgresql" in url:
        await conn.execute(
            text(
                "ALTER TABLE category_rules ADD COLUMN IF NOT EXISTS applies_to_household "
                "BOOLEAN NOT NULL DEFAULT TRUE",
            ),
        )


async def _ensure_bank_credentials_fints_verification(conn) -> None:
    """FinTS-Verifikationsstatus je Zugang (Legacy-Zeilen: verifiziert = ok)."""
    url = settings.database_url.lower()
    if "sqlite" in url:
        r = await conn.execute(text("PRAGMA table_info(bank_credentials)"))
        cols = [row[1] for row in r.fetchall()]
        if not cols:
            return
        if "fints_verified_ok" not in cols:
            await conn.execute(
                text("ALTER TABLE bank_credentials ADD COLUMN fints_verified_ok BOOLEAN NOT NULL DEFAULT 1"),
            )
        r2 = await conn.execute(text("PRAGMA table_info(bank_credentials)"))
        cols2 = [row[1] for row in r2.fetchall()]
        if cols2 and "fints_verification_message" not in cols2:
            await conn.execute(
                text("ALTER TABLE bank_credentials ADD COLUMN fints_verification_message TEXT NOT NULL DEFAULT ''"),
            )
        return
    if "postgresql" in url:
        await conn.execute(
            text(
                "ALTER TABLE bank_credentials ADD COLUMN IF NOT EXISTS fints_verified_ok "
                "BOOLEAN NOT NULL DEFAULT TRUE",
            ),
        )
        await conn.execute(
            text(
                "ALTER TABLE bank_credentials ADD COLUMN IF NOT EXISTS fints_verification_message "
                "TEXT NOT NULL DEFAULT ''",
            ),
        )


async def _ensure_bank_accounts_last_salary_cache(conn) -> None:
    """Cache-Spalten für letzte Gehalt-Buchung (Standardkategorie)."""
    url = settings.database_url.lower()
    if "sqlite" in url:
        r = await conn.execute(text("PRAGMA table_info(bank_accounts)"))
        cols = [row[1] for row in r.fetchall()]
        if cols and "last_salary_booking_date" not in cols:
            await conn.execute(text("ALTER TABLE bank_accounts ADD COLUMN last_salary_booking_date DATE"))
        if cols and "last_salary_amount" not in cols:
            await conn.execute(text("ALTER TABLE bank_accounts ADD COLUMN last_salary_amount NUMERIC(18, 2)"))
        return
    if "postgresql" in url:
        await conn.execute(
            text("ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS last_salary_booking_date DATE"),
        )
        await conn.execute(
            text(
                "ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS last_salary_amount NUMERIC(18, 2)",
            ),
        )


async def _ensure_category_rules_conditions_json(conn) -> None:
    """JSON-Liste der Regelbedingungen (komponierbar); Legacy-Zeilen haben NULL."""
    url = settings.database_url.lower()
    if "sqlite" in url:
        r = await conn.execute(text("PRAGMA table_info(category_rules)"))
        cols = [row[1] for row in r.fetchall()]
        if cols and "conditions_json" not in cols:
            await conn.execute(text("ALTER TABLE category_rules ADD COLUMN conditions_json TEXT"))
        return
    if "postgresql" in url:
        await conn.execute(
            text("ALTER TABLE category_rules ADD COLUMN IF NOT EXISTS conditions_json TEXT"),
        )


async def _ensure_categories_created_by_user_id(conn) -> None:
    """Kategorie-Ersteller (Nutzer-ID); nachträglich für bestehende DBs."""
    url = settings.database_url.lower()
    if "sqlite" in url:
        r = await conn.execute(text("PRAGMA table_info(categories)"))
        cols = [row[1] for row in r.fetchall()]
        if cols and "created_by_user_id" not in cols:
            await conn.execute(
                text("ALTER TABLE categories ADD COLUMN created_by_user_id INTEGER REFERENCES users(id)"),
            )
        return
    if "postgresql" in url:
        await conn.execute(
            text(
                "ALTER TABLE categories ADD COLUMN IF NOT EXISTS created_by_user_id INTEGER "
                "REFERENCES users(id) ON DELETE SET NULL",
            ),
        )


async def _dedupe_duplicate_root_categories(conn) -> None:
    """Mehrfach gleichnamige Hauptkategorien pro Haushalt zusammenführen (Race bei parallelen Requests / Legacy)."""
    r = await conn.execute(
        text(
            "SELECT household_id, name FROM categories WHERE parent_id IS NULL "
            "GROUP BY household_id, name HAVING COUNT(*) > 1",
        ),
    )
    for hh, name in r.fetchall():
        r2 = await conn.execute(
            text(
                "SELECT id FROM categories WHERE household_id = :hh AND parent_id IS NULL AND name = :n "
                "ORDER BY id ASC",
            ),
            {"hh": hh, "n": name},
        )
        ids = [row[0] for row in r2.fetchall()]
        if len(ids) < 2:
            continue
        keep_id = ids[0]
        for dup_id in ids[1:]:
            await _reparent_merge_subcategories_under_parent(conn, keep_parent_id=keep_id, drop_parent_id=dup_id)
            await conn.execute(text("DELETE FROM categories WHERE id = :id"), {"id": dup_id})


async def _reparent_merge_subcategories_under_parent(conn, *, keep_parent_id: int, drop_parent_id: int) -> None:
    rch = await conn.execute(
        text("SELECT id, name FROM categories WHERE parent_id = :pid"),
        {"pid": drop_parent_id},
    )
    for cid, cname in rch.fetchall():
        rex = await conn.execute(
            text("SELECT id FROM categories WHERE parent_id = :keep AND name = :name"),
            {"keep": keep_parent_id, "name": cname},
        )
        twin = rex.fetchone()
        if twin is None:
            await conn.execute(
                text("UPDATE categories SET parent_id = :keep WHERE id = :cid"),
                {"keep": keep_parent_id, "cid": cid},
            )
        else:
            target_id = twin[0]
            await conn.execute(
                text("UPDATE transactions SET category_id = :t WHERE category_id = :c"),
                {"t": target_id, "c": cid},
            )
            await conn.execute(
                text("UPDATE category_rules SET category_id = :t WHERE category_id = :c"),
                {"t": target_id, "c": cid},
            )
            await conn.execute(text("DELETE FROM categories WHERE id = :cid"), {"cid": cid})


async def _ensure_categories_unique_root_name_per_household(conn) -> None:
    """Pro Haushalt nur eine Hauptkategorie je Name (verhindert parallele ensure_income_category_tree)."""
    url = settings.database_url.lower()
    if "sqlite" not in url and "postgresql" not in url:
        return
    stmt = (
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_categories_household_root_name "
        "ON categories (household_id, name) WHERE parent_id IS NULL"
    )
    try:
        await conn.execute(text(stmt))
    except Exception:
        pass


async def _ensure_categories_unique_sub_name_under_parent(conn) -> None:
    """Gleicher Unterkategorie-Name nur einmal unter derselben Hauptkategorie."""
    url = settings.database_url.lower()
    if "sqlite" not in url and "postgresql" not in url:
        return
    stmt = (
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_categories_household_parent_name "
        "ON categories (household_id, parent_id, name) WHERE parent_id IS NOT NULL"
    )
    try:
        await conn.execute(text(stmt))
    except Exception:
        pass


_TXV1_PREFIX = "txv1|"


async def _migrate_transaction_external_ids_to_txv1(conn) -> None:
    """Alte Schlüssel (IBAN|POS, h|…) → stabile txv1|-Hashes; einmalig pro nicht-txv1-Zeile."""
    r = await conn.execute(
        text("SELECT 1 FROM transactions WHERE external_id NOT LIKE :pfx LIMIT 1"),
        {"pfx": f"{_TXV1_PREFIX}%"},
    )
    if r.first() is None:
        return

    await conn.execute(
        text(
            "UPDATE transactions SET external_id = '__migr_tmp_' || CAST(id AS TEXT) "
            "WHERE external_id NOT LIKE :pfx"
        ),
        {"pfx": f"{_TXV1_PREFIX}%"},
    )

    r2 = await conn.execute(
        text(
            "SELECT t.id, t.bank_account_id, t.booking_date, t.value_date, t.amount, "
            "t.description, t.counterparty, b.iban "
            "FROM transactions t "
            "JOIN bank_accounts b ON b.id = t.bank_account_id "
            "WHERE t.external_id LIKE '__migr_tmp_%'"
        )
    )
    rows = r2.mappings().all()
    claimed: dict[tuple[int, str], int] = {}
    updates: list[tuple[int, str]] = []
    for row in sorted(rows, key=lambda x: int(x["id"])):
        amount = row["amount"]
        if not isinstance(amount, Decimal):
            amount = Decimal(str(amount))
        ext = compute_stable_transaction_external_id(
            str(row["iban"]),
            row["booking_date"],
            row["value_date"],
            amount,
            str(row["description"] or ""),
            str(row["counterparty"]) if row["counterparty"] is not None else None,
        )
        acc_id = int(row["bank_account_id"])
        key = (acc_id, ext)
        if key in claimed and claimed[key] != row["id"]:
            ext = f"{ext}#{int(row['id'])}"
        else:
            claimed[key] = int(row["id"])
        updates.append((int(row["id"]), ext))

    for tid, ext in updates:
        await conn.execute(
            text("UPDATE transactions SET external_id = :ext WHERE id = :id"),
            {"ext": ext, "id": tid},
        )


async def init_db() -> None:
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await _ensure_users_all_household_column(conn)
        await _ensure_categories_created_by_user_id(conn)
        await _dedupe_duplicate_root_categories(conn)
        await _ensure_categories_unique_root_name_per_household(conn)
        await _ensure_categories_unique_sub_name_under_parent(conn)
        await _ensure_category_rules_conditions_json(conn)
        await _ensure_category_rules_created_by_user_id(conn)
        await _ensure_category_rules_applies_to_household(conn)
        await _ensure_bank_accounts_last_salary_cache(conn)
        await _ensure_bank_credentials_fints_verification(conn)
        await _migrate_transaction_external_ids_to_txv1(conn)


async def get_session() -> AsyncGenerator[AsyncSession, None]:
    async with SessionLocal() as session:
        yield session
