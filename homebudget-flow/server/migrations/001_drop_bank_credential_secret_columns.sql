-- Bestehende Installationen: alte Spalten für PIN/TAN/Product-ID aus `bank_credentials` entfernen.
-- Vorher Backup der Datenbank anlegen.

-- PostgreSQL
ALTER TABLE bank_credentials DROP COLUMN IF EXISTS pin_encrypted;
ALTER TABLE bank_credentials DROP COLUMN IF EXISTS fints_tan_encrypted;
ALTER TABLE bank_credentials DROP COLUMN IF EXISTS fints_product_id;

-- SQLite (ab 3.35.0; eine Zeile pro Spalte)
-- ALTER TABLE bank_credentials DROP COLUMN pin_encrypted;
-- ALTER TABLE bank_credentials DROP COLUMN fints_tan_encrypted;
-- ALTER TABLE bank_credentials DROP COLUMN fints_product_id;
