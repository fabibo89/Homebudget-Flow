#!/usr/bin/env python3
"""
DKB FinTS — Saldo und Buchungen (lesend) für ein SEPA-Konto.

Gleiche .env wie ``dkb_fints_test.py`` (devtools/dkb/.env). Konto: ``FINTS_IBAN`` und/oder
``FINTS_ACCOUNT`` (Kontonummer), optional ``FINTS_BIC`` — auch ``FINTS_KONTO`` statt ACCOUNT.

Beispiel:
  python3 devtools/dkb/dkb_fints_balance_tx.py
  python3 devtools/dkb/dkb_fints_balance_tx.py --balance-only
  python3 devtools/dkb/dkb_fints_balance_tx.py --iban DE89… --from-date 2025-01-01 --to-date 2025-03-01
"""

from __future__ import annotations

import argparse
import getpass
import logging
import sys
from datetime import date, timedelta
from typing import Any

from fints.exceptions import FinTSClientError, FinTSClientPINError, FinTSConnectionError
from fints.utils import minimal_interactive_cli_bootstrap

from dkb_fints_common import (
    DEFAULT_BLZ,
    DEFAULT_ENDPOINT,
    DecoupledPollingTimeout,
    add_connection_args,
    add_decoupled_args,
    build_dkb_client,
    effective_product_version,
    env,
    find_sepa_account,
    load_dkb_dotenv,
    resolve_init_tan,
    resolve_need_tan_loop,
)


def _parse_date(s: str) -> date:
    return date.fromisoformat(s.strip())


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="DKB FinTS: Saldo und Umsätze (ein Konto)")
    add_connection_args(p)
    add_decoupled_args(p)
    p.add_argument("--iban", default=env("FINTS_IBAN"), help="IBAN (FINTS_IBAN)")
    p.add_argument("--bic", default=env("FINTS_BIC"), help="BIC (FINTS_BIC; bei Suche per Kontonummer empfohlen)")
    p.add_argument(
        "--account",
        default=env("FINTS_ACCOUNT") or env("FINTS_KONTO"),
        help="Kontonummer (FINTS_ACCOUNT oder FINTS_KONTO), falls ohne IBAN",
    )
    p.add_argument(
        "--from-date",
        type=_parse_date,
        default=None,
        help="Umsätze ab (ISO YYYY-MM-DD); Standard: 30 Tage vor --to-date",
    )
    p.add_argument(
        "--to-date",
        type=_parse_date,
        default=None,
        help="Umsätze bis (ISO YYYY-MM-DD); Standard: heute",
    )
    p.add_argument(
        "--balance-only",
        action="store_true",
        help="Nur Saldo, keine Umsätze",
    )
    p.add_argument(
        "--max-tx",
        type=int,
        default=500,
        help="Max. auszugebende Buchungen (nach Filter; Standard: 500)",
    )
    return p.parse_args()


def _balance_line(bal: Any) -> str:
    amt = getattr(bal, "amount", None)
    if amt is not None:
        a = getattr(amt, "amount", amt)
        c = getattr(amt, "currency", None) or "EUR"
        st = getattr(bal, "status", "") or ""
        return f"  Saldo: {a} {c}  (Status MT940: {st!r})"
    return f"  Saldo: {bal!r}"


def _tx_data(tx: Any) -> dict[str, Any]:
    if hasattr(tx, "data") and isinstance(tx.data, dict):
        return tx.data
    return {}


def _tx_line(tx: Any) -> str:
    d = _tx_data(tx)
    if d:
        amt = d.get("amount")
        cur = d.get("currency") or "EUR"
        if hasattr(amt, "amount"):
            amt_s = f"{amt.amount} {getattr(amt, 'currency', cur)}"
        else:
            amt_s = str(amt)
        bd = d.get("date") or d.get("booking_date") or "?"
        who = (d.get("applicant_name") or d.get("partner_name") or "").strip()
        pur = (d.get("purpose") or d.get("transaction_details") or d.get("remittance_info") or "")
        pur = str(pur).replace("\n", " ").strip()[:120]
        return f"  {bd}  {amt_s:>16}  {who[:40]!r}  {pur}"
    return f"  {tx!r}"


