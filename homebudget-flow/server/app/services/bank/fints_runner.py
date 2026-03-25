"""
Synchroner FinTS-Lauf (Comdirect): gleiche Bausteine wie fints_test.py.

Hinweis: TAN/PhotoTAN – `FINTS_TAN` für PhotoTAN-Sync. Decoupled (DKB-App): Polling mit
``FINTS_DECOUPLED_POLL_SEC`` / ``FINTS_DECOUPLED_TIMEOUT_SEC``; bei Hintergrundjobs ohne UI-Kanal muss
TIMEOUT_SEC > 0 gesetzt sein.
"""

from __future__ import annotations

import logging
import os
import tempfile
import time
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Callable, Optional, TypeVar

from fints.client import FinTS3PinTanClient, NeedTANResponse
from fints.exceptions import FinTSClientPINError, FinTSConnectionError
from fints.models import SEPAAccount
from fints.utils import minimal_interactive_cli_bootstrap
from mt940.models import Balance as Mt940Balance

from app.config import settings
from app.services.bank.base import FetchedTransaction
from app.services.bank.transaction_tan_channel import TransactionTanChannel
from app.services.transaction_external_id import compute_stable_transaction_external_id, norm_iban

logger = logging.getLogger(__name__)


class SkipTransactionsForAutomationTan(Exception):
    """Umsatzabruf verlangt eine weitere TAN; ohne interaktiven Kanal (Cron) nicht möglich."""

    pass


@dataclass(frozen=True)
class FintsCredentials:
    """FinTS-Zugangsdaten im Speicher; leere pin/product_id/tan → FINTS_* / Settings."""

    blz: str
    user: str
    pin: str
    endpoint: str = "https://fints.comdirect.de/fints"
    product_id: str = ""
    tan: str = ""


# Fallback: Shell-Variablen FINTS_* wie in fints_test.py (pydantic-settings mappt je nach Version unterschiedlich)
_ENV_KEYS = {
    "blz": "FINTS_BLZ",
    "user": "FINTS_USER",
    "pin": "FINTS_PIN",
    "endpoint": "FINTS_ENDPOINT",
    "product_id": "FINTS_PRODUCT_ID",
    "tan": "FINTS_TAN",
}


def _fints(field: str) -> str:
    # Zuerst explizite Umgebung (Docker Compose / kubectl -e / export) — dann Settings (inkl. .env-Datei).
    ek = _ENV_KEYS.get(field)
    if ek:
        r = os.environ.get(ek, "")
        if isinstance(r, str) and r.strip():
            return r.strip()
    v = getattr(settings, f"fints_{field}", None)
    if isinstance(v, str) and v.strip():
        return v.strip()
    if isinstance(v, int):
        return str(v)
    return ""


def _resolve_fints_field(field: str, cred: FintsCredentials | None) -> str:
    if cred is not None:
        m = {
            "blz": cred.blz,
            "user": cred.user,
            "pin": cred.pin,
            "endpoint": cred.endpoint,
            "product_id": cred.product_id,
            "tan": cred.tan,
        }
        raw = m.get(field, "")
        if isinstance(raw, str) and raw.strip():
            return raw.strip()
    return _fints(field)


def _decoupled_poll_interval_sec() -> float:
    return max(0.2, float(settings.fints_decoupled_poll_sec or 1.0))


def _decoupled_timeout_seconds(tx_tan_channel: TransactionTanChannel | None) -> float | None:
    """None = Decoupled hier nicht ausführbar (Timeout nicht konfiguriert / Hintergrund)."""
    t = float(settings.fints_decoupled_timeout_sec or 0)
    if tx_tan_channel is not None:
        return max(5.0, t if t > 0 else 180.0)
    if t <= 0:
        return None
    return max(5.0, t)


def _poll_decoupled_until_ready(
    client: FinTS3PinTanClient,
    r: NeedTANResponse,
    timeout_sec: float,
) -> Any:
    start = time.monotonic()
    poll = _decoupled_poll_interval_sec()
    cur: Any = r
    while isinstance(cur, NeedTANResponse) and cur.decoupled:
        if (time.monotonic() - start) > timeout_sec:
            raise RuntimeError(
                f"FinTS decoupled: Timeout ({timeout_sec:.0f}s) — Freigabe in der Banking-App nicht rechtzeitig."
            )
        time.sleep(poll)
        cur = client.send_tan(cur, None)
    return cur


