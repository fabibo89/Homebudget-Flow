"""Gemeinsame Hilfen für DKB-FinTS-Devtools (Session, Decoupled-Polling, Client)."""

from __future__ import annotations

import argparse
import getpass
import os
import sys
import tempfile
import time
from pathlib import Path

from dotenv import load_dotenv

from fints.client import FinTS3PinTanClient, NeedTANResponse

DEFAULT_BLZ = "12030000"
DEFAULT_ENDPOINT = "https://fints.dkb.de/fints"
DEFAULT_PRODUCT_VERSION = "tst01"

_DKB_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _DKB_DIR.parent.parent


class DecoupledPollingTimeout(RuntimeError):
    """Wartezeit für DKB-App-Freigabe überschritten (siehe --decoupled-timeout-sec)."""


def env(name: str, default: str | None = None) -> str | None:
    v = os.environ.get(name)
    if v is None or v == "":
        return default
    v = v.strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
        v = v[1:-1].strip()
    return v


def load_dkb_dotenv() -> None:
    load_dotenv(_REPO_ROOT / ".env", override=False)
    load_dotenv(_DKB_DIR / ".env", override=True)


def add_connection_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("--blz", default=env("FINTS_BLZ", DEFAULT_BLZ), help="Bankleitzahl (ohne Leerzeichen)")
    p.add_argument("--user", default=env("FINTS_USER"), help="Anmeldename / Benutzerkennung")
    p.add_argument("--endpoint", default=env("FINTS_ENDPOINT", DEFAULT_ENDPOINT), help="FinTS-URL")
    p.add_argument(
        "--product-id",
        default=env("FINTS_PRODUCT_ID"),
        help="ZKA-Produktregistrierungsnummer (Pflicht für python-fints 4+)",
    )
    p.add_argument(
        "--product-version",
        default=env("FINTS_PRODUCT_VERSION", DEFAULT_PRODUCT_VERSION),
        help=(
            f"HKVVB Produktversion (max. 5 Zeichen); Default {DEFAULT_PRODUCT_VERSION!r} oder FINTS_PRODUCT_VERSION"
        ),
    )
    p.add_argument("-v", "--verbose", action="store_true", help="HTTP-Debug (logging DEBUG)")


def add_decoupled_args(p: argparse.ArgumentParser) -> None:
    p.add_argument(
        "--decoupled-poll-sec",
        type=float,
        default=1.0,
        help="DKB-App (decoupled): Abstand zwischen send_tan(None)-Versuchen (Standard: 1)",
    )
    p.add_argument(
        "--decoupled-timeout-sec",
        type=float,
        default=180.0,
        help="Max. Wartezeit pro Decoupled-Phase in Sekunden (Standard: 180)",
    )
    p.add_argument(
        "--decoupled-enter",
        action="store_true",
        help="Decoupled: nach App-Freigabe Enter statt Polling",
    )


def effective_product_version(args: argparse.Namespace) -> str:
    pv_raw = (args.product_version or "").strip()
    if len(pv_raw) > 5:
        print(
            f"Hinweis: --product-version länger als 5 Zeichen — kürze {pv_raw!r} → {pv_raw[:5]!r} (HKVVB).",
            file=sys.stderr,
        )
    return pv_raw[:5] if pv_raw else DEFAULT_PRODUCT_VERSION


def build_dkb_client(args: argparse.Namespace, pin: str) -> FinTS3PinTanClient:
    return FinTS3PinTanClient(
        args.blz,
        args.user,
        pin,
        args.endpoint,
        args.user,
        product_id=args.product_id,
        product_version=effective_product_version(args),
    )


def save_matrix_challenge(r: NeedTANResponse) -> str | None:
    if not r.challenge_matrix:
        return None
    mime, data = r.challenge_matrix
    ext = ".png" if "png" in mime.lower() else ".bin"
    fd, path = tempfile.mkstemp(suffix=ext, prefix="fints_dkb_tan_challenge_")
    try:
        os.write(fd, data)
    finally:
        os.close(fd)
    return path


def prompt_tan_for_response(r: NeedTANResponse) -> str:
    ch = (r.challenge or "").strip()
    print("TAN erforderlich (DKB: ggf. chipTAN oder Grafik für photoTAN-ähnliche Verfahren).")
    if ch:
        print("  Hinweis der Bank:", ch)

    path = save_matrix_challenge(r)
    if path:
        print(f"  Challenge-Datei: {path}")

    if r.challenge_hhduc:
        print("  HHD_UC / Generator-Daten:")
        print(" ", r.challenge_hhduc)

    return getpass.getpass(
        "TAN (oder leer bei reiner App-Bestätigung, falls die Bank nichts Numerisches will): "
    )


