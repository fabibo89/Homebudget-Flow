from __future__ import annotations

import enum
from datetime import date, datetime
from decimal import Decimal
from typing import Optional

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Numeric,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


class HouseholdMemberRole(str, enum.Enum):
    owner = "owner"
    member = "member"


class SyncStatus(str, enum.Enum):
    never = "never"
    ok = "ok"
    error = "error"
    running = "running"


class ExternalRecordSource(str, enum.Enum):
    paypal = "paypal"
    amazon = "amazon"


class CategoryRuleType(str, enum.Enum):
    """Zuordnungsregel: Verwendungszweck oder Gegenpartei, enthält oder exakt (ohne Groß-/Kleinschreibung)."""

    description_contains = "description_contains"
    description_equals = "description_equals"
    counterparty_contains = "counterparty_contains"
    counterparty_equals = "counterparty_equals"


class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    hashed_password: Mapped[str] = mapped_column(String(255))
    display_name: Mapped[str] = mapped_column(String(255), default="")
    # True: Buchungen aller Kontogruppen im Haushalt; False: nur Kontogruppen mit direkter Mitgliedschaft.
    all_household_transactions: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    household_links: Mapped[list[HouseholdMember]] = relationship(back_populates="user")
    group_links: Mapped[list[AccountGroupMember]] = relationship(back_populates="user")
    bank_credentials: Mapped[list[BankCredential]] = relationship(back_populates="user")
    categories_created: Mapped[list["Category"]] = relationship(
        "Category",
        back_populates="created_by_user",
        foreign_keys="Category.created_by_user_id",
    )
    category_rules_created: Mapped[list["CategoryRule"]] = relationship(
        "CategoryRule",
        back_populates="created_by_user",
        foreign_keys="CategoryRule.created_by_user_id",
    )


class BankCredential(Base):
    """FinTS-Login je Nutzer (BLZ/User/Endpoint); PIN verschlüsselt. Kontogruppe nur am Bankkonto, nicht hier."""
    __tablename__ = "bank_credentials"
    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    provider: Mapped[str] = mapped_column(String(64), default="comdirect", index=True)
    fints_blz: Mapped[str] = mapped_column(String(16))
    fints_user: Mapped[str] = mapped_column(String(128))
    fints_endpoint: Mapped[str] = mapped_column(String(512), default="https://fints.comdirect.de/fints")
    pin_encrypted: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    # Letzte FinTS-Prüfung beim Speichern (SEPA-Liste); False = Zugang ohne erfolgreiche Verifikation gespeichert.
    fints_verified_ok: Mapped[bool] = mapped_column(Boolean, default=True)
    fints_verification_message: Mapped[str] = mapped_column(Text, default="")

    user: Mapped[User] = relationship(back_populates="bank_credentials")
    bank_accounts: Mapped[list["BankAccount"]] = relationship(back_populates="credential")

    __table_args__ = (
        UniqueConstraint("user_id", "provider", "fints_blz", "fints_user", name="uq_cred_user_fints_login"),
    )


class Household(Base):
    __tablename__ = "households"
    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    members: Mapped[list[HouseholdMember]] = relationship(
        back_populates="household",
        cascade="all, delete-orphan",
    )
    account_groups: Mapped[list[AccountGroup]] = relationship(
        back_populates="household",
        cascade="all, delete-orphan",
    )
    categories: Mapped[list["Category"]] = relationship(
        back_populates="household",
        cascade="all, delete-orphan",
    )
    category_rules: Mapped[list["CategoryRule"]] = relationship(
        back_populates="household",
        cascade="all, delete-orphan",
    )
    category_rule_suggestion_dismissals: Mapped[list["CategoryRuleSuggestionDismissal"]] = relationship(
        back_populates="household",
        cascade="all, delete-orphan",
    )
    invitations: Mapped[list["HouseholdInvitation"]] = relationship(
        back_populates="household",
        cascade="all, delete-orphan",
    )
    external_transaction_records: Mapped[list["ExternalTransactionRecord"]] = relationship(
        back_populates="household",
        cascade="all, delete-orphan",
    )


