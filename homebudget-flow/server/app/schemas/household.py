from __future__ import annotations

from datetime import date, datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field

from app.db.models import AccountSyncState, BankAccount, Household


class HouseholdCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)


class HouseholdOut(BaseModel):
    id: int
    name: str
    created_at: datetime
    my_role: Literal["member"] = Field(
        default="member",
        description="Alle Haushaltsmitglieder haben dieselben Rechte; es gibt keine Besitzer-Rolle.",
    )


def household_to_out(h: Household) -> HouseholdOut:
    return HouseholdOut(
        id=h.id,
        name=h.name,
        created_at=h.created_at,
    )


class HouseholdInvitationCreate(BaseModel):
    email: str = Field(min_length=3, max_length=255)


class HouseholdInvitationOut(BaseModel):
    id: int
    household_id: int
    household_name: str
    inviter_email: str
    invitee_email: str
    created_at: datetime
    expires_at: datetime


class HouseholdInvitationOutgoingOut(BaseModel):
    id: int
    invitee_email: str
    created_at: datetime
    expires_at: datetime


class HouseholdUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=255)


class AccountGroupCreate(BaseModel):
    household_id: int
    name: str
    description: str = ""
    member_user_ids: list[int] = Field(default_factory=list)


class AccountGroupOut(BaseModel):
    id: int
    household_id: int
    name: str
    description: str
    current_user_is_member: bool = False
    """Ob der angemeldete Nutzer Mitglied dieser Kontogruppe ist (Sicht auf Konten/Buchungen je Profil)."""
    current_user_can_manage_sharing: bool = False
    """Ob der Nutzer die Freigabeliste (Mitglieder) ändern darf — nur Kontogruppenmitglied mit can_edit."""

    model_config = {"from_attributes": True}


class AccountGroupUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=255)
    description: Optional[str] = Field(default=None, max_length=500)


class HouseholdMemberOut(BaseModel):
    user_id: int
    email: str
    display_name: str
    role: Literal["member"] = Field(
        default="member",
        description="Historisch unterschiedliche Werte; in der API nur noch Mitglieder ohne Sonderrolle.",
    )


class AccountGroupMemberOut(BaseModel):
    user_id: int
    email: str
    display_name: str
    can_edit: bool


class AccountGroupMembersPut(BaseModel):
    """Haushaltsmitglieder mit Zugriff auf diese Kontogruppe (mindestens eine Person)."""

    user_ids: list[int] = Field(..., min_length=1)


class BankAccountCreate(BaseModel):
    account_group_id: int
    provider: str = "comdirect"
    iban: str = Field(
        ...,
        min_length=15,
        max_length=34,
        description="IBAN des Kontos (ohne Leerzeichen; gleiche Kennung wie beim FinTS-Sync).",
    )
    name: str
    currency: str = "EUR"
    credential_id: int = Field(
        ...,
        description="FinTS-Zugang dieses Nutzers für Saldo- und Umsatzabruf.",
    )


class BankAccountOut(BaseModel):
    id: int
    account_group_id: int
    household_id: int
    credential_id: Optional[int]
    provider: str
    name: str
    iban: str
    currency: str
    balance: str
    balance_at: Optional[datetime]
    balance_attempt_at: Optional[datetime] = None
    balance_success_at: Optional[datetime] = None
    transactions_attempt_at: Optional[datetime] = None
    transactions_success_at: Optional[datetime] = None
    day_zero_date: Optional[date] = None

    model_config = {"from_attributes": True}


def bank_account_to_out(
    acc: BankAccount,
    sync: Optional[AccountSyncState] = None,
    *,
    household_id: Optional[int] = None,
) -> BankAccountOut:
    """API-Antwort inkl. Sync-Zeitstempel aus ``AccountSyncState`` (optional)."""
    hid = household_id
    if hid is None:
        if acc.account_group is None:
            raise ValueError("BankAccount.account_group muss geladen sein oder household_id setzen.")
        hid = acc.account_group.household_id
    return BankAccountOut(
        id=acc.id,
        account_group_id=acc.account_group_id,
        household_id=hid,
        credential_id=acc.credential_id,
        provider=acc.provider,
        name=acc.name,
        iban=acc.iban,
        currency=acc.currency,
        balance=str(acc.balance),
        balance_at=acc.balance_at,
        balance_attempt_at=sync.balance_attempt_at if sync else None,
        balance_success_at=sync.balance_success_at if sync else None,
        transactions_attempt_at=sync.transactions_attempt_at if sync else None,
        transactions_success_at=sync.transactions_success_at if sync else None,
        day_zero_date=acc.day_zero_date,
    )


class BankAccountUpdate(BaseModel):
    """Nur gesetzte Felder ändern. ``credential_id`` kann auf einen anderen FinTS-Zugang desselben Nutzers zeigen, nicht auf null."""

    account_group_id: Optional[int] = Field(
        default=None,
        description="Andere Kontogruppe desselben Haushalts; Buchungen und Konto bleiben am Konto.",
    )
    name: Optional[str] = Field(default=None, min_length=1, max_length=255)
    iban: Optional[str] = Field(default=None, min_length=15, max_length=34)
    currency: Optional[str] = Field(default=None, min_length=1, max_length=8)
    provider: Optional[str] = Field(default=None, min_length=1, max_length=64)
    credential_id: Optional[int] = Field(
        default=None,
        description="Anderer FinTS-Zugang (gleicher Nutzer); nicht leer setzen.",
    )
