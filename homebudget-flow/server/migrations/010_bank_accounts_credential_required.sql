-- Jedes Bankkonto braucht einen FinTS-Zugang (kein Abruf ohne Login).
-- Konten ohne credential_id entfernen (Altbestand); sonst Migration anpassen.
-- Manuell ausführen, z. B.:
--   docker compose -f docker-compose.yml -f docker-compose.dev.yml exec -T db psql -U hb -d homebudget -f - < server/migrations/010_bank_accounts_credential_required.sql

DELETE FROM bank_accounts WHERE credential_id IS NULL;

ALTER TABLE bank_accounts DROP CONSTRAINT IF EXISTS bank_accounts_credential_id_fkey;

ALTER TABLE bank_accounts ALTER COLUMN credential_id SET NOT NULL;

ALTER TABLE bank_accounts
  ADD CONSTRAINT bank_accounts_credential_id_fkey
  FOREIGN KEY (credential_id) REFERENCES bank_credentials(id) ON DELETE RESTRICT;
