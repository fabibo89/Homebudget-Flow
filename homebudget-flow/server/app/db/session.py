import re
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


async def _migrate_bank_accounts_day_zero_date(conn) -> None:
    """Spalte ``day_zero_date``; Migration von ``last_salary_*``; alte Spalten entfernen (PostgreSQL)."""
    url = settings.database_url.lower()
    if "sqlite" in url:
        r = await conn.execute(text("PRAGMA table_info(bank_accounts)"))
        cols = [row[1] for row in r.fetchall()]
        if cols and "day_zero_date" not in cols:
            await conn.execute(text("ALTER TABLE bank_accounts ADD COLUMN day_zero_date DATE"))
        r2 = await conn.execute(text("PRAGMA table_info(bank_accounts)"))
        cols2 = [row[1] for row in r2.fetchall()]
        if "last_salary_booking_date" in cols2:
            await conn.execute(
                text(
                    "UPDATE bank_accounts SET day_zero_date = last_salary_booking_date "
                    "WHERE day_zero_date IS NULL AND last_salary_booking_date IS NOT NULL",
                ),
            )
            try:
                await conn.execute(text("ALTER TABLE bank_accounts DROP COLUMN last_salary_booking_date"))
            except Exception:
                pass
            try:
                await conn.execute(text("ALTER TABLE bank_accounts DROP COLUMN last_salary_amount"))
            except Exception:
                pass
        return
    if "postgresql" in url:
        await conn.execute(text("ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS day_zero_date DATE"))
        # Backfill nur, wenn Legacy-Spalte noch existiert (sonst schlägt UPDATE fehl).
        r_chk = await conn.execute(
            text(
                "SELECT EXISTS (SELECT 1 FROM information_schema.columns "
                "WHERE table_schema = current_schema() AND table_name = 'bank_accounts' "
                "AND column_name = 'last_salary_booking_date')",
            ),
        )
        if r_chk.scalar():
            await conn.execute(
                text(
                    "UPDATE bank_accounts SET day_zero_date = last_salary_booking_date "
                    "WHERE day_zero_date IS NULL AND last_salary_booking_date IS NOT NULL",
                ),
            )
        await conn.execute(text("ALTER TABLE bank_accounts DROP COLUMN IF EXISTS last_salary_booking_date"))
        await conn.execute(text("ALTER TABLE bank_accounts DROP COLUMN IF EXISTS last_salary_amount"))


async def _ensure_bank_accounts_tag_zero_rule(conn) -> None:
    """Konfiguration der „Tag Null“-Regel pro Bankkonto (optional)."""
    url = settings.database_url.lower()
    if "sqlite" in url:
        r = await conn.execute(text("PRAGMA table_info(bank_accounts)"))
        cols = [row[1] for row in r.fetchall()]
        if cols and "tag_zero_rule_category_rule_id" not in cols:
            await conn.execute(
                text(
                    "ALTER TABLE bank_accounts ADD COLUMN tag_zero_rule_category_rule_id "
                    "INTEGER REFERENCES category_rules(id)",
                ),
            )
        if cols and "tag_zero_rule_conditions_json" not in cols:
            await conn.execute(text("ALTER TABLE bank_accounts ADD COLUMN tag_zero_rule_conditions_json TEXT"))
        if cols and "tag_zero_rule_normalize_dot_space" not in cols:
            await conn.execute(
                text(
                    "ALTER TABLE bank_accounts ADD COLUMN tag_zero_rule_normalize_dot_space "
                    "BOOLEAN NOT NULL DEFAULT 0",
                ),
            )
        if cols and "tag_zero_rule_display_name_override" not in cols:
            await conn.execute(
                text(
                    "ALTER TABLE bank_accounts ADD COLUMN tag_zero_rule_display_name_override VARCHAR(512)",
                ),
            )
        return
    if "postgresql" in url:
        await conn.execute(
            text(
                "ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS tag_zero_rule_category_rule_id "
                "INTEGER REFERENCES category_rules(id) ON DELETE SET NULL",
            ),
        )
        await conn.execute(
            text(
                "ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS tag_zero_rule_conditions_json TEXT",
            ),
        )
        await conn.execute(
            text(
                "ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS tag_zero_rule_normalize_dot_space "
                "BOOLEAN NOT NULL DEFAULT FALSE",
            ),
        )
        await conn.execute(
            text(
                "ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS tag_zero_rule_display_name_override VARCHAR(512)",
            ),
        )


