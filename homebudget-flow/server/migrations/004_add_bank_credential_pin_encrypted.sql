-- Verschlüsselte FinTS-PIN (Fernet) in `bank_credentials`.

-- PostgreSQL
ALTER TABLE bank_credentials ADD COLUMN IF NOT EXISTS pin_encrypted TEXT NOT NULL DEFAULT '';

-- SQLite
-- ALTER TABLE bank_credentials ADD COLUMN pin_encrypted TEXT NOT NULL DEFAULT '';
