-- FinTS-Zugang gehört zur Kontogruppe (ein Provider pro Kontogruppe).

ALTER TABLE bank_credentials ADD COLUMN IF NOT EXISTS account_group_id INTEGER REFERENCES account_groups(id) ON DELETE CASCADE;

UPDATE bank_credentials bc
SET account_group_id = sub.ag_id
FROM (
  SELECT bc2.id AS cid,
         (
           SELECT agm.account_group_id
           FROM account_group_members agm
           WHERE agm.user_id = bc2.user_id
           ORDER BY agm.account_group_id ASC
           LIMIT 1
         ) AS ag_id
  FROM bank_credentials bc2
) sub
WHERE bc.id = sub.cid AND sub.ag_id IS NOT NULL;

DELETE FROM bank_credentials WHERE account_group_id IS NULL;

ALTER TABLE bank_credentials ALTER COLUMN account_group_id SET NOT NULL;

ALTER TABLE bank_credentials DROP CONSTRAINT IF EXISTS uq_cred_user_provider;

ALTER TABLE bank_credentials ADD CONSTRAINT uq_cred_group_provider UNIQUE (account_group_id, provider);
