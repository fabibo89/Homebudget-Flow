-- SEPA-Stammdaten (IBAN/BIC/Kontonummer) am FinTS-Zugang, z. B. aus erfolgreichem Konten-Test.

-- PostgreSQL
ALTER TABLE bank_credentials ADD COLUMN IF NOT EXISTS sepa_iban VARCHAR(34) NOT NULL DEFAULT '';
ALTER TABLE bank_credentials ADD COLUMN IF NOT EXISTS sepa_bic VARCHAR(11) NOT NULL DEFAULT '';
ALTER TABLE bank_credentials ADD COLUMN IF NOT EXISTS sepa_accountnumber VARCHAR(32) NOT NULL DEFAULT '';

-- SQLite
-- ALTER TABLE bank_credentials ADD COLUMN sepa_iban VARCHAR(34) NOT NULL DEFAULT '';
-- ALTER TABLE bank_credentials ADD COLUMN sepa_bic VARCHAR(11) NOT NULL DEFAULT '';
-- ALTER TABLE bank_credentials ADD COLUMN sepa_accountnumber VARCHAR(32) NOT NULL DEFAULT '';
