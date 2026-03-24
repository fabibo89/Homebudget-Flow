from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import CurrentUser
from app.db.models import (
    AccountGroup,
    AccountGroupMember,
    BankAccount,
    BankCredential,
    Household,
    HouseholdMember,
    HouseholdMemberRole,
)
from app.db.session import get_session
from app.schemas.household import (
    AccountGroupCreate,
    AccountGroupOut,
    AccountGroupUpdate,
    BankAccountCreate,
    BankAccountOut,
    HouseholdCreate,
    HouseholdOut,
    HouseholdUpdate,
    bank_account_to_out,
)
from app.services.access import user_can_access_account_group, user_has_household
from app.services.bank_account_provision import normalize_iban
from app.services.default_income_categories import ensure_income_category_tree

router = APIRouter(prefix="/households", tags=["households"])


@router.delete("/account-groups/{account_group_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_account_group(
    account_group_id: int,
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
) -> None:
    if not await user_can_access_account_group(session, user.id, account_group_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Kein Zugriff auf diese Kontogruppe.")
    g = await session.get(AccountGroup, account_group_id)
    if g is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Kontogruppe nicht gefunden.")
    await session.delete(g)
    await session.commit()


@router.delete("/{household_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_household(
    household_id: int,
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
) -> None:
    r = await session.execute(
        select(HouseholdMember).where(
            HouseholdMember.user_id == user.id,
            HouseholdMember.household_id == household_id,
            HouseholdMember.role == HouseholdMemberRole.owner.value,
        )
    )
    if r.scalar_one_or_none() is None:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "Nur der Haushaltsbesitzer kann den Haushalt löschen.",
        )
    h = await session.get(Household, household_id)
    if h is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Haushalt nicht gefunden.")
    await session.delete(h)
    await session.commit()


@router.post("", response_model=HouseholdOut)
async def create_household(
    body: HouseholdCreate,
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
) -> HouseholdOut:
    h = Household(name=body.name)
    session.add(h)
    await session.flush()
    session.add(
        HouseholdMember(
            household_id=h.id,
            user_id=user.id,
            role=HouseholdMemberRole.owner.value,
        )
    )
    await session.flush()
    await ensure_income_category_tree(session, h.id, created_by_user_id=user.id)
    await session.commit()
    await session.refresh(h)
    return HouseholdOut.model_validate(h)


@router.get("", response_model=list[HouseholdOut])
async def list_households(user: CurrentUser, session: AsyncSession = Depends(get_session)) -> list[HouseholdOut]:
    r = await session.execute(
        select(Household)
        .join(HouseholdMember)
        .where(HouseholdMember.user_id == user.id)
    )
    rows = r.scalars().all()
    return [HouseholdOut.model_validate(x) for x in rows]


@router.patch("/account-groups/{account_group_id}", response_model=AccountGroupOut)
async def update_account_group(
    account_group_id: int,
    body: AccountGroupUpdate,
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
) -> AccountGroupOut:
    if not await user_can_access_account_group(session, user.id, account_group_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Kein Zugriff auf diese Kontogruppe.")
    g = await session.get(AccountGroup, account_group_id)
    if g is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Kontogruppe nicht gefunden.")
    data = body.model_dump(exclude_unset=True)
    if "name" in data and data["name"] is not None:
        n = str(data["name"]).strip()
        if not n:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Name darf nicht leer sein.")
        g.name = n
    if "description" in data and data["description"] is not None:
        g.description = str(data["description"]).strip()
    await session.commit()
    await session.refresh(g)
    return AccountGroupOut.model_validate(g)


@router.patch("/{household_id}", response_model=HouseholdOut)
async def update_household(
    household_id: int,
    body: HouseholdUpdate,
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
) -> HouseholdOut:
    if not await user_has_household(session, user.id, household_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Kein Zugriff auf diesen Haushalt.")
    h = await session.get(Household, household_id)
    if h is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Haushalt nicht gefunden.")
    data = body.model_dump(exclude_unset=True)
    if "name" in data and data["name"] is not None:
        n = str(data["name"]).strip()
        if not n:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Name darf nicht leer sein.")
        h.name = n
    await session.commit()
    await session.refresh(h)
    return HouseholdOut.model_validate(h)


@router.get("/{household_id}/account-groups", response_model=list[AccountGroupOut])
async def list_account_groups_for_household(
    household_id: int,
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
) -> list[AccountGroupOut]:
    if not await user_has_household(session, user.id, household_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "No access to household")
    r = await session.execute(
        select(AccountGroup).where(AccountGroup.household_id == household_id).order_by(AccountGroup.name)
    )
    rows = r.scalars().all()
    return [AccountGroupOut.model_validate(x) for x in rows]


@router.post("/account-groups", response_model=AccountGroupOut)
async def create_account_group(
    body: AccountGroupCreate,
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
) -> AccountGroupOut:
    if not await user_has_household(session, user.id, body.household_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "No access to household")
    g = AccountGroup(
        household_id=body.household_id,
        name=body.name,
        description=body.description,
    )
    session.add(g)
    await session.flush()
    members = {user.id, *body.member_user_ids}
    for uid in members:
        session.add(AccountGroupMember(account_group_id=g.id, user_id=uid))
    await session.commit()
    await session.refresh(g)
    return AccountGroupOut.model_validate(g)


@router.post("/bank-accounts", response_model=BankAccountOut)
async def create_bank_account(
    body: BankAccountCreate,
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
) -> BankAccountOut:
    r = await session.execute(select(AccountGroup).where(AccountGroup.id == body.account_group_id))
    g = r.scalar_one_or_none()
    if g is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Account group not found")
    if not await user_can_access_account_group(session, user.id, g.id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "No access to this account group")
    cr = await session.get(BankCredential, body.credential_id)
    if cr is None or cr.user_id != user.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Ungültiger FinTS-Zugang.")
    cred_id = cr.id
    iban_norm = normalize_iban(body.iban)
    if len(iban_norm) < 15:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Ungültige IBAN (mindestens 15 Zeichen nach Normalisierung).",
        )
    acc = BankAccount(
        account_group_id=body.account_group_id,
        credential_id=cred_id,
        provider=body.provider,
        name=body.name,
        iban=iban_norm,
        currency=body.currency,
    )
    session.add(acc)
    try:
        await session.commit()
        await session.refresh(acc)
    except IntegrityError as e:
        await session.rollback()
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Ein Konto mit dieser Provider- und IBAN-Kombination existiert bereits.",
        ) from e
    return bank_account_to_out(acc, None, household_id=g.household_id)
