from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field


class BankCredentialCreate(BaseModel):
    """IBAN/BIC/Kontonummer kommen nur aus dem FinTS-Abruf beim Speichern, nicht aus dem Client."""

    provision_account_group_id: int = Field(
        ...,
        description="Kontogruppe, in der neu angelegte Bankkonten aus dem FinTS-Abruf landen (Zugang selbst ist nutzerbezogen).",
    )
    provider: str = Field(default="comdirect", max_length=64)
    fints_blz: str = Field(min_length=1, max_length=16)
    fints_user: str = Field(min_length=1, max_length=128)
    fints_endpoint: str = Field(default="https://fints.comdirect.de/fints", max_length=512)
    pin: str = Field(min_length=1, max_length=128)


class BankCredentialOut(BaseModel):
    id: int
    user_id: int
    provider: str
    fints_blz: str
    fints_user: str
    fints_endpoint: str
    has_pin: bool
    created_at: datetime
    fints_log: Optional[str] = Field(
        default=None,
        description="Nur bei POST/PATCH: Log des FinTS-Abrufs (SEPA-Kontenliste).",
    )

    model_config = {"from_attributes": True}


class BankCredentialUpdate(BaseModel):
    """Nur gesetzte Felder werden geändert. Neue PIN: Feld ``pin`` setzen. IBAN/BIC/Kontonummer setzt der Server nach FinTS-Test. Product-ID/TAN: FINTS_* in der Server-.env."""

    provision_account_group_id: Optional[int] = Field(
        default=None,
        description="Kontogruppe für neu angelegte Konten beim FinTS-Abgleich; sonst erste verknüpfte Kontogruppe eines Bankkontos mit diesem Zugang.",
    )
    provider: Optional[str] = Field(default=None, max_length=64)
    fints_blz: Optional[str] = Field(default=None, max_length=16)
    fints_user: Optional[str] = Field(default=None, max_length=128)
    fints_endpoint: Optional[str] = Field(default=None, max_length=512)
    pin: Optional[str] = Field(default=None, max_length=128)


class BankCredentialFintsTestBody(BaseModel):
    """FinTS-Test: PIN aus Formular; leer → gespeicherte PIN (gleicher Zugang in der DB) oder ``FINTS_PIN``."""

    account_group_id: Optional[int] = Field(
        default=None,
        description="Optional: nur für Zugriffsprüfung, wenn der Test im Kontext einer Kontogruppe läuft.",
    )
    provider: str = Field(default="comdirect", max_length=64)
    fints_blz: str = Field(min_length=1, max_length=16)
    fints_user: str = Field(min_length=1, max_length=128)
    fints_endpoint: str = Field(default="https://fints.comdirect.de/fints", max_length=512)
    pin: str = Field(default="", max_length=128)


class FintsSepaAccountOut(BaseModel):
    iban: str = ""
    bic: str = ""
    accountnumber: str = ""


class FintsTestResult(BaseModel):
    """Antwort von ``POST .../fints-test`` (gleicher Ablauf wie ``fints_test.py``)."""

    ok: bool
    log: str
    accounts: list[FintsSepaAccountOut] = Field(default_factory=list)
