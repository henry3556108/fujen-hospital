import posixpath
import re
from urllib.parse import unquote

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


_RULES: list[tuple[re.Pattern, Permission]] = [
    (re.compile(r"^/api/projects/(?P<pid>\d+)/inference(/|$)"), Permission.PREDICTION),
    (re.compile(r"^/api/projects/(?P<pid>\d+)/training(/|$)"), Permission.TRAINING),
    (re.compile(r"^/api/projects/(?P<pid>\d+)/labels(/|$)"), Permission.LABELING),
    (re.compile(r"^/api/projects/(?P<pid>\d+)/code(/|$)"), Permission.CODING),
    (re.compile(r"^/api/projects/(?P<pid>\d+)(/|$)"), Permission.PROJECT),
]


def _normalize(path: str) -> str:
    # 不用 urlsplit：它會把 "//api/..." 的 "api" 當成主機名稱。
    decoded = unquote(path.split("?", 1)[0])
    return posixpath.normpath("/" + decoded.lstrip("/"))


def match_rule(path: str) -> tuple[int, Permission] | None:
    """由 Gateway 轉來的原始路徑決定專案與所需權限；比對不到就回 None（呼叫端預設拒絕）。"""
    normalized = _normalize(path)
    for pattern, permission in _RULES:
        m = pattern.match(normalized)
        if m:
            return int(m.group("pid")), permission
    return None