async def _ensure_household_contracts_bank_account_scope(conn) -> None:
    """Legacy: Verträge waren pro Haushalt; jetzt nur noch pro Bankkonto (Unique bank_account_id + signature_hash)."""
    url = settings.database_url.lower()
    if "sqlite" in url:
        r = await conn.execute(text("PRAGMA table_info(household_contracts)"))
        cols = [row[1] for row in r.fetchall()]
        if not cols:
            return
        if "household_id" not in cols:
            return
        await conn.execute(text("DROP INDEX IF EXISTS uq_hh_contract_signature"))
        try:
            await conn.execute(text("ALTER TABLE household_contracts DROP COLUMN household_id"))
        except Exception:
            return
        await conn.execute(
            text(
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_account_contract_signature "
                "ON household_contracts (bank_account_id, signature_hash)",
            ),
        )
        return
    if "postgresql" in url:
        r_chk = await conn.execute(
            text(
                "SELECT EXISTS (SELECT 1 FROM information_schema.columns "
                "WHERE table_schema = current_schema() AND table_name = 'household_contracts' "
                "AND column_name = 'household_id')",
            ),
        )
        if not r_chk.scalar():
            return
        await conn.execute(text("ALTER TABLE household_contracts DROP CONSTRAINT IF EXISTS uq_hh_contract_signature"))
        await conn.execute(
            text("ALTER TABLE household_contracts DROP CONSTRAINT IF EXISTS household_contracts_household_id_fkey"),
        )
        await conn.execute(text("ALTER TABLE household_contracts DROP COLUMN household_id"))
        await conn.execute(
            text(
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_account_contract_signature "
                "ON household_contracts (bank_account_id, signature_hash)",
            ),
        )


async def _ensure_transactions_contract_id(conn) -> None:
    """Optional: Verknüpfung Buchung → bestätigter Haushalts-Vertrag."""
    url = settings.database_url.lower()
    if "sqlite" in url:
        r = await conn.execute(text("PRAGMA table_info(transactions)"))
        cols = [row[1] for row in r.fetchall()]
        if cols and "contract_id" not in cols:
            await conn.execute(
                text(
                    "ALTER TABLE transactions ADD COLUMN contract_id INTEGER REFERENCES household_contracts(id)",
                ),
            )
        return
    if "postgresql" in url:
        await conn.execute(
            text(
                "ALTER TABLE transactions ADD COLUMN IF NOT EXISTS contract_id INTEGER "
                "REFERENCES household_contracts(id) ON DELETE SET NULL",
            ),
        )


async def _ensure_transactions_transfer_target(conn) -> None:
    """Umbuchungs-Markierung: Verweis auf Zielkonto (optional, household-intern)."""
    url = settings.database_url.lower()
    if "sqlite" in url:
        r = await conn.execute(text("PRAGMA table_info(transactions)"))
        cols = [row[1] for row in r.fetchall()]
        if cols and "transfer_target_bank_account_id" not in cols:
            await conn.execute(
                text(
                    "ALTER TABLE transactions ADD COLUMN transfer_target_bank_account_id "
                    "INTEGER REFERENCES bank_accounts(id)",
                ),
            )
        return
    if "postgresql" in url:
        await conn.execute(
            text(
                "ALTER TABLE transactions ADD COLUMN IF NOT EXISTS transfer_target_bank_account_id "
                "INTEGER REFERENCES bank_accounts(id) ON DELETE SET NULL",
            ),
        )


async def _ensure_transactions_counterparty_fields(conn) -> None:
    """Zusätzliche Gegenpartei-Felder (Name/IBAN/Partnername) getrennt speichern."""
    url = settings.database_url.lower()
    if "sqlite" in url:
        r = await conn.execute(text("PRAGMA table_info(transactions)"))
        cols = [row[1] for row in r.fetchall()]
        if cols and "counterparty_name" not in cols:
            await conn.execute(text("ALTER TABLE transactions ADD COLUMN counterparty_name VARCHAR(512)"))
        if cols and "counterparty_iban" not in cols:
            await conn.execute(text("ALTER TABLE transactions ADD COLUMN counterparty_iban VARCHAR(64)"))
        if cols and "counterparty_partner_name" not in cols:
            await conn.execute(text("ALTER TABLE transactions ADD COLUMN counterparty_partner_name VARCHAR(512)"))
        return
    if "postgresql" in url:
        await conn.execute(text("ALTER TABLE transactions ADD COLUMN IF NOT EXISTS counterparty_name VARCHAR(512)"))
        await conn.execute(text("ALTER TABLE transactions ADD COLUMN IF NOT EXISTS counterparty_iban VARCHAR(64)"))
        await conn.execute(
            text("ALTER TABLE transactions ADD COLUMN IF NOT EXISTS counterparty_partner_name VARCHAR(512)")
        )