def _resolve_decoupled_then_chip_tan(
    client: FinTS3PinTanClient,
    r: NeedTANResponse,
    cred: FintsCredentials | None,
    tx_tan_channel: TransactionTanChannel | None,
) -> Any | None:
    """Decoupled per Polling, danach ggf. chipTAN/PhotoTAN. None wenn Timeout nicht erlaubt."""
    timeout = _decoupled_timeout_seconds(tx_tan_channel)
    if timeout is None:
        return None
    logger.info(
        "FinTS decoupled: Polling (timeout=%.0fs, interval=%.2fs)",
        timeout,
        _decoupled_poll_interval_sec(),
    )
    cur = _poll_decoupled_until_ready(client, r, timeout)
    while isinstance(cur, NeedTANResponse) and not cur.decoupled:
        tan = _prompt_tan_for_response(cur, cred, tx_tan_channel)
        cur = client.send_tan(cur, tan)
    return cur


T = TypeVar("T")


def _get_sepa_accounts_list_resolving_tan(
    client: FinTS3PinTanClient,
    cred: FintsCredentials | None,
    tx_tan_channel: TransactionTanChannel | None,
) -> list[Any]:
    """Ruft ``get_sepa_accounts`` auf; PhotoTAN/decoupled wie beim Umsatzabruf."""
    rounds = 0
    while rounds < 8:
        accounts = client.get_sepa_accounts()
        if not isinstance(accounts, NeedTANResponse):
            return list(accounts) if accounts else []
        r = accounts
        rounds += 1
        if r.decoupled:
            resolved = _resolve_decoupled_then_chip_tan(client, r, cred, tx_tan_channel)
            if resolved is None:
                raise RuntimeError(
                    "FinTS decoupled TAN (SEPA-Konten): Freigabe in der Banking-App und "
                    "FINTS_DECOUPLED_TIMEOUT_SEC (>0) in der Server-.env (ohne UI-Kanal), "
                    "oder FinTS-Test über die Web-App mit TAN-Dialog."
                )
            continue

        if tx_tan_channel is None:
            _save_matrix_challenge(r)
            raise RuntimeError(
                "FinTS: TAN für SEPA-Kontenliste erforderlich – in der App „Speichern“/„Test“ nutzen "
                "(PhotoTAN) oder FINTS_TAN in der Server-.env setzen."
            )

        if not r.challenge_matrix:
            _save_matrix_challenge(r)
        mime, data = ("application/octet-stream", b"")
        if r.challenge_matrix:
            mime, data = r.challenge_matrix
        hint = _need_tan_challenge_hint(r)
        tx_tan_channel.publish_challenge(mime, data, hint=hint)
        tan = tx_tan_channel.wait_for_tan(600.0)
        tx_tan_channel.reset_tan_wait()
        client.send_tan(r, tan)
    raise RuntimeError("FinTS: zu viele TAN-Runden bei der SEPA-Kontenliste")


def _find_sepa_account(
    client: FinTS3PinTanClient,
    iban: str,
    cred: FintsCredentials | None = None,
    tx_tan_channel: TransactionTanChannel | None = None,
) -> SEPAAccount:
    want = norm_iban(iban)
    accounts = _get_sepa_accounts_list_resolving_tan(client, cred, tx_tan_channel)
    for a in accounts:
        if norm_iban(a.iban) == want:
            return a
    raise ValueError(f"Kein SEPA-Konto mit IBAN {iban} in der FinTS-Antwort gefunden.")


def _save_matrix_challenge(r: NeedTANResponse) -> Optional[str]:
    if not r.challenge_matrix:
        return None
    mime, data = r.challenge_matrix
    ext = ".png" if "png" in mime.lower() else ".bin"
    fd, path = tempfile.mkstemp(suffix=ext, prefix="fints_tan_challenge_")
    try:
        os.write(fd, data)
    finally:
        os.close(fd)
    logger.warning("FinTS Matrix-Challenge gespeichert: %s", path)
    return path


def _prompt_tan_for_response(
    r: NeedTANResponse,
    cred: FintsCredentials | None,
    tx_tan_channel: TransactionTanChannel | None = None,
) -> str:
    if tx_tan_channel is not None:
        if not r.challenge_matrix:
            _save_matrix_challenge(r)
        mime, data = ("application/octet-stream", b"")
        if r.challenge_matrix:
            mime, data = r.challenge_matrix
        hint = _need_tan_challenge_hint(r)
        tx_tan_channel.publish_challenge(mime, data, hint=hint)
        tan = tx_tan_channel.wait_for_tan(600.0)
        tx_tan_channel.reset_tan_wait()
        return tan

    tan = _resolve_fints_field("tan", cred).strip() or (os.environ.get("FINTS_TAN") or "").strip()
    if tan:
        return tan
    _save_matrix_challenge(r)
    raise RuntimeError(
        "FinTS TAN erforderlich (PhotoTAN): setze FINTS_TAN in der Server-.env "
        "oder nutze interaktiv fints_test.py."
    )


