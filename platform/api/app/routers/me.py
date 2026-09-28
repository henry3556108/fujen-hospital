from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.deps import current_user, get_session
from app.models import Membership, Project, User
from app.permissions import AccountType, Permission

router = APIRouter(prefix="/api")

ALL_PERMISSIONS = sorted(p.value for p in Permission)


@router.get("/me")
def me(user: User = Depends(current_user), session: Session = Depends(get_session)) -> dict:
    if user.account_type == AccountType.ADMIN:
        projects = [
            {"id": p.id, "name": p.name, "role": None, "permissions": ALL_PERMISSIONS}
            for p in session.scalars(select(Project).order_by(Project.id))
        ]
    else:
        rows = session.execute(
            select(Project, Membership).join(Membership, Membership.project_id == Project.id)
            .where(Membership.user_id == user.id).order_by(Project.id)
        )
        projects = [
            {"id": p.id, "name": p.name, "role": m.role, "permissions": sorted(m.permissions)}
            for p, m in rows
        ]
    return {"username": user.username, "account_type": user.account_type, "projects": projects}
