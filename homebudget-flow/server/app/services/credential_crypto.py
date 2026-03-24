"""Verschlüsselung sensibler Felder (PIN) für ``bank_credentials`` — Fernet."""

from __future__ import annotations

from cryptography.fernet import Fernet, InvalidToken

from app.config import settings


def _fernet() -> Fernet:
    raw = (settings.credentials_fernet_key or "").strip().encode("ascii")
    if not raw:
        raise RuntimeError(
            "CREDENTIALS_FERNET_KEY fehlt in der Server-.env "
            "(z. B. python -c \"from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())\")."
        )
    return Fernet(raw)


def encrypt_secret(plain: str) -> str:
    if not plain or not plain.strip():
        raise ValueError("PIN darf nicht leer sein.")
    return _fernet().encrypt(plain.encode("utf-8")).decode("ascii")


def decrypt_secret(token: str) -> str:
    if not token or not token.strip():
        return ""
    try:
        return _fernet().decrypt(token.encode("ascii")).decode("utf-8")
    except InvalidToken as e:
        raise RuntimeError(
            "Gespeicherte PIN konnte nicht entschlüsselt werden — CREDENTIALS_FERNET_KEY prüfen (Schlüssel geändert?)."
        ) from e