class HouseholdInvitation(Base):
    """Einladung eines registrierten Nutzers in einen Haushalt (nur Einladender/Eingeladener)."""

    __tablename__ = "household_invitations"
    __table_args__ = (
        UniqueConstraint("household_id", "invitee_user_id", name="uq_hh_invite_one_pending"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    household_id: Mapped[int] = mapped_column(ForeignKey("households.id", ondelete="CASCADE"))
    inviter_user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    invitee_user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime)

    household: Mapped[Household] = relationship(back_populates="invitations")
    inviter: Mapped["User"] = relationship(foreign_keys=[inviter_user_id])
    invitee: Mapped["User"] = relationship(foreign_keys=[invitee_user_id])


class HouseholdMember(Base):
    __tablename__ = "household_members"
    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    household_id: Mapped[int] = mapped_column(ForeignKey("households.id", ondelete="CASCADE"))
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    role: Mapped[str] = mapped_column(String(32), default=HouseholdMemberRole.member.value)

    household: Mapped[Household] = relationship(back_populates="members")
    user: Mapped[User] = relationship(back_populates="household_links")


class AccountGroup(Base):
    """Kontengruppe: einer Person oder geteilt (über AccountGroupMember)."""
    __tablename__ = "account_groups"
    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    household_id: Mapped[int] = mapped_column(ForeignKey("households.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(255))
    description: Mapped[str] = mapped_column(String(500), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    household: Mapped[Household] = relationship(back_populates="account_groups")
    members: Mapped[list[AccountGroupMember]] = relationship(
        back_populates="account_group",
        cascade="all, delete-orphan",
    )
    bank_accounts: Mapped[list[BankAccount]] = relationship(
        back_populates="account_group",
        cascade="all, delete-orphan",
    )


class AccountGroupMember(Base):
    __tablename__ = "account_group_members"
    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    account_group_id: Mapped[int] = mapped_column(ForeignKey("account_groups.id", ondelete="CASCADE"))
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    can_edit: Mapped[bool] = mapped_column(Boolean, default=True)

    account_group: Mapped[AccountGroup] = relationship(back_populates="members")
    user: Mapped[User] = relationship(back_populates="group_links")


class BankAccount(Base):
    __tablename__ = "bank_accounts"
    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    account_group_id: Mapped[int] = mapped_column(ForeignKey("account_groups.id", ondelete="CASCADE"))
    credential_id: Mapped[int] = mapped_column(
        ForeignKey("bank_credentials.id", ondelete="RESTRICT"),
    )
    provider: Mapped[str] = mapped_column(String(64), index=True)
    iban: Mapped[str] = mapped_column(String(34))
    name: Mapped[str] = mapped_column(String(255))
    currency: Mapped[str] = mapped_column(String(8), default="EUR")
    balance: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=Decimal("0"))
    balance_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    # Cache: letzte Buchung mit Standard-Kategorie „Gehalt“ (Geldeingang); Recompute via salary_cache.
    last_salary_booking_date: Mapped[Optional[date]] = mapped_column(Date, nullable=True)
    last_salary_amount: Mapped[Optional[Decimal]] = mapped_column(Numeric(18, 2), nullable=True)

    account_group: Mapped[AccountGroup] = relationship(back_populates="bank_accounts")
    credential: Mapped[BankCredential] = relationship(back_populates="bank_accounts")
    transactions: Mapped[list[Transaction]] = relationship(
        back_populates="bank_account",
        cascade="all, delete-orphan",
    )
    sync_state: Mapped[Optional["AccountSyncState"]] = relationship(
        back_populates="bank_account",
        cascade="all, delete-orphan",
        single_parent=True,
    )
    balance_snapshots: Mapped[list["BankAccountBalanceSnapshot"]] = relationship(
        back_populates="bank_account",
        cascade="all, delete-orphan",
    )

    __table_args__ = (UniqueConstraint("provider", "iban", name="uq_bank_provider_iban"),)


class AccountSyncState(Base):
    """Pro Konto genau ein Status – kein doppelter Import über mehrere Nutzer."""
    __tablename__ = "account_sync_states"
    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    bank_account_id: Mapped[int] = mapped_column(
        ForeignKey("bank_accounts.id", ondelete="CASCADE"), unique=True
    )
    balance_attempt_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    balance_success_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    transactions_attempt_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    transactions_success_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    last_error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(32), default=SyncStatus.never.value)
    cursor_booking_date: Mapped[Optional[date]] = mapped_column(Date, nullable=True)

    bank_account: Mapped[BankAccount] = relationship(back_populates="sync_state")


class BankAccountBalanceSnapshot(Base):
    """Saldo-Historie: eine Zeile pro erfolgreich abgerufenem Stand (Sync)."""

    __tablename__ = "bank_account_balance_snapshots"
    __table_args__ = (
        Index(
            "ix_bank_account_balance_snapshots_account_recorded",
            "bank_account_id",
            "recorded_at",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    bank_account_id: Mapped[int] = mapped_column(ForeignKey("bank_accounts.id", ondelete="CASCADE"))
    balance: Mapped[Decimal] = mapped_column(Numeric(18, 2))
    currency: Mapped[str] = mapped_column(String(8))
    recorded_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)

    bank_account: Mapped[BankAccount] = relationship(back_populates="balance_snapshots")


class Category(Base):
    """Hierarchische Kategorien (Haupt / Unter) mit Farbe, Emoji und optionalem Bild."""
    __tablename__ = "categories"
    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    household_id: Mapped[int] = mapped_column(ForeignKey("households.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(255))
    parent_id: Mapped[Optional[int]] = mapped_column(ForeignKey("categories.id"), nullable=True)
    color_hex: Mapped[Optional[str]] = mapped_column(String(8), nullable=True)
    icon_emoji: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    image_mime: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    image_base64: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_by_user_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )

    household: Mapped[Household] = relationship(back_populates="categories")
    parent: Mapped[Optional["Category"]] = relationship(
        remote_side="Category.id",
        foreign_keys=[parent_id],
        back_populates="children",
    )
    children: Mapped[list["Category"]] = relationship(
        back_populates="parent",
        cascade="all, delete-orphan",
    )
    tagged_transactions: Mapped[list["Transaction"]] = relationship(back_populates="category")
    assignment_rules: Mapped[list["CategoryRule"]] = relationship(back_populates="category")
    created_by_user: Mapped[Optional["User"]] = relationship(
        "User",
        back_populates="categories_created",
        foreign_keys=[created_by_user_id],
    )


class CategoryRule(Base):
    """Automatische Kategorie-Zuordnung pro Haushalt (neuere Regeln zuerst geprüft)."""

    __tablename__ = "category_rules"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    household_id: Mapped[int] = mapped_column(ForeignKey("households.id", ondelete="CASCADE"))
    category_id: Mapped[int] = mapped_column(ForeignKey("categories.id", ondelete="CASCADE"))
    rule_type: Mapped[str] = mapped_column(String(32))
    pattern: Mapped[str] = mapped_column(String(512))
    conditions_json: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_by_user_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    # True: alle Konten des Haushalts; False: nur Konten, die der Ersteller seiner Sicht nach sieht (Mitgliedschaft).
    applies_to_household: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    household: Mapped[Household] = relationship(back_populates="category_rules")
    category: Mapped[Category] = relationship(back_populates="assignment_rules")
    created_by_user: Mapped[Optional["User"]] = relationship(
        "User",
        back_populates="category_rules_created",
        foreign_keys=[created_by_user_id],
    )


class CategoryRuleSuggestionDismissal(Base):
    """Vom Nutzer ausgeblendeter Regel-Vorschlag (Snapshot für Anzeige unter „Ignoriert“)."""

    __tablename__ = "category_rule_suggestion_dismissals"
    __table_args__ = (
        UniqueConstraint(
            "household_id",
            "rule_type",
            "pattern_norm",
            name="uq_cat_rule_suggestion_dismissal_hh_type_pat",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    household_id: Mapped[int] = mapped_column(ForeignKey("households.id", ondelete="CASCADE"))
    rule_type: Mapped[str] = mapped_column(String(32))
    pattern_norm: Mapped[str] = mapped_column(String(512))
    pattern_display: Mapped[str] = mapped_column(String(512))
    snapshot_transaction_count: Mapped[int] = mapped_column()
    snapshot_distinct_label_count: Mapped[int] = mapped_column()
    sample_labels_json: Mapped[str] = mapped_column(Text, default="[]")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    household: Mapped[Household] = relationship(back_populates="category_rule_suggestion_dismissals")


class Transaction(Base):
    __tablename__ = "transactions"
    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    bank_account_id: Mapped[int] = mapped_column(ForeignKey("bank_accounts.id", ondelete="CASCADE"))
    external_id: Mapped[str] = mapped_column(String(512))
    amount: Mapped[Decimal] = mapped_column(Numeric(18, 2))
    currency: Mapped[str] = mapped_column(String(8), default="EUR")
    booking_date: Mapped[date] = mapped_column(Date)
    value_date: Mapped[Optional[date]] = mapped_column(Date, nullable=True)
    description: Mapped[str] = mapped_column(Text, default="")
    counterparty: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    category_id: Mapped[Optional[int]] = mapped_column(ForeignKey("categories.id"), nullable=True)
    imported_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    bank_account: Mapped[BankAccount] = relationship(back_populates="transactions")
    category: Mapped[Optional["Category"]] = relationship(back_populates="tagged_transactions")
    enrichments: Mapped[list["TransactionEnrichment"]] = relationship(
        back_populates="transaction",
        cascade="all, delete-orphan",
    )

    __table_args__ = (UniqueConstraint("bank_account_id", "external_id", name="uq_tx_account_ext"),)


class ExternalTransactionRecord(Base):
    """Externe Handels-/Plattformdaten (PayPal/Amazon), unabhängig von Bankkonten."""

    __tablename__ = "external_transaction_records"
    __table_args__ = (
        UniqueConstraint("source", "external_ref", name="uq_ext_record_source_ref"),
        Index("ix_ext_record_household_source_date", "household_id", "source", "booking_date"),
        Index("ix_ext_record_amount_currency", "amount", "currency"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    household_id: Mapped[int] = mapped_column(ForeignKey("households.id", ondelete="CASCADE"))
    source: Mapped[str] = mapped_column(String(32), index=True)
    external_ref: Mapped[str] = mapped_column(String(255), default="")
    booking_date: Mapped[date] = mapped_column(Date)
    amount: Mapped[Decimal] = mapped_column(Numeric(18, 2))
    currency: Mapped[str] = mapped_column(String(8), default="EUR")
    description: Mapped[str] = mapped_column(Text, default="")
    counterparty: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    vendor: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    details_json: Mapped[str] = mapped_column(Text, default="{}")
    raw_json: Mapped[str] = mapped_column(Text, default="{}")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    household: Mapped[Household] = relationship(back_populates="external_transaction_records")
    tx_links: Mapped[list["TransactionEnrichment"]] = relationship(
        back_populates="external_record",
        cascade="all, delete-orphan",
    )


class TransactionEnrichment(Base):
    """Verknüpft eine Bankbuchung mit externer Zusatzinformation pro Quelle."""

    __tablename__ = "transaction_enrichments"
    __table_args__ = (
        UniqueConstraint("external_record_id", "source", name="uq_tx_enrichment_record_source"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    transaction_id: Mapped[int] = mapped_column(ForeignKey("transactions.id", ondelete="CASCADE"))
    external_record_id: Mapped[int] = mapped_column(
        ForeignKey("external_transaction_records.id", ondelete="CASCADE")
    )
    source: Mapped[str] = mapped_column(String(32), index=True)
    matched_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    transaction: Mapped[Transaction] = relationship(back_populates="enrichments")
    external_record: Mapped[ExternalTransactionRecord] = relationship(back_populates="tx_links")
