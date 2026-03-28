-- Externe Transaktionsanreicherung (PayPal/Amazon) inkl. Mapping auf Bankbuchungen.
-- Ausführen mit:
--   docker compose exec -T db psql -U hb -d homebudget -f - < server/migrations/015_external_transaction_enrichments.sql

CREATE TABLE IF NOT EXISTS external_transaction_records (
  id SERIAL PRIMARY KEY,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  source VARCHAR(32) NOT NULL,
  external_ref VARCHAR(255) NOT NULL DEFAULT '',
  booking_date DATE NOT NULL,
  amount NUMERIC(18,2) NOT NULL,
  currency VARCHAR(8) NOT NULL DEFAULT 'EUR',
  description TEXT NOT NULL DEFAULT '',
  counterparty VARCHAR(512),
  vendor VARCHAR(512),
  details_json TEXT NOT NULL DEFAULT '{}',
  raw_json TEXT NOT NULL DEFAULT '{}',
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ext_record_source_ref
  ON external_transaction_records(source, external_ref);
CREATE INDEX IF NOT EXISTS ix_ext_record_household_source_date
  ON external_transaction_records(household_id, source, booking_date);
CREATE INDEX IF NOT EXISTS ix_ext_record_amount_currency
  ON external_transaction_records(amount, currency);

CREATE TABLE IF NOT EXISTS transaction_enrichments (
  id SERIAL PRIMARY KEY,
  transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  external_record_id INTEGER NOT NULL REFERENCES external_transaction_records(id) ON DELETE CASCADE,
  source VARCHAR(32) NOT NULL,
  match_confidence NUMERIC(5,4) NOT NULL DEFAULT 0.0,
  match_method VARCHAR(64) NOT NULL DEFAULT 'auto',
  matched_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_tx_enrichment_tx_source
  ON transaction_enrichments(transaction_id, source);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tx_enrichment_record_source
  ON transaction_enrichments(external_record_id, source);