def _resolve_init_tan(
    client: FinTS3PinTanClient,
    cred: FintsCredentials | None,
    tx_tan_channel: TransactionTanChannel | None = None,
) -> None:
    # python-fints setzt init_tan_response nur bei dialog.init(); nach erfolgreichem send_tan
    # wird es nicht geleert — sonst dieselbe Challenge erneut → zweite App-Runde / 9800.
    for _ in range(20):
        r = client.init_tan_response
        if not r:
            return
        if not isinstance(r, NeedTANResponse):
            return
        if r.decoupled:
            cur = _resolve_decoupled_then_chip_tan(client, r, cred, tx_tan_channel)
            if cur is None:
                raise RuntimeError(
                    "FinTS decoupled (Init): ohne UI-Kanal bitte FINTS_DECOUPLED_TIMEOUT_SEC (>0) setzen "
                    "oder Zugang in der App mit FinTS-Dialog anlegen/testen."
                )
        else:
            tan = _prompt_tan_for_response(r, cred, tx_tan_channel)
            cur = client.send_tan(r, tan)

        while isinstance(cur, NeedTANResponse) and not cur.decoupled:
            tan = _prompt_tan_for_response(cur, cred, tx_tan_channel)
            cur = client.send_tan(cur, tan)

        if not isinstance(cur, NeedTANResponse):
            client.init_tan_response = None
            return

        client.init_tan_response = cur


def _balance_to_decimal(bal: Mt940Balance) -> tuple[Decimal, str]:
    # mt940.Amount negiert bei Status 'D' bereits (Debit => negativer Betrag).
    # Daher NICHT erneut über bal.status drehen, sonst kippt das Vorzeichen doppelt.
    amt = bal.amount.amount
    cur = bal.amount.currency or "EUR"
    return Decimal(str(amt)), str(cur)


def _tx_data(tx: Any) -> dict[str, Any]:
    if hasattr(tx, "data") and isinstance(tx.data, dict):
        return tx.data
    return {}


def _extract_amount_currency(d: dict[str, Any]) -> tuple[Decimal, str]:
    raw = d.get("amount")
    if raw is None:
        return Decimal("0"), "EUR"
    if hasattr(raw, "amount"):
        return Decimal(str(raw.amount)), str(raw.currency or "EUR")
    return Decimal(str(raw)), "EUR"


def _to_date(val: Any) -> date:
    if isinstance(val, datetime):
        return val.date()
    if isinstance(val, date):
        return val
    if hasattr(val, "date"):
        return val.date()
    return date.fromisoformat(str(val)[:10])


def _extract_date(d: dict[str, Any]) -> tuple[date, Optional[date]]:
    bd = d.get("date") or d.get("booking_date")
    if bd is None:
        raise ValueError("Buchungsdatum fehlt")
    bd = _to_date(bd)
    vd = d.get("valuta") or d.get("value_date")
    if vd is None:
        return bd, None
    return bd, _to_date(vd)


def _extract_description(d: dict[str, Any]) -> str:
    for k in ("purpose", "transaction_details", "description", "remittance_info"):
        v = d.get(k)
        if v:
            return str(v)[:2000]
    return ""


def _extract_counterparty(d: dict[str, Any]) -> Optional[str]:
    for k in ("applicant_name", "applicant_iban", "partner_name"):
        v = d.get(k)
        if v:
            return str(v)[:512]
    return None


def _normalize_one_tx(tx: Any, iban: str) -> FetchedTransaction:
    d = _tx_data(tx)
    booking, value_d = _extract_date(d)
    amount, currency = _extract_amount_currency(d)
    desc = _extract_description(d)
    cp = _extract_counterparty(d)
    ext = compute_stable_transaction_external_id(
        iban, booking, value_d, amount, desc, cp
    )
    return FetchedTransaction(
        external_id=ext,
        amount=amount,
        currency=currency,
        booking_date=booking,
        value_date=value_d,
        description=desc,
        counterparty=cp,
        raw=dict(d) if d else None,
    )


def _endpoint_is_dkb_fints(endpoint: str) -> bool:
    """True wenn Kommunikationsadresse der DKB (FinTS 3.0)."""
    return "fints.dkb.de" in (endpoint or "").strip().lower()


def _blz_is_dkb(blz: str) -> bool:
    """DKB-Bankleitzahl 120 300 00 → ohne Leerzeichen 12030000."""
    return "".join((blz or "").split()) == "12030000"


