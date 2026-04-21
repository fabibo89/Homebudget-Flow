-- Vertragsregeln verweisen nur noch auf Kategorie-Regeln (gleiche Matching-Logik).
-- Bestehende „freistehende“ Vertragsregeln ohne Kategorie-Regel werden entfernt.

BEGIN;

ALTER TABLE contract_rules
  ADD COLUMN IF NOT EXISTS category_rule_id INTEGER REFERENCES category_rules(id) ON DELETE CASCADE;

DELETE FROM contract_rules WHERE category_rule_id IS NULL;

ALTER TABLE contract_rules
  ALTER COLUMN category_rule_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_contract_rules_contract_category
  ON contract_rules (contract_id, category_rule_id);

COMMIT;
