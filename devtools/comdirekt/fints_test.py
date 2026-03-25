#!/usr/bin/env python3
"""
Minimal FinTS connectivity test (read-only: list SEPA accounts).

Comdirect defaults (override via env or CLI):
  BLZ:      20041111
  Endpoint: https://fints.comdirect.de/fints

Since python-fints 4.x, a registered FinTS product_id is mandatory:
  https://www.fints.org/de/hersteller/produktregistrierung

Env (optional):
  FINTS_BLZ, FINTS_USER, FINTS_PIN, FINTS_ENDPOINT, FINTS_PRODUCT_ID

Comdirect (laut HBCI/FinTS-Hilfe): Benutzerkennung = Zugangsnummer (wie Online-Banking).

Credentials (optional, empfohlen: chmod 600 für .env):
  Standard: zuerst Repository-Root ``.env`` (wie vom Server), dann optional ``devtools/.env``.
  Bank-Vorlagen: ``devtools/comdirekt/.env.example`` bzw. ``devtools/dkb/.env.example``
  → als ``devtools/<bank>/.env`` kopieren; mit ``FINTS_BANK=comdirekt`` oder ``FINTS_BANK=dkb``
  wird die passende Datei geladen (oder ``FINTS_ENV_FILE=devtools/comdirekt/.env``).
  Shell-Exports überschreiben die Datei nicht (override=False).

Beispiel (Arbeitsverzeichnis = Repository-Root):
  pip install -r devtools/requirements.txt
  cp devtools/comdirekt/.env.example devtools/comdirekt/.env   # bearbeiten
  FINTS_BANK=comdirekt python3 devtools/fints_test.py
"""

from __future__ import annotations

import argparse
import getpass
import logging
import os
import sys
import tempfile
from pathlib import Path

from dotenv import load_dotenv

from fints.client import FinTS3PinTanClient, NeedTANResponse
from fints.exceptions import FinTSClientPINError
from fints.utils import minimal_interactive_cli_bootstrap

# Comdirect Bank AG, Quickborn
DEFAULT_BLZ = "20041177"
DEFAULT_ENDPOINT = "https://fints.comdirect.de/fints"

_DEVTOOLS_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _DEVTOOLS_DIR.parent


def _env(name: str, default: str | None = None) -> str | None:
    v = os.environ.get(name)
    if v is None or v == "":
        return default
    return v.strip()


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="FinTS test: list SEPA accounts")
    p.add_argument("--blz", default=_env("FINTS_BLZ", DEFAULT_BLZ), help="Bankleitzahl")
    p.add_argument("--user", default=_env("FINTS_USER"), help="Login / Benutzerkennung")
    p.add_argument("--endpoint", default=_env("FINTS_ENDPOINT", DEFAULT_ENDPOINT), help="FinTS server URL")
    p.add_argument(
        "--product-id",
        default=_env("FINTS_PRODUCT_ID"),
        help="Registered FinTS product ID (mandatory for python-fints 4+)",
    )
    p.add_argument("-v", "--verbose", action="store_true", help="HTTP debug log")
    return p.parse_args()


def _save_matrix_challenge(r: NeedTANResponse) -> str | None:
    """Schreibt eine Matrix-/Grafik-Challenge (z. B. photoTAN) in eine temporäre Datei."""
    if not r.challenge_matrix:
        return None
    mime, data = r.challenge_matrix
    ext = ".png" if "png" in mime.lower() else ".bin"
    fd, path = tempfile.mkstemp(suffix=ext, prefix="fints_tan_challenge_")
    try:
        os.write(fd, data)
    finally:
        os.close(fd)
    return path