async def _ensure_transactions_fints_raw_and_reference_fields(conn) -> None:
    """Persistiere FinTS-Rohdaten + häufige Referenzen als Spalten."""
    url = settings.database_url.lower()
    if "sqlite" in url:
        r = await conn.execute(text("PRAGMA table_info(transactions)"))
        cols = [row[1] for row in r.fetchall()]
        if cols and "counterparty_bic" not in cols:
            await conn.execute(text("ALTER TABLE transactions ADD COLUMN counterparty_bic VARCHAR(32)"))
        if cols and "raw_json" not in cols:
            await conn.execute(text("ALTER TABLE transactions ADD COLUMN raw_json TEXT NOT NULL DEFAULT '{}'"))
        if cols and "sepa_end_to_end_id" not in cols:
            await conn.execute(text("ALTER TABLE transactions ADD COLUMN sepa_end_to_end_id VARCHAR(128)"))
        if cols and "sepa_mandate_reference" not in cols:
            await conn.execute(text("ALTER TABLE transactions ADD COLUMN sepa_mandate_reference VARCHAR(128)"))
        if cols and "sepa_creditor_id" not in cols:
            await conn.execute(text("ALTER TABLE transactions ADD COLUMN sepa_creditor_id VARCHAR(64)"))
        if cols and "bank_reference" not in cols:
            await conn.execute(text("ALTER TABLE transactions ADD COLUMN bank_reference VARCHAR(128)"))
        if cols and "customer_reference" not in cols:
            await conn.execute(text("ALTER TABLE transactions ADD COLUMN customer_reference VARCHAR(128)"))
        if cols and "prima_nota" not in cols:
            await conn.execute(text("ALTER TABLE transactions ADD COLUMN prima_nota VARCHAR(64)"))
        return
    if "postgresql" in url:
        await conn.execute(text("ALTER TABLE transactions ADD COLUMN IF NOT EXISTS counterparty_bic VARCHAR(32)"))
        await conn.execute(text("ALTER TABLE transactions ADD COLUMN IF NOT EXISTS raw_json TEXT NOT NULL DEFAULT '{}'"))
        await conn.execute(text("ALTER TABLE transactions ADD COLUMN IF NOT EXISTS sepa_end_to_end_id VARCHAR(128)"))
        await conn.execute(text("ALTER TABLE transactions ADD COLUMN IF NOT EXISTS sepa_mandate_reference VARCHAR(128)"))
        await conn.execute(text("ALTER TABLE transactions ADD COLUMN IF NOT EXISTS sepa_creditor_id VARCHAR(64)"))
        await conn.execute(text("ALTER TABLE transactions ADD COLUMN IF NOT EXISTS bank_reference VARCHAR(128)"))
        await conn.execute(text("ALTER TABLE transactions ADD COLUMN IF NOT EXISTS customer_reference VARCHAR(128)"))
        await conn.execute(text("ALTER TABLE transactions ADD COLUMN IF NOT EXISTS prima_nota VARCHAR(64)"))


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


async def _ensure_earnings_documents_period_fields(conn) -> None:
    """Zeitraum-Felder (Monat/Jahr/Label) für Verdienstnachweise."""
    url = settings.database_url.lower()
    if "sqlite" in url:
        r = await conn.execute(text("PRAGMA table_info(earnings_documents)"))
        cols = [row[1] for row in r.fetchall()]
        if not cols:
            return
        if "period_year" not in cols:
            await conn.execute(text("ALTER TABLE earnings_documents ADD COLUMN period_year INTEGER"))
        if "period_month" not in cols:
            await conn.execute(text("ALTER TABLE earnings_documents ADD COLUMN period_month INTEGER"))
        if "period_label" not in cols:
            await conn.execute(text("ALTER TABLE earnings_documents ADD COLUMN period_label VARCHAR(64) NOT NULL DEFAULT ''"))
        return
    if "postgresql" in url:
        await conn.execute(text("ALTER TABLE earnings_documents ADD COLUMN IF NOT EXISTS period_year INTEGER"))
        await conn.execute(text("ALTER TABLE earnings_documents ADD COLUMN IF NOT EXISTS period_month INTEGER"))
        await conn.execute(
            text("ALTER TABLE earnings_documents ADD COLUMN IF NOT EXISTS period_label VARCHAR(64) NOT NULL DEFAULT ''"),
        )


