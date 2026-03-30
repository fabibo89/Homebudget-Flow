-- True: '.' und Whitespace gleich behandeln (z. B. "ERNST LEBENSMITTEL" == "ERNST.LEBENSMITTEL")
ALTER TABLE category_rules ADD COLUMN normalize_dot_space BOOLEAN NOT NULL DEFAULT 0;

