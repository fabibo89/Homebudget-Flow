-- Historische Saldo-Stände je erfolgreichem Abruf (Sync)
--   docker compose exec -T db psql -U hb -d homebudget -f - < server/migrations/014_bank_account_balance_snapshots.sql

CREATE TABLE IF NOT EXISTS bank_account_balance_snapshots (
    id SERIAL PRIMARY KEY,
    bank_account_id INTEGER NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,
    balance NUMERIC(18, 2) NOT NULL,
    currency VARCHAR(8) NOT NULL,
    recorded_at TIMESTAMP WITHOUT TIME ZONE NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_bank_account_balance_snapshots_account_recorded
    ON bank_account_balance_snapshots (bank_account_id, recorded_at DESC);