def resolve_single_tan_challenge(
    client: FinTS3PinTanClient,
    r: NeedTANResponse,
    *,
    decoupled_poll_sec: float,
    decoupled_timeout_sec: float,
    decoupled_enter: bool,
) -> object:
    """Eine TAN-/Decoupled-Runde (auch mitten im Dialog, z. B. Umsätze)."""
    poll_sec = max(0.2, float(decoupled_poll_sec))
    timeout_sec = max(5.0, float(decoupled_timeout_sec))

    if r.decoupled:
        print(
            "Decoupled (DKB-App / SealOne): Bitte die Freigabe in der DKB-App bestätigen.\n"
            + (
                "  (Warte per Polling auf die Bank — kein Enter nötig.)\n"
                if not decoupled_enter
                else "  Danach hier Enter drücken.\n"
            ),
            flush=True,
        )
        if decoupled_enter:
            input()
            cur: object = client.send_tan(r, "")
        else:
            start = time.monotonic()
            cur = r
            while isinstance(cur, NeedTANResponse) and cur.decoupled:
                if (time.monotonic() - start) > timeout_sec:
                    raise DecoupledPollingTimeout(
                        f"Timeout ({timeout_sec:.0f}s): Keine rechtzeitige Bestätigung in der DKB-App."
                    )
                time.sleep(poll_sec)
                cur = client.send_tan(cur, None)
    else:
        tan = prompt_tan_for_response(r)
        cur = client.send_tan(r, tan)

    while isinstance(cur, NeedTANResponse) and not cur.decoupled:
        tan = prompt_tan_for_response(cur)
        cur = client.send_tan(cur, tan)

    return cur


def resolve_init_tan(
    client: FinTS3PinTanClient,
    *,
    decoupled_poll_sec: float,
    decoupled_timeout_sec: float,
    decoupled_enter: bool,
) -> None:
    """Init-Dialog inkl. DKB-App (decoupled). Leert ``init_tan_response``, wenn die Bank fertig ist."""

    for _ in range(40):
        r = client.init_tan_response
        if not r:
            return
        if not isinstance(r, NeedTANResponse):
            return

        cur = resolve_single_tan_challenge(
            client,
            r,
            decoupled_poll_sec=decoupled_poll_sec,
            decoupled_timeout_sec=decoupled_timeout_sec,
            decoupled_enter=decoupled_enter,
        )

        if not isinstance(cur, NeedTANResponse):
            client.init_tan_response = None
            return

        client.init_tan_response = cur


def print_tan_mechanisms(client: FinTS3PinTanClient) -> None:
    mechs = client.get_tan_mechanisms() or {}
    print("TAN-Verfahren (security_function → Name, wie von der Bank geliefert):")
    if not mechs:
        print("  (keine in BPD — Dialog evtl. abgebrochen oder HITANS noch nicht geladen)")
        a = getattr(client, "allowed_security_functions", None) or []
        if a:
            print("  allowed_security_functions (roh):", a)
        return
    for sec_fn, p in mechs.items():
        name = getattr(p, "name", "") or ""
        print(f"  {sec_fn!r} → {name!r}")


def find_sepa_account(
    client: FinTS3PinTanClient,
    *,
    iban: str | None = None,
    bic: str | None = None,
    account: str | None = None,
):
    """Konto aus ``get_sepa_accounts()``: zuerst IBAN, sonst Kontonummer (optional mit BIC)."""
    iban_n = "".join((iban or "").split()).upper() if (iban or "").strip() else ""
    acc_n = "".join(str(account or "").split()) if str(account or "").strip() else ""
    bic_n = "".join((bic or "").split()).upper() if (bic or "").strip() else ""

    accounts = list(client.get_sepa_accounts())

    if iban_n:
        for a in accounts:
            got = "".join((getattr(a, "iban", None) or "").split()).upper()
            if got == iban_n:
                return a
        return None

    if acc_n:
        matches = []
        for a in accounts:
            num = "".join((getattr(a, "accountnumber", None) or "").split())
            if num != acc_n:
                continue
            if bic_n:
                abic = "".join((getattr(a, "bic", None) or "").split()).upper()
                if abic != bic_n:
                    continue
            matches.append(a)
        if len(matches) == 1:
            return matches[0]
        return None

    return None


def resolve_need_tan_loop(
    client: FinTS3PinTanClient,
    fetch,
    *,
    decoupled_poll_sec: float,
    decoupled_timeout_sec: float,
    decoupled_enter: bool,
    max_rounds: int = 16,
):
    """Ruft ``fetch()`` wiederholt auf, bis kein ``NeedTANResponse`` mehr kommt."""
    rounds = 0
    while rounds < max_rounds:
        result = fetch()
        if not isinstance(result, NeedTANResponse):
            return result
        rounds += 1
        resolve_single_tan_challenge(
            client,
            result,
            decoupled_poll_sec=decoupled_poll_sec,
            decoupled_timeout_sec=decoupled_timeout_sec,
            decoupled_enter=decoupled_enter,
        )
    raise RuntimeError(f"FinTS: zu viele TAN-Runden (>{max_rounds}).")
