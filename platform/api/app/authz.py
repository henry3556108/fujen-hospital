from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Membership, User
from app.permissions import AccountType, Permission


def effective_permissions(session: Session, user: User, project_id: int) -> frozenset[Permission]:
    """每次都查資料庫，不快取：權限變更在下一個請求就生效。"""
    if user.account_type == AccountType.ADMIN:
        return frozenset(Permission)
    membership = session.scalar(
        select(Membership).where(Membership.user_id == user.id, Membership.project_id == project_id)
    )
    if membership is None:
        return frozenset()
    return frozenset(Permission(p) for p in membership.permissions)


def require_permission(session: Session, user: User, project_id: int, permission: Permission) -> None:
    if permission not in effective_permissions(session, user, project_id):
        raise HTTPException(403, {
            "code": "forbidden", "permission": permission.value, "message": f"你沒有 {permission.value} 權限",
        })
