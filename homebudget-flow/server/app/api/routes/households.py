from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import CurrentUser
from app.db.models import (
    AccountGroup,
    AccountGroupMember,
    BankAccount,
    BankCredential,
    Household,
    HouseholdInvitation,
    HouseholdMember,
    HouseholdMemberRole,
    User,
)
from app.db.session import get_session
from app.schemas.household import (
    AccountGroupCreate,
    AccountGroupMemberOut,
    AccountGroupMembersPut,
    AccountGroupOut,
    AccountGroupUpdate,
    BankAccountCreate,
    BankAccountOut,
    HouseholdCreate,
    HouseholdInvitationCreate,
    HouseholdInvitationOutgoingOut,
    HouseholdInvitationOut,
    HouseholdMemberOut,
    HouseholdOut,
    HouseholdUpdate,
    bank_account_to_out,
    household_to_out,
)
from app.services.access import (
    user_can_access_account_group,
    user_can_manage_account_group_sharing,
    user_can_view_account_group_members,
    user_has_household,
    user_is_household_owner,
)
from app.services.bank_account_provision import normalize_iban
from app.services.default_income_categories import ensure_income_category_tree

router = APIRouter(prefix="/households", tags=["households"])

_INVITE_VALID_DAYS = 14


@router.get("/invitations/incoming", response_model=list[HouseholdInvitationOut])
async def list_incoming_invitations(
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
) -> list[HouseholdInvitationOut]:
    now = datetime.utcnow()
    r = await session.execute(
        select(HouseholdInvitation)
        .where(
            HouseholdInvitation.invitee_user_id == user.id,
            HouseholdInvitation.expires_at > now,
        )
        .options(
            selectinload(HouseholdInvitation.household),
            selectinload(HouseholdInvitation.inviter),
            selectinload(HouseholdInvitation.invitee),
        )
    )
    rows = r.scalars().all()
    return [
        HouseholdInvitationOut(
            id=inv.id,
            household_id=inv.household_id,
            household_name=inv.household.name,
            inviter_email=inv.inviter.email,
            invitee_email=inv.invitee.email,
            created_at=inv.created_at,
            expires_at=inv.expires_at,
        )
        for inv in rows
    ]


@router.post("/invitations/{invitation_id}/accept", response_model=HouseholdOut)
async def accept_household_invitation(
    invitation_id: int,
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
) -> HouseholdOut:
    r_inv = await session.execute(
        select(HouseholdInvitation)
        .where(HouseholdInvitation.id == invitation_id)
        .options(selectinload(HouseholdInvitation.household)),
    )
    inv = r_inv.scalar_one_or_none()
    if inv is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Einladung nicht gefunden.")
    if inv.invitee_user_id != user.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Diese Einladung gilt nicht für dich.")
    now = datetime.utcnow()
    if inv.expires_at <= now:
        await session.delete(inv)
        await session.commit()
        raise HTTPException(status.HTTP_410_GONE, "Die Einladung ist abgelaufen.")
    r_m = await session.execute(
        select(HouseholdMember.id).where(
            HouseholdMember.user_id == user.id,
            HouseholdMember.household_id == inv.household_id,
        )
    )
    if r_m.scalar_one_or_none() is not None:
        await session.delete(inv)
        await session.commit()
        raise HTTPException(status.HTTP_409_CONFLICT, "Du bist bereits Mitglied dieses Haushalts.")
    session.add(
        HouseholdMember(
            household_id=inv.household_id,
            user_id=user.id,
            role=HouseholdMemberRole.member.value,
        )
    )
    await session.delete(inv)
    await session.commit()
    return household_to_out(inv.household, HouseholdMemberRole.member.value)


@router.delete("/invitations/{invitation_id}", status_code=status.HTTP_204_NO_CONTENT)
async def decline_or_revoke_invitation(
    invitation_id: int,
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
) -> None:
    inv = await session.get(HouseholdInvitation, invitation_id)
    if inv is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Einladung nicht gefunden.")
    if inv.invitee_user_id == user.id:
        await session.delete(inv)
        await session.commit()
        return
    if await user_is_household_owner(session, user.id, inv.household_id):
        await session.delete(inv)
        await session.commit()
        return
    raise HTTPException(status.HTTP_403_FORBIDDEN, "Keine Berechtigung für diese Einladung.")


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
    return household_to_out(h, HouseholdMemberRole.owner.value)


@router.get("", response_model=list[HouseholdOut])
async def list_households(user: CurrentUser, session: AsyncSession = Depends(get_session)) -> list[HouseholdOut]:
    r = await session.execute(
        select(Household, HouseholdMember)
        .join(HouseholdMember)
        .where(HouseholdMember.user_id == user.id),
    )
    rows = r.all()
    return [household_to_out(h, hm.role) for h, hm in rows]


@router.get("/{household_id}/members", response_model=list[HouseholdMemberOut])
async def list_household_members(
    household_id: int,
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
) -> list[HouseholdMemberOut]:
    if not await user_has_household(session, user.id, household_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Kein Zugriff auf diesen Haushalt.")
    r = await session.execute(
        select(HouseholdMember, User)
        .join(User, User.id == HouseholdMember.user_id)
        .where(HouseholdMember.household_id == household_id)
        .order_by(User.email)
    )
    return [
        HouseholdMemberOut(
            user_id=u.id,
            email=u.email,
            display_name=u.display_name,
            role=hm.role,
        )
        for hm, u in r.all()
    ]


@router.get("/account-groups/{account_group_id}/members", response_model=list[AccountGroupMemberOut])
async def list_account_group_members(
    account_group_id: int,
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
) -> list[AccountGroupMemberOut]:
    if not await user_can_view_account_group_members(session, user.id, account_group_id):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "Kein Zugriff auf die Mitgliederliste dieser Kontogruppe.",
        )
    r = await session.execute(
        select(AccountGroupMember, User)
        .join(User, User.id == AccountGroupMember.user_id)
        .where(AccountGroupMember.account_group_id == account_group_id)
        .order_by(User.email)
    )
    return [
        AccountGroupMemberOut(
            user_id=u.id,
            email=u.email,
            display_name=u.display_name,
            can_edit=agm.can_edit,
        )
        for agm, u in r.all()
    ]