def _prompt_tan_for_response(r: NeedTANResponse) -> str:
    """Erklärt photoTAN/Matrix und liest die numerische TAN ein (vom Generator/App)."""
    ch = (r.challenge or "").strip()
    print("TAN erforderlich.")
    if ch:
        print("  Hinweis der Bank:", ch)

    path = _save_matrix_challenge(r)
    if path:
        print(
            f"  Grafik/Matrix wurde gespeichert:\n  {path}\n"
            "  Öffne die Datei (Vorschau), auf dem Handy die comdirect photoTAN-App nutzen:\n"
            "  je nach Ablauf Grafik anzeigen oder Kamera/Foto – dann die angezeigte TAN hier eingeben."
        )

    if r.challenge_hhduc:
        print("  HHD_UC / Generator-Daten (ggf. in die photoTAN-App übernehmen):")
        print(" ", r.challenge_hhduc)

    if "grafik" in ch.lower() and not path and not r.challenge_hhduc:
        print(
            "  (Nur Text „Siehe Grafik“, aber keine Grafikdaten von der Bank erhalten – "
            "mit -v debuggen oder anderes TAN-Verfahren im Bootstrap wählen.)"
        )

    print("  Jetzt die TAN eingeben, die die photoTAN-App anzeigt (Ziffern).")
    return getpass.getpass("TAN: ")


def _resolve_init_tan(client: FinTS3PinTanClient) -> None:
    """Handle PSD2 dialog init that requires TAN (incl. decoupled / push / photoTAN)."""
    max_rounds = 20
    for _ in range(max_rounds):
        r = client.init_tan_response
        if not r:
            return
        if not isinstance(r, NeedTANResponse):
            return
        if r.decoupled:
            print("Decoupled TAN: bitte in der Banking-App bestätigen, dann hier Enter.")
            input()
            client.send_tan(r, "")
        else:
            tan = _prompt_tan_for_response(r)
            client.send_tan(r, tan)


def _load_env_files() -> None:
    override_path = os.environ.get("FINTS_ENV_FILE")
    if override_path:
        load_dotenv(os.path.expanduser(override_path), override=False)
        return
    load_dotenv(_REPO_ROOT / ".env", override=False)
    load_dotenv(_DEVTOOLS_DIR / ".env", override=False)
    bank = (os.environ.get("FINTS_BANK") or "").strip().lower()
    if bank in ("comdirekt", "comdirect"):
        load_dotenv(_DEVTOOLS_DIR / "comdirekt" / ".env", override=False)
    elif bank == "dkb":
        load_dotenv(_DEVTOOLS_DIR / "dkb" / ".env", override=False)


def main() -> int:
    _load_env_files()
    args = _parse_args()
    if args.verbose:
        logging.basicConfig(level=logging.DEBUG)
    if not args.user:
        print("Fehler: Benutzer fehlt (FINTS_USER oder --user).", file=sys.stderr)
        return 2
    if not args.product_id:
        print(
            "Fehler: FinTS product_id fehlt (FINTS_PRODUCT_ID oder --product-id).\n"
            "Registrierung: https://www.fints.org/de/hersteller/produktregistrierung",
            file=sys.stderr,
        )
        return 2

    pin = _env("FINTS_PIN")
    if not pin:
        pin = getpass.getpass("PIN: ")

    client = FinTS3PinTanClient(
        args.blz,
        args.user,
        pin,
        args.endpoint,
        product_id=args.product_id,
    )

    try:
        minimal_interactive_cli_bootstrap(client)

        with client:
            _resolve_init_tan(client)
            accounts = client.get_sepa_accounts()
    except FinTSClientPINError as e:
        print(
            "\nFinTS meldet einen Authentifizierungsfehler (python-fints: \"PIN wrong?\").\n"
            "Das ist oft irreführend: dieselbe Exception gilt für viele Bank-Rückcodes 9xxx,\n"
            "nicht nur für einen falschen PIN.\n\n"
            "Typische Ursachen:\n"
            "  • FinTS/HBCI in den Comdirect-Sicherheitseinstellungen nicht freigeschaltet\n"
            "  • falsche oder nicht freigeschaltete FinTS product_id (DK-Registrierung)\n"
            "  • Leerzeichen in exportierten Variablen (wird jetzt automatisch getrimmt)\n"
            "  • Bank-/Serverseitige Änderungen am FinTS-Zugang\n\n"
            "Mit -v siehst du mehr Protokoll. Originalmeldung:",
            file=sys.stderr,
        )
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
