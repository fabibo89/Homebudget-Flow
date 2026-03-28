-- Amazon Order-ID kann mehrere Bestellzeilen auf dieselbe Bankbuchung mappen.
-- Deshalb die 1:1-Constraint (transaction_id, source) entfernen.
--
-- Ausführen mit:
--   docker compose exec -T db psql -U hb -d homebudget -f - < server/migrations/016_drop_tx_enrichment_tx_unique.sql

ALTER TABLE transaction_enrichments
  DROP CONSTRAINT IF EXISTS uq_tx_enrichment_tx_source;
