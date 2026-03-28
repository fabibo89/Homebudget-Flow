#!/usr/bin/env python3
"""
PayPal Reporting API Transaktionen (devtools).

Liest "Buchungen" aus der PayPal Reporting-API und gibt sie als JSON aus.
OAuth2: Client-Credentials (Basic Auth auf /v1/oauth2/token).

Wichtig:
  - PayPal Reporting-API unterstützt maximal ~31 Tage pro Anfrage.
  - Executed transactions können je nach API-Delay bis zu ein paar Stunden brauchen.
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from decimal import Decimal
from typing import Any, Iterable

from dotenv import load_dotenv


def _load_env() -> None:
    here = os.path.dirname(os.path.abspath(__file__))
    # Erst echte lokale Werte laden; Shell-Exports bleiben vorrangig (override=False).
    load_dotenv(os.path.join(here, ".env"), override=False)
    # .env.example nur als Fallback für nicht gesetzte Variablen.
    load_dotenv(os.path.join(here, ".env.example"), override=False)


def _env(name: str, default: str | None = None) -> str | None:
    v = os.environ.get(name)
    if v is None:
        return default
    v = v.strip()
    return v if v else default


def _parse_date_yyyy_mm_dd(s: str) -> dt.date:
    return dt.date.fromisoformat(s)


def _rfc3339_utc(d: dt.datetime) -> str:
    # PayPal erwartet ISO 8601 mit "Z". Sekunden sind wichtig.
    if d.tzinfo is None:
        d = d.replace(tzinfo=dt.timezone.utc)
    d = d.astimezone(dt.timezone.utc)
    return d.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _to_booking_date(iso: str | None) -> str | None:
    if not iso:
        return None
    # Unterstützt "2026-03-25T12:34:56Z" oder "....+00:00"
    try:
        if iso.endswith("Z"):
            iso2 = iso[:-1] + "+00:00"
        else:
            iso2 = iso
        dt_obj = dt.datetime.fromisoformat(iso2)
        return dt_obj.date().isoformat()
    except Exception:
        return None


def _sign_amount_by_event(value: Decimal, event_code: str | None) -> Decimal:
    # PayPal gibt bei manchen Events positive/negative Beträge, aber "Buchungs-Semantik" ist nicht garantiert.
    # Heuristik: Payment received => positiv, payment sent => negativ.
    if not event_code:
        return value
    event_code = event_code.strip()
    if event_code == "T0006":  # Payment received
        return abs(value)
    if event_code == "T0007":  # Payment sent
        return -abs(value)
    return value


class PayPalClient:
    def __init__(self, client_id: str, client_secret: str, mode: str) -> None:
        self.client_id = client_id
        self.client_secret = client_secret
        self.mode = mode.lower().strip()
        if self.mode not in ("sandbox", "live"):
            raise ValueError("PAYPAL_MODE muss 'sandbox' oder 'live' sein")

        if self.mode == "sandbox":
            self.token_url = "https://api-m.sandbox.paypal.com/v1/oauth2/token"
            self.base_api_url = "https://api-m.sandbox.paypal.com"
        else:
            self.token_url = "https://api-m.paypal.com/v1/oauth2/token"
            self.base_api_url = "https://api-m.paypal.com"

        self._access_token: str | None = None
        self._expires_at: float = 0.0
        self._scope: str | None = None

    def _basic_auth_header(self) -> str:
        raw = f"{self.client_id}:{self.client_secret}".encode("utf-8")
        b64 = base64.b64encode(raw).decode("ascii")
        return f"Basic {b64}"

    def get_access_token(self) -> str:
        now = time.time()
        if self._access_token and (now + 30) < self._expires_at:
            return self._access_token

        headers = {
            "Accept": "application/json",
            "Accept-Language": "en_US",
            "Authorization": self._basic_auth_header(),
            "Content-Type": "application/x-www-form-urlencoded",
        }
        body = urllib.parse.urlencode({"grant_type": "client_credentials"}).encode("utf-8")

        req = urllib.request.Request(self.token_url, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = e.read().decode("utf-8", errors="replace")
            except Exception:
                pass
            raise RuntimeError(f"PayPal OAuth token failed: HTTP {e.code}: {detail}") from e

        token = data.get("access_token")
        expires_in = data.get("expires_in")
        if not token:
            raise RuntimeError(f"PayPal OAuth token response missing access_token: {data!r}")
        self._access_token = str(token)
        self._scope = data.get("scope")
        # expires_in ist Sekunden ab Jetzt.
        try:
            self._expires_at = now + float(expires_in)
        except Exception:
            self._expires_at = now + 3600
        return self._access_token

    def list_transactions(
        self,
        start_date: dt.datetime,
        end_date: dt.datetime,
        page_size: int,
        page: int,
    ) -> dict[str, Any]:
        token = self.get_access_token()
        # Optionaler Hinweis, falls wir Verbose-Laufparameter nutzen:
        if "--verbose" in sys.argv:
            scope = self._scope or ""
            print(f"[debug] token scope: {scope!r}", file=sys.stderr)
        url = f"{self.base_api_url}/v1/reporting/transactions"
        params = {
            "start_date": _rfc3339_utc(start_date),
            "end_date": _rfc3339_utc(end_date),
            "page_size": str(page_size),
            "page": str(page),
        }
        req_url = url + "?" + urllib.parse.urlencode(params)
        headers = {"Accept": "application/json", "Authorization": f"Bearer {token}"}
        req = urllib.request.Request(req_url, headers=headers, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = e.read().decode("utf-8", errors="replace")
            except Exception:
                pass
            if e.code == 403:
                scope = self._scope or ""
                raise RuntimeError(
                    "PayPal 403 NOT_AUTHORIZED (insufficient permissions) beim Reporting-Call. "
                    "In deiner PayPal App-Config muss 'Transaction Search' / Reporting Transactions "
                    "für die REST App aktiviert sein (Sandbox vs Live beachten). "
                    "Wenn du es gerade erst aktiviert hast: es kann bis zu 9 Stunden dauern, bis es "
                    "für neue Token gilt. Details: "
                    + f"HTTP {e.code}: {detail} | token scope={scope!r}"
                ) from e
            raise RuntimeError(f"PayPal transactions failed: HTTP {e.code}: {detail}") from e


def _as_decimal(x: Any) -> Decimal:
    if x is None:
        return Decimal("0")
    if isinstance(x, Decimal):
        return x
    return Decimal(str(x))


def _extract_transactions(resp: dict[str, Any]) -> list[dict[str, Any]]:
    # Je nach API-Variant können Felder abweichen. Wir versuchen mehrere typische Keys.
    for k in ("transaction_details", "transactions", "data"):
        v = resp.get(k)
        if isinstance(v, list):
            return v
    # Fallback: manchmal steht es verschachtelt in "transaction_details"
    return []


def _map_tx(tx: dict[str, Any]) -> dict[str, Any]:
    info = tx.get("transaction_info") or {}
    amt = tx.get("transaction_amount") or tx.get("amount") or {}

    transaction_id = info.get("transaction_id") or tx.get("transaction_id") or ""
    event_code = info.get("transaction_event_code") or tx.get("transaction_event_code")
    initiation = info.get("transaction_initiation_date") or info.get("transaction_initiation_date_time")
    subject = info.get("transaction_subject") or info.get("transaction_description") or tx.get("transaction_subject") or ""

    amount_value = _as_decimal(amt.get("value") if isinstance(amt, dict) else amt.get("amount") if isinstance(amt, dict) else amt)
    currency = ""
    if isinstance(amt, dict):
        currency = str(amt.get("currency_code") or amt.get("currency") or "")
    if not currency:
        currency = str(info.get("transaction_currency_code") or "")

    amount = _sign_amount_by_event(amount_value, str(event_code) if event_code else None)

    booking_date = _to_booking_date(str(initiation) if initiation else None)

    status = info.get("transaction_status") or tx.get("transaction_status") or ""

    return {
        "external_id": str(transaction_id),
        "booking_date": booking_date,
        "amount": str(amount),
        "currency": currency,
        "status": str(status),
        "description": str(subject)[:2000],
        "event_code": str(event_code) if event_code else None,
    }


def _iter_date_chunks(from_d: dt.date, to_d: dt.date, chunk_days: int) -> Iterable[tuple[dt.datetime, dt.datetime]]:
    if chunk_days < 1:
        raise ValueError("chunk_days muss >= 1 sein")

    cur = from_d
    while cur <= to_d:
        chunk_end = min(to_d, cur + dt.timedelta(days=chunk_days - 1))
        start_dt = dt.datetime(cur.year, cur.month, cur.day, 0, 0, 0, tzinfo=dt.timezone.utc)
        end_dt = dt.datetime(chunk_end.year, chunk_end.month, chunk_end.day, 23, 59, 59, tzinfo=dt.timezone.utc)
        yield start_dt, end_dt
        cur = chunk_end + dt.timedelta(days=1)


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="PayPal Reporting API: Transaktionen auslesen")
    p.add_argument("--from-date", required=True, help="YYYY-MM-DD (UTC)")
    p.add_argument("--to-date", required=True, help="YYYY-MM-DD (UTC)")
    p.add_argument("--page-size", default=int(_env("PAYPAL_PAGE_SIZE", "100") or 100))
    p.add_argument("--chunk-days", default=30, type=int, help="Max. Datumsbereich pro Request (Default 30)")
    p.add_argument("--mode", default=_env("PAYPAL_MODE", "sandbox") or "sandbox", choices=["sandbox", "live"])
    p.add_argument("--max-pages", default=200, type=int, help="Sicherheitslimit pro Chunk")
    p.add_argument("--output", default="", help="Pfad zu JSON-Ausgabe (optional)")
    p.add_argument("--raw-output", default="", help="Pfad zu Roh-Responses (optional; JSON)")
    p.add_argument("-v", "--verbose", action="store_true")
    p.add_argument("--check-env", action="store_true", help="Nur env prüfen, kein Netzwerk")
    return p.parse_args()


def main() -> int:
    _load_env()
    args = _parse_args()

    client_id = _env("PAYPAL_CLIENT_ID")
    client_secret = _env("PAYPAL_CLIENT_SECRET")
    if not client_id or not client_secret:
        print("Fehler: PAYPAL_CLIENT_ID und PAYPAL_CLIENT_SECRET müssen gesetzt sein.", file=sys.stderr)
        return 2

    if args.check_env:
        print("PayPal env ok (keine Netzwerk-Anfrage).")
        return 0

    client = PayPalClient(client_id=client_id, client_secret=client_secret, mode=args.mode)
    from_d = _parse_date_yyyy_mm_dd(args.from_date)
    to_d = _parse_date_yyyy_mm_dd(args.to_date)
    if to_d < from_d:
        print("--to-date muss >= --from-date sein.", file=sys.stderr)
        return 2

    results: list[dict[str, Any]] = []
    raw_results: list[dict[str, Any]] = []

    total_chunks = 0
    for chunk_start, chunk_end in _iter_date_chunks(from_d, to_d, args.chunk_days):
        total_chunks += 1
        if args.verbose:
            print(
                f"Chunk {total_chunks}/{(to_d-from_d).days+1}: {chunk_start.date().isoformat()}..{chunk_end.date().isoformat()}",
                file=sys.stderr,
            )
        for page in range(1, args.max_pages + 1):
            resp = client.list_transactions(
                start_date=chunk_start,
                end_date=chunk_end,
                page_size=args.page_size,
                page=page,
            )
            if args.raw_output:
                raw_results.append(resp)

            tx_list = _extract_transactions(resp)
            if not tx_list:
                break
            for tx in tx_list:
                results.append(_map_tx(tx))

            if len(tx_list) < args.page_size:
                break

    # Sortierung nach Datum, dann external_id (stabil)
    def _sort_key(x: dict[str, Any]) -> tuple[str, str]:
        return (str(x.get("booking_date") or ""), str(x.get("external_id") or ""))

    results.sort(key=_sort_key)

    out_obj = {"from_date": args.from_date, "to_date": args.to_date, "transactions": results}

    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            json.dump(out_obj, f, ensure_ascii=False, indent=2)
        print(f"Wrote {len(results)} transactions to {args.output}")
    else:
        # Nicht riesig drucken: nur Count + erstes Element.
        print(f"Found {len(results)} transactions.")
        if results:
            print(json.dumps(results[0], ensure_ascii=False, indent=2))

    if args.raw_output:
        with open(args.raw_output, "w", encoding="utf-8") as f:
            json.dump(raw_results, f, ensure_ascii=False)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

