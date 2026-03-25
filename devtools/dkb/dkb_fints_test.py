#!/usr/bin/env python3
"""
DKB FinTS 3.0 — Verbindungstest (nur lesend: SEPA-Kontenliste).

Siehe ``dkb_fints_common.py`` und ``dkb_fints_balance_tx.py`` (Saldo + Umsätze).

Beispiel:
  python3 devtools/dkb/dkb_fints_test.py --check-env
  python3 devtools/dkb/dkb_fints_test.py
"""

from __future__ import annotations

import argparse
import getpass
import logging
import sys

from fints.exceptions import FinTSClientError, FinTSClientPINError, FinTSConnectionError
from fints.utils import minimal_interactive_cli_bootstrap

from dkb_fints_common import (
    DEFAULT_BLZ,
    DEFAULT_ENDPOINT,
    DEFAULT_PRODUCT_VERSION,
    DecoupledPollingTimeout,
    add_connection_args,
    add_decoupled_args,
    build_dkb_client,
    effective_product_version,
    env,
    load_dkb_dotenv,
    print_tan_mechanisms,
    resolve_init_tan,
)


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="DKB FinTS: SEPA-Konten auflisten")
    add_connection_args(p)
    add_decoupled_args(p)
    p.add_argument(
        "--check-env",
        action="store_true",
        help="Nur .env prüfen (kein Netzwerk): BLZ, Endpoint, Produkt-ID-Länge, ob User gesetzt",
    )
    p.add_argument(
        "--list-tan-mechanisms",
        action="store_true",
        help=(
            "Nach FinTS-Bootstrap verfügbare TAN-Verfahren ausgeben (HITANS/BPD), dann beenden. "
            "Funktioniert nur, wenn die Bank den Dialog bis zur BPD zulässt (kein HKIDN-9210 davor)."
        ),
    )
    return p.parse_args()


def main() -> int:
    load_dkb_dotenv()
    args = _parse_args()

    if args.verbose:
        logging.basicConfig(level=logging.DEBUG)

    if args.check_env:
        pid = args.product_id or ""
        print("DKB FinTS — Umgebung (ohne Verbindung)")
        print(f"  FINTS_ENDPOINT={args.endpoint!r}")
        print(f"  FINTS_BLZ={args.blz!r}")
        print(f"  FINTS_USER={'(gesetzt)' if args.user else '(fehlt)'}")
        print(f"  FINTS_PIN={'(gesetzt)' if env('FINTS_PIN') else '(wird abgefragt)'}")
        print(f"  FINTS_PRODUCT_ID Länge={len(pid)} (HKVVB max. 25 Zeichen — bei python-fints = product_name)")
        pver = (args.product_version or "").strip()
        pver_eff = pver[:5] if pver else DEFAULT_PRODUCT_VERSION
        print(f"  FINTS_PRODUCT_VERSION (HKVVB, max. 5)={pver_eff!r}")
        if len(pver) > 5:
            print(
                "  WARNUNG: Produktversion länger als 5 Zeichen — wird auf 5 gekürzt.",
                file=sys.stderr,
            )
        if len(pid) > 25:
            print(
                "  WARNUNG: Produkt-ID länger als 25 Zeichen — kann „9210 Datenelement ungültig“ auslösen.",
                file=sys.stderr,
            )
        if not pid:
            print("  FEHLER: FINTS_PRODUCT_ID fehlt.", file=sys.stderr)
            return 2
        if not args.user:
            print("  FEHLER: FINTS_USER fehlt.", file=sys.stderr)
            return 2
        print("  HKIDN (DKB): Kunden-ID = Benutzerkennung (neuer Server ab Nov. 2024).")
        return 0

    if not args.user:
        print("Fehler: FINTS_USER bzw. --user fehlt.", file=sys.stderr)
        return 2
    if not args.product_id:
        print(
            "Fehler: FINTS_PRODUCT_ID fehlt.\n"
            "Ohne bei der ZKA registrierte Produktkennung lehnt die DKB die Session oft mit HTTP 400 ab.\n"
            "Registrierung: https://www.fints.org/de/hersteller/produktregistrierung",
            file=sys.stderr,
        )
        return 2
    if len(args.product_id) > 25:
        print(
            "Warnung: FINTS_PRODUCT_ID ist länger als 25 Zeichen (HKVVB „Produktbezeichnung“).\n"
            "Kürzen oder andere Kennung nutzen — sonst ggf. Rückcode 9210.\n",
            file=sys.stderr,
        )

    effective_product_version(args)

    pin = env("FINTS_PIN")
    if not pin:
        pin = getpass.getpass("Online-Banking-PIN: ")

    client = build_dkb_client(args, pin)

    try:
        minimal_interactive_cli_bootstrap(client)
        if args.list_tan_mechanisms:
            print_tan_mechanisms(client)
            return 0
        with client:
            resolve_init_tan(
                client,
                decoupled_poll_sec=args.decoupled_poll_sec,
                decoupled_timeout_sec=args.decoupled_timeout_sec,
                decoupled_enter=args.decoupled_enter,
            )
            accounts = client.get_sepa_accounts()
    except FinTSClientPINError as e:
        print(
            "\nFinTS-Authentifizierungsfehler (Meldung oft generisch „PIN wrong?“).\n"
            "Prüfen: PIN, Produkt-ID, FinTS in DKB freigeschaltet, TAN-Verfahren DKB-App/chipTAN.\n",
            e,
            file=sys.stderr,
        )
        return 1
    except FinTSConnectionError as e:
        print(
            "\nHTTPS/FinTS-Verbindungsfehler:\n",
            e,
            "\n\nHäufig bei DKB: HTTP 400 → ungültige/fehlende ZKA-Produkt-ID, falscher Endpoint "
            f"oder falsche BLZ.\nErwartet: BLZ {DEFAULT_BLZ}, {DEFAULT_ENDPOINT}\n"
            "Infos: https://www.dkb.de/fragen-antworten/kann-ich-eine-finanzsoftware-fuers-banking-benutzen",
            file=sys.stderr,
        )
        return 1
    except FinTSClientError as e:
        print(
            "\nFinTS-Protokollfehler (vor/nach Login):\n",
            e,
            "\n\nDKB-Hinweise:\n"
            "  • Rückcode 9210 auf HKIDN: oft Benutzerkennung (Anmeldename, nicht Kontonummer) oder "
            "FinTS in den DKB-Einstellungen nicht freigeschaltet.\n"
            "  • Gültige ZKA-Produkt-ID (kein Platzhalter): "
            "https://www.fints.org/de/hersteller/produktregistrierung\n"
            "  • TAN Nov. 2024: DKB-App (decoupled) / chipTAN — "
            "https://support.immoware24.de/hc/de/articles/22938955128605\n"
            "  • Parameter: https://www.dkb.de/fragen-antworten/kann-ich-eine-finanzsoftware-fuers-banking-benutzen",
            file=sys.stderr,
        )
        return 1
    except DecoupledPollingTimeout as e:
        print(e, file=sys.stderr)
        return 1

    print("Gefundene Konten (SEPA):")
    for a in accounts:
        print(f"  IBAN={a.iban!r}  BIC={a.bic!r}  Konto={a.accountnumber!r}")
    if not accounts:
        print("  (keine)")

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\nAbgebrochen.", file=sys.stderr)
        raise SystemExit(130)
