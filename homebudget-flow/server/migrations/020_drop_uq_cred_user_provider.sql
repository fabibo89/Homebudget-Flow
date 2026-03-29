-- bank_credentials may have both UNIQUE (user_id, provider) and
-- UNIQUE (user_id, provider, fints_blz, fints_user) if 009 ran on a DB that
-- still carried uq_cred_user_provider (e.g. partial migration order). The
-- former blocks multiple FinTS logins for the same bank (e.g. two Comdirect
-- users); the latter is the intended rule.
ALTER TABLE bank_credentials DROP CONSTRAINT IF EXISTS uq_cred_user_provider;