def _validate_settings(cred: FintsCredentials | None) -> None:
    blz = _resolve_fints_field("blz", cred)
    user = _resolve_fints_field("user", cred)
    pin = _resolve_fints_field("pin", cred)
    product_id = _resolve_fints_field("product_id", cred)
    missing: list[str] = []
    if not blz:
        missing.append("BLZ (Formular / FINTS_BLZ)")
    if not user:
        missing.append("FinTS-User (Formular / FINTS_USER)")
    if not pin:
        missing.append("PIN (FINTS_PIN in der Server-.env oder Umgebung des Containers)")
    if not product_id:
        missing.append("Product-ID (FINTS_PRODUCT_ID, DK-Registrierung)")
    if missing:
        raise RuntimeError(
            "FinTS nicht vollständig konfiguriert — es fehlt: "
            + ", ".join(missing)
            + ". Im Docker-Image liegt keine .env; Datei `server/.env` nach `/app/.env` mounten oder "
            "FINTS_PIN und FINTS_PRODUCT_ID in `docker-compose.yml` unter `environment:` setzen."
        )


def _build_client(cred: FintsCredentials | None) -> FinTS3PinTanClient:
    _validate_settings(cred)
    endpoint = (
        _resolve_fints_field("endpoint", cred)
        or settings.fints_endpoint
        or "https://fints.comdirect.de/fints"
    )
    blz = _resolve_fints_field("blz", cred)
    product_id = _resolve_fints_field("product_id", cred)
    from_cred = cred is not None and bool((cred.product_id or "").strip())
    logger.info(
        "FinTS: Produktkennung (python-fints) Länge=%s, Quelle=%s",
        len(product_id),
        "Bank-Zugangsdaten" if from_cred else "FINTS_PRODUCT_ID (Umgebung) oder settings.fints_product_id (.env)",
    )
    # DKB (neuer FinTS-Server ab ~25.11.2024): Kunden-ID = FinTS-Benutzerkennung (Anmeldename).
    # Entwicklerhinweis u. a. https://homebanking-hilfe.de/forum/topic.php?t=26871 (Zitat subsembly).
    # Die DKB-FAQ „Kunden-ID frei lassen“ ist damit für den neuen Server fachlich überholt.
    customer_id: str | None = None
    user = _resolve_fints_field("user", cred)
    if _endpoint_is_dkb_fints(endpoint) or _blz_is_dkb(blz):
        customer_id = user
        logger.info(
            "FinTS DKB: HKIDN Kunden-ID = Benutzerkennung; Endpoint=%s BLZ=%s",
            endpoint,
            blz,
        )
    return FinTS3PinTanClient(
        blz,
        user,
        _resolve_fints_field("pin", cred),
        endpoint,
        customer_id,
        product_id=product_id,
    )


def list_sepa_accounts_sync(
    cred: FintsCredentials | None,
    tx_tan_channel: TransactionTanChannel | None = None,
) -> list[Any]:
    """SEPA-Konten auflisten — Bootstrap, Init-TAN, ``get_sepa_accounts`` (optional UI-TAN-Kanal)."""

    def inner(client: FinTS3PinTanClient) -> list[Any]:
        return _get_sepa_accounts_list_resolving_tan(client, cred, tx_tan_channel)

    return run_with_fints_session(inner, cred, tx_tan_channel)


def run_with_fints_session(
    fn: Callable[[FinTS3PinTanClient], T],
    cred: FintsCredentials | None = None,
    tx_tan_channel: TransactionTanChannel | None = None,
) -> T:
    """Öffnet eine FinTS-Sitzung (Bootstrap, Dialog, Init-TAN) und ruft fn(client) auf."""
    client = _build_client(cred)
    try:
        minimal_interactive_cli_bootstrap(client)
        with client:
            _resolve_init_tan(client, cred, tx_tan_channel)
            return fn(client)
    except FinTSConnectionError as e:
        endpoint = (
            _resolve_fints_field("endpoint", cred)
            if cred is not None
            else (settings.fints_endpoint or "")
        )
        dkb = _endpoint_is_dkb_fints(endpoint)
        raise RuntimeError(
            f"FinTS-HTTP-Verbindung fehlgeschlagen: {e}. "
            + (
                "DKB: Die Bank hat die HTTPS-Anfrage abgelehnt (HTTP 400). Häufig: ungültige oder fehlende "
                "FinTS-Produkt-ID — FINTS_PRODUCT_ID in server/.env muss eine bei der ZKA registrierte "
                "Produktkennung sein; siehe https://www.dkb.de/fragen-antworten/kann-ich-eine-finanzsoftware-fuers-banking-benutzen "
                "(Parameter FinTS 3.0, Endpoint https://fints.dkb.de/fints)."
                if dkb
                else "Prüfe Endpoint, Netzwerk und FINTS_PRODUCT_ID in der Server-.env."
            )
        ) from e
    except FinTSClientPINError as e:
        logger.exception("FinTS Authentifizierung")
        raise RuntimeError(
            "FinTS-Login fehlgeschlagen (PIN/Zugang/product_id/HBCI-Freischaltung prüfen). "
            "DKB: Anmeldename als Benutzerkennung; Bestätigung per DKB-App oder chipTAN laut Bank."
        ) from e


