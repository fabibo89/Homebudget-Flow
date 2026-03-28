-- Remove obsolete matching metadata columns.
ALTER TABLE transaction_enrichments
  DROP COLUMN IF EXISTS match_confidence,
  DROP COLUMN IF EXISTS match_method;