@router.put("/account-groups/{account_group_id}/members", response_model=list[AccountGroupMemberOut])
async def put_account_group_members(
    account_group_id: int,
    body: AccountGroupMembersPut,
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
) -> list[AccountGroupMemberOut]:
    if not await user_can_manage_account_group_sharing(session, user.id, account_group_id):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "Keine Berechtigung, die Mitgliedschaft dieser Kontogruppe zu ändern.",
        )
    g = await session.get(AccountGroup, account_group_id)
    if g is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Kontogruppe nicht gefunden.")
    uids = sorted(set(body.user_ids))
    if len(uids) < 1:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Mindestens eine Person muss Zugriff haben.",
        )
    r_hm = await session.execute(
        select(HouseholdMember.user_id).where(
            HouseholdMember.household_id == g.household_id,
            HouseholdMember.user_id.in_(uids),
        )
    )
    ok = {row[0] for row in r_hm.all()}
    if len(ok) != len(uids):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Nur Nutzer, die Mitglied dieses Haushalts sind, können freigeschaltet werden.",
        )
    await session.execute(delete(AccountGroupMember).where(AccountGroupMember.account_group_id == account_group_id))
    for uid in uids:
        session.add(AccountGroupMember(account_group_id=account_group_id, user_id=uid, can_edit=True))
    await session.commit()
    r_out = await session.execute(
        select(AccountGroupMember, User)
        .join(User, User.id == AccountGroupMember.user_id)
        .where(AccountGroupMember.account_group_id == account_group_id)
        .order_by(User.email)
    )
    return [
        AccountGroupMemberOut(
            user_id=u.id,
            email=u.email,
            display_name=u.display_name,
            can_edit=agm.can_edit,
        )
        for agm, u in r_out.all()
    ]


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
    hm_r = await session.execute(
        select(HouseholdMember.role).where(
            HouseholdMember.user_id == user.id,
            HouseholdMember.household_id == household_id,
        ),
    )
    my_role = hm_r.scalar_one()
    return household_to_out(h, my_role)


@router.post("/{household_id}/invitations", response_model=HouseholdInvitationOutgoingOut)
async def create_household_invitation(
    household_id: int,
    body: HouseholdInvitationCreate,
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
) -> HouseholdInvitationOutgoingOut:
    if not await user_is_household_owner(session, user.id, household_id):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "Nur der Haushaltsbesitzer kann andere Personen einladen.",
        )
    email_norm = body.email.strip().lower()
    if not email_norm:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "E-Mail darf nicht leer sein.")
    r_u = await session.execute(select(User).where(func.lower(User.email) == email_norm))
    invitee = r_u.scalar_one_or_none()
    if invitee is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            "Kein Benutzer mit dieser E-Mail — die Person braucht zuerst ein Konto.",
        )
    if invitee.id == user.id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Du kannst dich nicht selbst einladen.")
    r_mem = await session.execute(
        select(HouseholdMember.id).where(
            HouseholdMember.user_id == invitee.id,
            HouseholdMember.household_id == household_id,
        ),
    )
    if r_mem.scalar_one_or_none() is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Diese Person ist bereits Mitglied dieses Haushalts.")
    if await session.get(Household, household_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Haushalt nicht gefunden.")
    exp = datetime.utcnow() + timedelta(days=_INVITE_VALID_DAYS)
    inv = HouseholdInvitation(
        household_id=household_id,
        inviter_user_id=user.id,
        invitee_user_id=invitee.id,
        expires_at=exp,
    )
    session.add(inv)
    try:
        await session.commit()
        await session.refresh(inv)
    except IntegrityError as e:
        await session.rollback()
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Für diese Person liegt bereits eine ausstehende Einladung vor.",
        ) from e
    return HouseholdInvitationOutgoingOut(
        id=inv.id,
        invitee_email=invitee.email,
        created_at=inv.created_at,
        expires_at=inv.expires_at,
    )


@router.get("/{household_id}/invitations", response_model=list[HouseholdInvitationOutgoingOut])
async def list_outgoing_invitations(
    household_id: int,
    user: CurrentUser,
    session: AsyncSession = Depends(get_session),
) -> list[HouseholdInvitationOutgoingOut]:
    if not await user_is_household_owner(session, user.id, household_id):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "Nur der Haushaltsbesitzer sieht ausstehende Einladungen.",
        )
    now = datetime.utcnow()
    r = await session.execute(
        select(HouseholdInvitation, User)
        .join(User, User.id == HouseholdInvitation.invitee_user_id)
        .where(
            HouseholdInvitation.household_id == household_id,
            HouseholdInvitation.expires_at > now,
        ),
    )
    return [
        HouseholdInvitationOutgoingOut(
            id=inv.id,
            invitee_email=u.email,
            created_at=inv.created_at,
            expires_at=inv.expires_at,
        )
        for inv, u in r.all()
    ]


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
