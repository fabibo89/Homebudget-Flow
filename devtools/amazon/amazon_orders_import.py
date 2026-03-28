#!/usr/bin/env python3
"""
Amazon "Your Orders" Export -> Homebudget-Flow Transaction Enrichments.

Liest "Order History.csv" (Amazon Export) und importiert pro Bestellposition einen Enrichment-Record:
- source: amazon
- external_ref: "<Order ID>:<ASIN>"
- booking_date: Order Date (UTC) -> YYYY-MM-DD
- amount/currency: Total Amount / Currency (oder Shipment Item Subtotal falls Total fehlt)
- description/vendor/details/raw: aus CSV-Zeile

Dann optional: Auto-Matching auf bestehende Bankbuchungen per Backend.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from decimal import Decimal
from typing import Any

from dotenv import load_dotenv


def _load_env() -> None:
    here = os.path.dirname(os.path.abspath(__file__))
    load_dotenv(os.path.join(here, ".env"), override=False)
    load_dotenv(os.path.join(here, ".env.example"), override=False)


def _env(name: str, default: str | None = None) -> str | None:
    v = os.environ.get(name)
    if v is None:
        return default
    v = v.strip()
    return v if v else default


def _as_decimal(x: str | None) -> Decimal | None:
    if x is None:
        return None
    s = str(x).strip().strip('"').strip()
    if not s or s.lower() == "not available":
        return None
    # Amazon export nutzt "." als Dezimaltrenner.
    try:
        return Decimal(s)
    except Exception:
        return None


def _parse_iso_date(value: str) -> dt.date | None:
    s = (value or "").strip()
    if not s or s.lower() == "not available":
        return None
    # Beispiel: 2024-01-30T21:26:17Z
    try:
        if s.endswith("Z"):
            s2 = s[:-1] + "+00:00"
        else:
            s2 = s
        d = dt.datetime.fromisoformat(s2)
        return d.date()
    except Exception:
        # Fallback: nur Datum
        try:
            return dt.date.fromisoformat(s[:10])
        except Exception:
            return None


def _http_json(method: str, url: str, *, headers: dict[str, str], body: Any | None = None) -> Any:
    data = None
    if body is not None:
        raw = json.dumps(body, ensure_ascii=True).encode("utf-8")
        data = raw
        headers = {**headers, "Content-Type": "application/json"}
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            text = resp.read().decode("utf-8")
            return json.loads(text) if text else None
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8", errors="replace")
        except Exception:
            pass
        raise RuntimeError(f"HTTP {e.code} {method} {url}: {detail}") from e


def _login(api_base: str, email: str, password: str) -> str:
    url = api_base.rstrip("/") + "/api/auth/login"
    data = _http_json(
        "POST",
        url,
        headers={"Accept": "application/json"},
        body={"email": email, "password": password},
    )
    token = (data or {}).get("access_token")
    if not token:
        raise RuntimeError(f"Login fehlgeschlagen, keine access_token in Antwort: {data!r}")
    return str(token)


def _iter_csv_rows(path: str) -> list[dict[str, str]]:
    with open(path, "r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        return [dict(row) for row in reader]


def _map_order_row_to_record(row: dict[str, str]) -> dict[str, Any] | None:
    asin = (row.get("ASIN") or "").strip()
    order_id = (row.get("Order ID") or "").strip()
    order_date = _parse_iso_date(row.get("Order Date") or "")
    currency = (row.get("Currency") or "EUR").strip() or "EUR"

    amount = _as_decimal(row.get("Total Amount"))
    if amount is None:
        amount = _as_decimal(row.get("Shipment Item Subtotal"))
    if amount is None or order_date is None or not order_id:
        return None

    product = (row.get("Product Name") or "").strip()
    qty = (row.get("Original Quantity") or "").strip()
    payment = (row.get("Payment Method Type") or "").strip()
    carrier = (row.get("Carrier Name & Tracking Number") or "").strip()
    status = (row.get("Order Status") or "").strip()
    website = (row.get("Website") or "").strip()

    external_ref = f"{order_id}:{asin}" if asin else order_id

    details = {
        "order_id": order_id,
        "asin": asin,
        "product_name": product,
        "quantity": qty,
        "payment_method_type": payment,
        "carrier_tracking": carrier,
        "order_status": status,
        "website": website,
        "ship_date": (row.get("Ship Date") or "").strip(),
        "shipping_option": (row.get("Shipping Option") or "").strip(),
        "shipping_charge": (row.get("Shipping Charge") or "").strip(),
        "total_discounts": (row.get("Total Discounts") or "").strip(),
    }

    return {
        "external_ref": external_ref,
        "booking_date": order_date.isoformat(),
        "amount": str(amount),
        "currency": currency,
        "description": product or f"Amazon Bestellung {order_id}",
        "counterparty": "Amazon",
        "vendor": "Amazon",
        "details": details,
        "raw": row,
    }


def main() -> int:
    _load_env()
    p = argparse.ArgumentParser()
    p.add_argument("--household-id", type=int, required=True)
    p.add_argument(
        "--csv",
        required=True,
        help="Pfad zu 'Order History.csv' aus dem Amazon Export",
    )
    p.add_argument("--api-base", default=_env("HB_API_BASE", "http://localhost:3003"))
    p.add_argument("--email", default=_env("HB_EMAIL", ""))
    p.add_argument("--password", default=_env("HB_PASSWORD", ""))
    p.add_argument("--min-confidence", type=float, default=0.66)
    p.add_argument("--no-auto-match", action="store_true")
    p.add_argument("--limit", type=int, default=0, help="Optional: nur erste N Records importieren (0=alle)")
    args = p.parse_args()

    api_base = str(args.api_base or "http://localhost:3003").rstrip("/")
    email = str(args.email or "").strip()
    password = str(args.password or "").strip()
    if not email or not password:
        print("Fehler: HB_EMAIL/HB_PASSWORD (oder --email/--password) erforderlich.", file=sys.stderr)
        return 2

    token = _login(api_base, email, password)

    rows = _iter_csv_rows(args.csv)
    records: list[dict[str, Any]] = []
    for r in rows:
        rec = _map_order_row_to_record(r)
        if rec:
            records.append(rec)
        if args.limit and len(records) >= args.limit:
            break

    if not records:
        print("Keine importierbaren Records gefunden.", file=sys.stderr)
        return 1

    payload = {
        "household_id": int(args.household_id),
        "source": "amazon",
        "records": records,
        "auto_match": not bool(args.no_auto_match),
        "min_confidence": float(args.min_confidence),
    }

    url = api_base + "/api/transactions/enrichments/import"
    res = _http_json(
        "POST",
        url,
        headers={"Accept": "application/json", "Authorization": f"Bearer {token}"},
        body=payload,
    )

    print(json.dumps(res, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

