-- Positive Buchungen: nicht in Meltdown-Start (Einnahmen-Summe), aber im Meltdown-Verlauf berücksichtigen.
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS meltdown_exclude_from_start BOOLEAN NOT NULL DEFAULT FALSE;
