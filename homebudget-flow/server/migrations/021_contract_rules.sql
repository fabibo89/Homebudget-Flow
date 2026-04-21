-- Contracts v2: nutzerdefinierte Verträge mit mehreren Regeln (OR).
-- Ersetzt das bisherige heuristische Modell household_contracts vollständig.

BEGIN;

-- Neue Tabellen
CREATE TABLE IF NOT EXISTS contracts (
  id              SERIAL PRIMARY KEY,
  bank_account_id INTEGER NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,
  label           VARCHAR(512) NOT NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT (NOW()),
  updated_at      TIMESTAMP NOT NULL DEFAULT (NOW())
);

CREATE INDEX IF NOT EXISTS ix_contracts_bank_account_id ON contracts(bank_account_id);

CREATE TABLE IF NOT EXISTS contract_rules (
  id                    SERIAL PRIMARY KEY,
  contract_id            INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  enabled               BOOLEAN NOT NULL DEFAULT TRUE,
  priority              INTEGER NOT NULL DEFAULT 0,
  conditions_json        TEXT NOT NULL DEFAULT '[]',
  normalize_dot_space    BOOLEAN NOT NULL DEFAULT FALSE,
  display_name_override  VARCHAR(512) NULL,
  created_at             TIMESTAMP NOT NULL DEFAULT (NOW()),
  updated_at             TIMESTAMP NOT NULL DEFAULT (NOW())
);

CREATE INDEX IF NOT EXISTS ix_contract_rules_contract_id ON contract_rules(contract_id);

-- Transaction FK auf neue contracts-Tabelle umhängen
ALTER TABLE transactions
  DROP CONSTRAINT IF EXISTS transactions_contract_id_fkey;

ALTER TABLE transactions
  ADD CONSTRAINT transactions_contract_id_fkey
  FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE SET NULL;

-- Altes System entfernen (falls vorhanden)
DROP TABLE IF EXISTS household_contracts CASCADE;

COMMIT;

