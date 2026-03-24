-- IBAN/BIC/Kontonummer am FinTS-Zugang entfernt (liegen nur noch an bank_accounts).
-- Manuell auf der DB ausführen, z. B.:
--   docker compose exec -T db psql -U hb -d homebudget -f - < server/migrations/007_drop_bank_credential_sepa.sql

ALTER TABLE bank_credentials DROP COLUMN IF EXISTS sepa_iban;
ALTER TABLE bank_credentials DROP COLUMN IF EXISTS sepa_bic;
ALTER TABLE bank_credentials DROP COLUMN IF EXISTS sepa_accountnumber;
