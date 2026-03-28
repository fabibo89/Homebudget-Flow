# Amazon Devtools

## Script: `amazon_orders_import.py`

Importiert Amazon „Your Orders“-Exports (CSV) als **Enrichment-Records** in Homebudget-Flow und triggert optional Auto-Matching
auf bestehende Bankbuchungen.

### Erwartete Dateien

- `Order History.csv` aus dem Export: `Your Orders/Your Amazon Orders/Order History.csv`

### Env

Lege `devtools/amazon/.env` an (nicht committen), z. B.:

- `HB_API_BASE` (default: `http://localhost:3003`)
- `HB_EMAIL`
- `HB_PASSWORD`

Beispiel:

```bash
cp devtools/amazon/.env.example devtools/amazon/.env
chmod 600 devtools/amazon/.env
```

### Start

```bash
python3 devtools/amazon/amazon_orders_import.py \
  --household-id 1 \
  --csv \"/Users/fabianbosch/Downloads/Amazon/Your Orders/Your Amazon Orders/Order History.csv\" \
  --min-confidence 0.66
```

Hinweis: Das Script erzeugt pro Bestellposition einen Record (`external_ref = order_id + asin`), damit mehrere Positionen pro Bestellung
eindeutig importiert werden können.