async def _ensure_earnings_documents_owner_user(conn) -> None:
    """Verdienstnachweise gehören einem User (owner_user_id)."""
    url = settings.database_url.lower()
    if "sqlite" in url:
        r = await conn.execute(text("PRAGMA table_info(earnings_documents)"))
        cols = [row[1] for row in r.fetchall()]
        if not cols:
            return
        if "owner_user_id" not in cols:
            await conn.execute(text("ALTER TABLE earnings_documents ADD COLUMN owner_user_id INTEGER"))
        # Backfill (best effort)
        if "uploaded_by_user_id" in cols:
            await conn.execute(
                text("UPDATE earnings_documents SET owner_user_id = uploaded_by_user_id WHERE owner_user_id IS NULL"),
            )
        return
    if "postgresql" in url:
        await conn.execute(
            text("ALTER TABLE earnings_documents ADD COLUMN IF NOT EXISTS owner_user_id INTEGER"),
        )
        await conn.execute(
            text("UPDATE earnings_documents SET owner_user_id = uploaded_by_user_id WHERE owner_user_id IS NULL"),
        )


async def _ensure_bank_accounts_credential_nullable(conn) -> None:
    """Manuelle Konten ohne FinTS: ``credential_id`` NULL; FK ON DELETE SET NULL beim Löschen des Zugangs."""
    url = settings.database_url.lower()
    if "postgresql" in url:
        r_null = await conn.execute(
            text(
                "SELECT is_nullable FROM information_schema.columns "
                "WHERE table_schema = current_schema() AND table_name = 'bank_accounts' "
                "AND column_name = 'credential_id'",
            ),
        )
        row_n = r_null.fetchone()
        if row_n is None:
            return
        if str(row_n[0]).upper() == "YES":
            return
        r_fk = await conn.execute(
            text(
                "SELECT tc.constraint_name FROM information_schema.table_constraints tc "
                "JOIN information_schema.key_column_usage kcu "
                "ON tc.constraint_schema = kcu.constraint_schema "
                "AND tc.constraint_name = kcu.constraint_name "
                "WHERE tc.table_schema = current_schema() AND tc.table_name = 'bank_accounts' "
                "AND tc.constraint_type = 'FOREIGN KEY' AND kcu.column_name = 'credential_id'",
            ),
        )
        for (cname,) in r_fk.fetchall():
            await conn.execute(text(f'ALTER TABLE bank_accounts DROP CONSTRAINT "{cname}"'))
        await conn.execute(text("ALTER TABLE bank_accounts ALTER COLUMN credential_id DROP NOT NULL"))
        await conn.execute(
            text(
                "ALTER TABLE bank_accounts ADD CONSTRAINT bank_accounts_credential_id_fkey "
                "FOREIGN KEY (credential_id) REFERENCES bank_credentials(id) ON DELETE SET NULL",
            ),
        )
        return

    if "sqlite" not in url:
        return
    r_pr = await conn.execute(text("PRAGMA table_info(bank_accounts)"))
    cols = r_pr.fetchall()
    if not cols:
        return
    cred_col = next((c for c in cols if c[1] == "credential_id"), None)
    if cred_col is None:
        return
    if cred_col[3] == 0:
        return
    r_sql = await conn.execute(
        text("SELECT sql FROM sqlite_master WHERE type='table' AND name='bank_accounts'"),
    )
    row_sql = r_sql.fetchone()
    if not row_sql or not row_sql[0]:
        return
    old_sql = row_sql[0]
    new_sql = re.sub(
        r"credential_id\s+INTEGER\s+NOT\s+NULL\s+",
        "credential_id INTEGER ",
        old_sql,
        count=1,
        flags=re.IGNORECASE,
    )
    if new_sql == old_sql:
        new_sql = re.sub(
            r"\bcredential_id\b\s+INTEGER\s+NOT\s+NULL\b",
            "credential_id INTEGER",
            old_sql,
            count=1,
            flags=re.IGNORECASE,
        )
    if new_sql == old_sql:
        return
    new_sql = re.sub(
        r"REFERENCES\s+bank_credentials\s*\(\s*id\s*\)(?!\s+ON\s+DELETE)",
        "REFERENCES bank_credentials(id) ON DELETE SET NULL",
        new_sql,
        count=1,
        flags=re.IGNORECASE,
    )
    await conn.execute(text("PRAGMA foreign_keys=OFF"))
    try:
        await conn.execute(text("ALTER TABLE bank_accounts RENAME TO bank_accounts_hbtmp_cred"))
        await conn.execute(text(new_sql))
        col_names = ", ".join(f'"{c[1]}"' for c in cols)
        await conn.execute(
            text(f"INSERT INTO bank_accounts ({col_names}) SELECT {col_names} FROM bank_accounts_hbtmp_cred"),
        )
        try:
            await conn.execute(text("DELETE FROM sqlite_sequence WHERE name='bank_accounts'"))
            await conn.execute(
                text(
                    "INSERT INTO sqlite_sequence(name, seq) "
                    "SELECT 'bank_accounts', COALESCE(MAX(id), 0) FROM bank_accounts",
                ),
            )
        except Exception:
            pass
        r_idx = await conn.execute(
            text(
                "SELECT name, sql FROM sqlite_master WHERE type='index' "
                "AND tbl_name='bank_accounts_hbtmp_cred' AND sql IS NOT NULL",
            ),
        )
        for idx_name, idx_sql in r_idx.fetchall():
            if idx_name.startswith("sqlite_autoindex"):
                continue
            fixed = str(idx_sql).replace("bank_accounts_hbtmp_cred", "bank_accounts")
            try:
                await conn.execute(text(fixed))
            except Exception:
                # Index könnte bereits existieren (je nach vorherigem Schema / parallelem Init).
                pass
        await conn.execute(text("DROP TABLE bank_accounts_hbtmp_cred"))
    finally:
        await conn.execute(text("PRAGMA foreign_keys=ON"))


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


