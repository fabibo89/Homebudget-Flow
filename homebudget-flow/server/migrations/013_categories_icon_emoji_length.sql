-- Lange MUI-Icon-Namen (mui:SignalWifiStatusbarConnectedNoInternet4Outlined …) bis 64 Zeichen Token
--   docker compose exec -T db psql -U hb -d homebudget -f - < server/migrations/013_categories_icon_emoji_length.sql

ALTER TABLE categories ALTER COLUMN icon_emoji TYPE VARCHAR(64);
