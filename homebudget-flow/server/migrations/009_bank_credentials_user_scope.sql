-- FinTS-Zugänge gehören zum Nutzer; Kontogruppe nur am Bankkonto.
-- Duplikate (gleicher Login in mehreren Gruppen) werden zusammengeführt.
-- Manuell ausführen, z. B.:
--   docker compose -f docker-compose.yml -f docker-compose.dev.yml exec -T db psql -U hb -d homebudget -f - < server/migrations/009_bank_credentials_user_scope.sql

ALTER TABLE bank_credentials DROP CONSTRAINT IF EXISTS uq_cred_group_provider;

UPDATE bank_credentials SET fints_blz = TRIM(fints_blz), fints_user = TRIM(fints_user);

-- bank_accounts auf verbleibende Credential-ID umbiegen
UPDATE bank_accounts ba
SET credential_id = sub.keep_id
FROM (
  SELECT bc.id AS old_id,
         (SELECT MIN(bc2.id)
          FROM bank_credentials bc2
          WHERE bc2.user_id = bc.user_id
            AND bc2.provider = bc.provider
            AND bc2.fints_blz = bc.fints_blz
            AND bc2.fints_user = bc.fints_user) AS keep_id
  FROM bank_credentials bc
) AS sub
WHERE ba.credential_id = sub.old_id
  AND sub.old_id IS NOT NULL
  AND sub.keep_id IS NOT NULL
  AND sub.old_id != sub.keep_id;

DELETE FROM bank_credentials
WHERE id NOT IN (
  SELECT MIN(id)
  FROM bank_credentials
  GROUP BY user_id, provider, fints_blz, fints_user
);

ALTER TABLE bank_credentials DROP CONSTRAINT IF EXISTS bank_credentials_account_group_id_fkey;

ALTER TABLE bank_credentials DROP COLUMN IF EXISTS account_group_id;

ALTER TABLE bank_credentials
  ADD CONSTRAINT uq_cred_user_fints_login UNIQUE (user_id, provider, fints_blz, fints_user);