async def _sqlite_rebuild_category_rules_nullable_category(conn) -> None:
    """SQLite: category_id nullable + category_missing; Legacy-Tabellen haben oft NOT NULL auf category_id."""
    await conn.execute(
        text(
            """
            CREATE TABLE category_rules__new (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
              category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
              category_missing BOOLEAN NOT NULL DEFAULT 0,
              rule_type VARCHAR(32) NOT NULL,
              pattern VARCHAR(512) NOT NULL,
              conditions_json TEXT,
              created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
              applies_to_household BOOLEAN NOT NULL DEFAULT 1,
              created_at DATETIME
            )
            """
        ),
    )
    r = await conn.execute(text("PRAGMA table_info(category_rules)"))
    col_names = {row[1] for row in r.fetchall()}
    has_cm = "category_missing" in col_names
    if has_cm:
        await conn.execute(
            text(
                """
                INSERT INTO category_rules__new (
                  id, household_id, category_id, category_missing, rule_type, pattern,
                  conditions_json, created_by_user_id, applies_to_household, created_at
                )
                SELECT id, household_id, category_id, category_missing, rule_type, pattern,
                  conditions_json, created_by_user_id, applies_to_household, created_at
                FROM category_rules
                """
            ),
        )
    else:
        await conn.execute(
            text(
                """
                INSERT INTO category_rules__new (
                  id, household_id, category_id, category_missing, rule_type, pattern,
                  conditions_json, created_by_user_id, applies_to_household, created_at
                )
                SELECT id, household_id, category_id, 0, rule_type, pattern,
                  conditions_json, created_by_user_id, applies_to_household, created_at
                FROM category_rules
                """
            ),
        )
    await conn.execute(text("DROP TABLE category_rules"))
    await conn.execute(text("ALTER TABLE category_rules__new RENAME TO category_rules"))


