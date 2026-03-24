"""Legt für jede erkannte SEPA-IBAN ein Bankkonto (Sync-Ziel) an, verknüpft mit dem FinTS-Zugang."""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import BankAccount, BankCredential


def normalize_iban(iban: str) -> str:
    s = "".join(str(iban).split()).upper().replace("-", "")
    return s


async def ensure_bank_accounts_from_sepa_accounts(
    session: AsyncSession,
    cred: BankCredential,
    sepa_accounts: list[Any],
    account_group_id: int,
) -> None:
    """Für jede gültige IBAN in ``sepa_accounts`` ein ``BankAccount`` in ``account_group_id``, falls noch nicht vorhanden."""
    provider = (cred.provider or "comdirect").strip() or "comdirect"
    for a in sepa_accounts:
        raw = str(getattr(a, "iban", "") or "").strip()
        ext_id = normalize_iban(raw)
        if len(ext_id) < 15:
            continue
        r = await session.execute(
            select(BankAccount).where(
                BankAccount.provider == provider,
                BankAccount.iban == ext_id,
            )
        )
        existing = r.scalar_one_or_none()
        if existing is not None:
            continue
        session.add(
            BankAccount(
                account_group_id=account_group_id,
                credential_id=cred.id,
                provider=provider,
                name=f"Girokonto ({ext_id[-4:]})",
                iban=ext_id,
                currency="EUR",
            )
        )
        await session.flush()
