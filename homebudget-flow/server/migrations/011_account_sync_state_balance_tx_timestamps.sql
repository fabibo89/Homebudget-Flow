-- getrennte Zeitstempel für Saldo- und Umsatz-Sync (jeweils Versuch und Erfolg)
-- Manuell ausführen, z. B.:
--   docker compose -f docker-compose.yml -f docker-compose.dev.yml exec -T db psql -U hb -d homebudget -f - < server/migrations/011_account_sync_state_balance_tx_timestamps.sql

ALTER TABLE account_sync_states ADD COLUMN IF NOT EXISTS balance_attempt_at TIMESTAMP WITHOUT TIME ZONE;
ALTER TABLE account_sync_states ADD COLUMN IF NOT EXISTS balance_success_at TIMESTAMP WITHOUT TIME ZONE;
ALTER TABLE account_sync_states ADD COLUMN IF NOT EXISTS transactions_attempt_at TIMESTAMP WITHOUT TIME ZONE;
ALTER TABLE account_sync_states ADD COLUMN IF NOT EXISTS transactions_success_at TIMESTAMP WITHOUT TIME ZONE;

-- Nur bei Altbestand mit last_* (frische DB aus create_all hat diese Spalten nicht)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'account_sync_states' AND column_name = 'last_attempt_at'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'account_sync_states' AND column_name = 'last_success_at'
  ) THEN
    UPDATE account_sync_states SET
      balance_attempt_at = last_attempt_at,
      balance_success_at = last_success_at,
      transactions_attempt_at = last_attempt_at,
      transactions_success_at = last_success_at
    WHERE last_attempt_at IS NOT NULL OR last_success_at IS NOT NULL;
  END IF;
END $$;

ALTER TABLE account_sync_states DROP COLUMN IF EXISTS last_attempt_at;
ALTER TABLE account_sync_states DROP COLUMN IF EXISTS last_success_at;
