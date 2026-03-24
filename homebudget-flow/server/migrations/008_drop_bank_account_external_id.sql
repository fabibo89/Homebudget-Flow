-- Bankkonto: nur noch IBAN (normalisiert), kein separates external_id.
-- Vor NOT NULL: IBAN aus external_id übernehmen, falls leer.
-- Manuell auf der DB ausführen, z. B.:
--   docker compose -f docker-compose.yml -f docker-compose.dev.yml exec -T db psql -U hb -d homebudget -f - < server/migrations/008_drop_bank_account_external_id.sql

ALTER TABLE bank_accounts DROP CONSTRAINT IF EXISTS uq_bank_provider_ext;

UPDATE bank_accounts
SET iban = UPPER(REPLACE(REPLACE(TRIM(COALESCE(iban, '')), ' ', ''), '-', ''))
WHERE iban IS NOT NULL AND TRIM(iban) <> '';

UPDATE bank_accounts
SET iban = UPPER(REPLACE(REPLACE(TRIM(external_id), ' ', ''), '-', ''))
WHERE (iban IS NULL OR TRIM(iban) = '')
  AND external_id IS NOT NULL
  AND TRIM(external_id) <> '';

ALTER TABLE bank_accounts DROP COLUMN IF EXISTS external_id;

ALTER TABLE bank_accounts ALTER COLUMN iban SET NOT NULL;

ALTER TABLE bank_accounts ADD CONSTRAINT uq_bank_provider_iban UNIQUE (provider, iban);
