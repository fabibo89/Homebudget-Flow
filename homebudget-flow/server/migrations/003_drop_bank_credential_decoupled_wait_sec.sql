-- Spalte `decoupled_wait_sec` aus `bank_credentials` entfernen.
-- Decoupled-Wartezeit nur noch optional über Umgebungsvariable FINTS_DECOUPLED_WAIT_SEC (Server-.env).

-- PostgreSQL
ALTER TABLE bank_credentials DROP COLUMN IF EXISTS decoupled_wait_sec;

-- SQLite (ab 3.35.0)
-- ALTER TABLE bank_credentials DROP COLUMN decoupled_wait_sec;
