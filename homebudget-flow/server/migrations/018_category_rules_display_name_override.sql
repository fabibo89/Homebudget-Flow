-- Optionaler Anzeigename; leer = Vorgabe aus Muster (Großbuchstaben).
ALTER TABLE category_rules ADD COLUMN display_name_override VARCHAR(512) NULL;
