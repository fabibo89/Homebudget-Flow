# PayPal Devtools

## Script: `paypal_transactions.py`

Liest Transaktionen aus der PayPal **Reporting API** (OAuth2 + `/v1/reporting/transactions`).

### Env
Lege `devtools/paypal/.env` an (nicht committen), z.B. mit:

- `PAYPAL_CLIENT_ID`
- `PAYPAL_CLIENT_SECRET`
- `PAYPAL_MODE` (`sandbox` oder `live`, default: `sandbox`)

Beispiel:
```bash
cp devtools/paypal/.env.example devtools/paypal/.env
chmod 600 devtools/paypal/.env
```

### Start
```bash
python3 devtools/paypal/paypal_transactions.py \
  --mode sandbox \
  --from-date 2026-03-01 \
  --to-date 2026-03-26 \
  --output /tmp/paypal-transactions.json \
  --verbose
```

Hinweise:
- Die API verlangt meist UTC-RFC3339 Zeitstempel.
- Pro Request wird in ~30-Tage-Chunks geteilt (`--chunk-days`, default 30).

