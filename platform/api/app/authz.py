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


_FORBIDDEN_CHARS = ("%", ";", "\\", "\x00")


def _canonical(path: str) -> str | None:
    """回傳正規路徑；只要路徑不是正規形式（多次編碼、;、\\、NUL、. 或 .. 區段、//）就回 None。
    Gateway 轉送的是原始路徑，若這裡「正規化後放行」，上游解讀不同就會被繞過，所以一律拒絕。"""
    decoded = unquote(path.split("?", 1)[0])
    if any(c in decoded for c in _FORBIDDEN_CHARS):
        return None
    if posixpath.normpath(decoded) != decoded or decoded.startswith("//"):
        return None
    return decoded


def match_rule(path: str) -> tuple[int, Permission] | None:
    """由 Gateway 轉來的原始路徑決定專案與所需權限；比對不到就回 None（呼叫端預設拒絕）。"""
    normalized = _canonical(path)
    if normalized is None:
        return None
    for pattern, permission in _RULES:
        m = pattern.match(normalized)
        if m:
            return int(m.group("pid")), permission
    return None
