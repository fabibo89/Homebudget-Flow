-- Spalte `label` entfernen; Unique-Key nur noch (user_id, provider).
-- Vorher Backup. Bei mehreren Zeilen pro (user_id, provider) zuerst Duplikate bereinigen.

-- PostgreSQL
ALTER TABLE bank_credentials DROP CONSTRAINT IF EXISTS uq_cred_user_provider_label;
ALTER TABLE bank_credentials DROP CONSTRAINT IF EXISTS uq_cred_user_provider;
ALTER TABLE bank_credentials DROP COLUMN IF EXISTS label;
ALTER TABLE bank_credentials ADD CONSTRAINT uq_cred_user_provider UNIQUE (user_id, provider);

-- SQLite (ab 3.35.0 für DROP COLUMN; Unique-Index ggf. manuell neu anlegen)
-- DROP INDEX IF EXISTS ix_bank_credentials_user_id;  -- nur falls nötig
-- ALTER TABLE bank_credentials DROP COLUMN label;
-- CREATE UNIQUE INDEX uq_cred_user_provider ON bank_credentials (user_id, provider);