async def _ensure_category_rules_missing_nullable_category(conn) -> None:
    """category_missing + nullable category_id (Regel bleibt erhalten, wenn Kategorie gelöscht wird)."""
    url = settings.database_url.lower()
    if "postgresql" in url:
        await conn.execute(
            text(
                "ALTER TABLE category_rules ADD COLUMN IF NOT EXISTS category_missing BOOLEAN NOT NULL DEFAULT FALSE",
            ),
        )
        try:
            await conn.execute(text("ALTER TABLE category_rules ALTER COLUMN category_id DROP NOT NULL"))
        except Exception:
            pass
        await conn.execute(text("ALTER TABLE category_rules DROP CONSTRAINT IF EXISTS category_rules_category_id_fkey"))
        try:
            await conn.execute(
                text(
                    "ALTER TABLE category_rules ADD CONSTRAINT category_rules_category_id_fkey "
                    "FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL",
                ),
            )
        except Exception:
            pass
        return
    if "sqlite" in url:
        r = await conn.execute(text("PRAGMA table_info(category_rules)"))
        cols = list(r.fetchall())
        if not cols:
            return
        names = {row[1] for row in cols}
        if "category_missing" not in names:
            await conn.execute(
                text("ALTER TABLE category_rules ADD COLUMN category_missing BOOLEAN NOT NULL DEFAULT 0"),
            )
        r2 = await conn.execute(text("PRAGMA table_info(category_rules)"))
        cat_notnull = 0
        for row in r2.fetchall():
            if row[1] == "category_id":
                cat_notnull = int(row[3])
                break
        if cat_notnull == 1:
            await _sqlite_rebuild_category_rules_nullable_category(conn)
        return


async def _ensure_category_rules_display_name_override(conn) -> None:
    """Optionaler Anzeigename (Override); NULL = Vorgabe aus Mustertext."""
    url = settings.database_url.lower()
    if "sqlite" in url:
        r = await conn.execute(text("PRAGMA table_info(category_rules)"))
        cols = [row[1] for row in r.fetchall()]
        if cols and "display_name_override" not in cols:
            await conn.execute(
                text("ALTER TABLE category_rules ADD COLUMN display_name_override VARCHAR(512)"),
            )
        return
    if "postgresql" in url:
        await conn.execute(
            text(
                "ALTER TABLE category_rules ADD COLUMN IF NOT EXISTS display_name_override VARCHAR(512)",
            ),
        )


async def _ensure_category_rules_normalize_dot_space(conn) -> None:
    """Optionaler Matching-Schalter: '.' und Whitespace gleich behandeln."""
    url = settings.database_url.lower()
    if "sqlite" in url:
        r = await conn.execute(text("PRAGMA table_info(category_rules)"))
        cols = [row[1] for row in r.fetchall()]
        if cols and "normalize_dot_space" not in cols:
            await conn.execute(
                text(
                    "ALTER TABLE category_rules ADD COLUMN normalize_dot_space BOOLEAN NOT NULL DEFAULT 0",
                ),
            )
        return
    if "postgresql" in url:
        await conn.execute(
            text(
                "ALTER TABLE category_rules ADD COLUMN IF NOT EXISTS normalize_dot_space "
                "BOOLEAN NOT NULL DEFAULT FALSE",
            ),
        )


async def init_db() -> None:
    async with engine.begin() as conn:
        # Wichtig: Modelle importieren, damit sie im SQLAlchemy-Metadata registriert sind
        # und create_all auch neue Tabellen anlegt.
        import app.db.models  # noqa: F401
        await conn.run_sync(Base.metadata.create_all)
        await _ensure_users_all_household_column(conn)
        await _ensure_categories_created_by_user_id(conn)
        await _dedupe_duplicate_root_categories(conn)
        await _ensure_categories_unique_root_name_per_household(conn)
        await _ensure_categories_unique_sub_name_under_parent(conn)
        await _ensure_category_rules_conditions_json(conn)
        await _ensure_category_rules_created_by_user_id(conn)
        await _ensure_category_rules_applies_to_household(conn)
        await _ensure_category_rules_missing_nullable_category(conn)
        await _ensure_category_rules_display_name_override(conn)
        await _ensure_category_rules_normalize_dot_space(conn)
        await _migrate_bank_accounts_day_zero_date(conn)
        await _ensure_bank_accounts_tag_zero_rule(conn)
        await _ensure_transactions_transfer_target(conn)
        await _ensure_transactions_contract_id(conn)
        await _ensure_household_contracts_bank_account_scope(conn)
        await _ensure_transactions_counterparty_fields(conn)
        await _ensure_transactions_fints_raw_and_reference_fields(conn)
        await _ensure_bank_credentials_fints_verification(conn)
        await _ensure_bank_accounts_credential_nullable(conn)
        await _migrate_transaction_external_ids_to_txv1(conn)
        await _ensure_earnings_documents_period_fields(conn)
        await _ensure_earnings_documents_owner_user(conn)
        # earnings_document_lines: nur "amount" (keine Zusatzspalten mehr)


async def get_session() -> AsyncGenerator[AsyncSession, None]:
    async with SessionLocal() as session:
        yield session