def main() -> int:
    load_dkb_dotenv()
    args = _parse_args()

    if args.verbose:
        logging.basicConfig(level=logging.DEBUG)

    if not args.user:
        print("Fehler: FINTS_USER bzw. --user fehlt.", file=sys.stderr)
        return 2
    if not args.product_id:
        print(
            "Fehler: FINTS_PRODUCT_ID fehlt.\n"
            "Registrierung: https://www.fints.org/de/hersteller/produktregistrierung",
            file=sys.stderr,
        )
        return 2
    if not (args.iban or args.account):
        print(
            "Fehler: Konto nicht angegeben — in .env oder per CLI: FINTS_IBAN und/oder "
            "FINTS_ACCOUNT (bzw. FINTS_KONTO), optional FINTS_BIC bei mehreren Treffern.",
            file=sys.stderr,
        )
        return 2

    if len(args.product_id) > 25:
        print(
            "Warnung: FINTS_PRODUCT_ID länger als 25 Zeichen (HKVVB) — ggf. Rückcode 9210.\n",
            file=sys.stderr,
        )

    effective_product_version(args)

    to_d = args.to_date or date.today()
    from_d = args.from_date or (to_d - timedelta(days=30))

    pin = env("FINTS_PIN")
    if not pin:
        pin = getpass.getpass("Online-Banking-PIN: ")

    client = build_dkb_client(args, pin)

    try:
        minimal_interactive_cli_bootstrap(client)
        with client:
            resolve_init_tan(
                client,
                decoupled_poll_sec=args.decoupled_poll_sec,
                decoupled_timeout_sec=args.decoupled_timeout_sec,
                decoupled_enter=args.decoupled_enter,
            )
            acc = find_sepa_account(
                client,
                iban=args.iban or None,
                bic=args.bic or None,
                account=args.account or None,
            )
            if acc is None:
                print(
                    "Konto nicht gefunden oder nicht eindeutig (IBAN prüfen; bei Suche nur über "
                    "Kontonummer ggf. --bic / FINTS_BIC setzen).",
                    file=sys.stderr,
                )
                return 2

            print(
                "Konto: IBAN="
                f"{getattr(acc, 'iban', '')!r}  BIC={getattr(acc, 'bic', '')!r}  "
                f"Kto={getattr(acc, 'accountnumber', '')!r}"
            )

            bal = resolve_need_tan_loop(
                client,
                lambda: client.get_balance(acc),
                decoupled_poll_sec=args.decoupled_poll_sec,
                decoupled_timeout_sec=args.decoupled_timeout_sec,
                decoupled_enter=args.decoupled_enter,
            )
            if bal is None:
                print("Kein Saldo in der Antwort.", file=sys.stderr)
                return 1
            print(_balance_line(bal))

            if args.balance_only:
                return 0

            print(f"Umsätze {from_d} … {to_d} (max. {args.max_tx}):")
            txs = resolve_need_tan_loop(
                client,
                lambda: client.get_transactions(
                    acc, start_date=from_d, end_date=to_d, include_pending=False
                ),
                decoupled_poll_sec=args.decoupled_poll_sec,
                decoupled_timeout_sec=args.decoupled_timeout_sec,
                decoupled_enter=args.decoupled_enter,
            )
            if not txs:
                print("  (keine)")
                return 0
            for i, tx in enumerate(txs):
                if i >= args.max_tx:
                    print(f"  … ({len(txs) - args.max_tx} weitere nicht ausgegeben)")
                    break
                try:
                    print(_tx_line(tx))
                except Exception as e:  # noqa: BLE001
                    print(f"  (Zeile übersprungen: {e})", file=sys.stderr)

    except FinTSClientPINError as e:
        print(
            "\nFinTS-Authentifizierungsfehler (oft generisch „PIN wrong?“).\n",
            e,
            file=sys.stderr,
        )
        return 1
    except FinTSConnectionError as e:
        pid = (args.product_id or "").strip()
        print(
            "\nHTTPS/FinTS-Verbindungsfehler:\n",
            e,
            f"\nDKB: HTTP 400 kommt oft, bevor der Dialog läuft — häufigste Ursache: keine gültige "
            f"ZKA-Produktkennung (aktuell FINTS_PRODUCT_ID Länge={len(pid)}).\n"
            "Platzhalter wie 1234567890ABCDEF werden von der Bank abgelehnt.\n"
            "Registrierung: https://www.fints.org/de/hersteller/produktregistrierung\n"
            "Prüfe außerdem: FINTS_USER = DKB-Anmeldename (nicht Kontonummer), Endpoint "
            f"{DEFAULT_ENDPOINT!r}, BLZ {DEFAULT_BLZ}.\n"
            "Mit -v siehst du mehr HTTP-/Protokolldetails.\n",
            file=sys.stderr,
        )
        return 1
    except FinTSClientError as e:
        print("\nFinTS-Protokollfehler:\n", e, file=sys.stderr)
        return 1
    except DecoupledPollingTimeout as e:
        print(e, file=sys.stderr)
        return 1
    except RuntimeError as e:
        print(e, file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\nAbgebrochen.", file=sys.stderr)
        raise SystemExit(130)