def fetch_balance_sync(iban: str, cred: FintsCredentials | None = None) -> tuple[Decimal, str]:
    def inner(client: FinTS3PinTanClient) -> tuple[Decimal, str]:
        acc = _find_sepa_account(client, iban)
        rounds = 0
        bal: Any = None
        while rounds < 12:
            bal = client.get_balance(acc)
            if not isinstance(bal, NeedTANResponse):
                break
            rounds += 1
            r = bal
            if r.decoupled:
                resolved = _resolve_decoupled_then_chip_tan(client, r, cred, None)
                if resolved is None:
                    raise RuntimeError(
                        "FinTS Saldo (decoupled): FINTS_DECOUPLED_TIMEOUT_SEC (>0) in der Server-.env setzen "
                        "oder Abruf über die App mit TAN-Dialog."
                    )
                continue
            tan = _prompt_tan_for_response(r, cred, None)
            client.send_tan(r, tan)
        else:
            raise RuntimeError("FinTS: zu viele TAN-Runden beim Saldoabruf")
        if bal is None:
            raise RuntimeError("FinTS: kein Saldo in der Antwort")
        return _balance_to_decimal(bal)

    return run_with_fints_session(inner, cred, None)


def _need_tan_challenge_hint(r: NeedTANResponse) -> str:
    for attr in ("challenge_text", "challenge_title", "message"):
        v = getattr(r, attr, None)
        if v:
            return str(v)[:2000]
    return ""


def fetch_transactions_sync(
    iban: str,
    from_date: Optional[date],
    to_date: Optional[date],
    cred: FintsCredentials | None = None,
    tx_tan_channel: TransactionTanChannel | None = None,
) -> list[FetchedTransaction]:
    def inner(client: FinTS3PinTanClient) -> list[FetchedTransaction]:
        acc = _find_sepa_account(client, iban, cred, tx_tan_channel)
        rounds = 0
        txs: Any = None
        while rounds < 8:
            txs = client.get_transactions(acc, start_date=from_date, end_date=to_date, include_pending=False)
            if not isinstance(txs, NeedTANResponse):
                break
            rounds += 1
            r = txs
            if r.decoupled:
                resolved = _resolve_decoupled_then_chip_tan(client, r, cred, tx_tan_channel)
                if resolved is None:
                    logger.error(
                        "FinTS Umsatzabruf decoupled: FINTS_DECOUPLED_TIMEOUT_SEC>0 nötig (Hintergrund) "
                        "oder Sync mit UI-TAN. IBAN=%s",
                        iban,
                    )
                    raise SkipTransactionsForAutomationTan()
                continue

            if tx_tan_channel is None:
                _save_matrix_challenge(r)
                logger.error(
                    "FinTS Umsatzabruf: zusätzliche TAN (z. B. PhotoTAN) erforderlich — "
                    "Hintergrundsync überspringt Umsätze. Matrix ggf. unter temporärer Datei. IBAN=%s",
                    iban,
                )
                raise SkipTransactionsForAutomationTan()

            if not r.challenge_matrix:
                _save_matrix_challenge(r)
            mime, data = ("application/octet-stream", b"")
            if r.challenge_matrix:
                mime, data = r.challenge_matrix
            hint = _need_tan_challenge_hint(r)
            tx_tan_channel.publish_challenge(mime, data, hint=hint)
            tan = tx_tan_channel.wait_for_tan(600.0)
            tx_tan_channel.reset_tan_wait()
            client.send_tan(r, tan)
        else:
            raise RuntimeError("FinTS: zu viele TAN-Runden beim Umsatzabruf")

        out: list[FetchedTransaction] = []
        for tx in txs or []:
            try:
                out.append(_normalize_one_tx(tx, iban))
            except Exception as e:  # noqa: BLE001
                logger.warning("Überspringe eine Buchung (Parse): %s", e)
        return out

    return run_with_fints_session(inner, cred, tx_tan_channel)
