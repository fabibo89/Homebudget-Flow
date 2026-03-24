-- Kategorien: Farbe, Emoji, optionales Bild (Base64)
--   docker compose ... exec -T db psql -U hb -d homebudget -f - < server/migrations/012_categories_color_icon_image.sql

ALTER TABLE categories ADD COLUMN IF NOT EXISTS color_hex VARCHAR(8);
ALTER TABLE categories ADD COLUMN IF NOT EXISTS icon_emoji VARCHAR(32);
ALTER TABLE categories ADD COLUMN IF NOT EXISTS image_mime VARCHAR(64);
ALTER TABLE categories ADD COLUMN IF NOT EXISTS image_base64 TEXT;

UPDATE categories SET color_hex = '#6366f1' WHERE parent_id IS NULL AND (color_hex IS NULL OR color_hex = '');
