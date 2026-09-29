import logging
import posixpath
import re
from dataclasses import dataclass
from urllib.parse import parse_qsl, unquote

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Membership, User
from app.permissions import AccountType, Permission, split_permissions

log = logging.getLogger(__name__)


def effective_permissions(session: Session, user: User, project_id: int) -> frozenset[Permission]:
    """每次都查資料庫，不快取：權限變更在下一個請求就生效。"""
    if user.account_type == AccountType.ADMIN:
        return frozenset(Permission)
    membership = session.scalar(
        select(Membership).where(Membership.user_id == user.id, Membership.project_id == project_id)
    )
    if membership is None:
        return frozenset()
    known, unknown = split_permissions(membership.permissions)
    if unknown:
        log.warning("成員資格 %s（使用者 %s、專案 %s）含不認得的權限 %s，已忽略；請管理者重新指派角色或權限",
                    membership.id, user.username, project_id, unknown)
    return known


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


@dataclass(frozen=True)
class DicomwebTarget:
    """DICOMweb 請求指向的專案與研究（series／instance 若路徑有帶）。所需權限固定為 Project。"""
    project_id: int
    study_uid: str
    series_uid: str | None
    instance_uid: str | None


_UID = r"[0-9]+(?:\.[0-9]+)*"
_DICOMWEB = re.compile(
    rf"^/dicomweb/projects/(?P<pid>\d+)/studies/(?P<study>{_UID})"
    rf"(?:/(?:metadata|rendered|thumbnail|series|instances)"
    rf"|/series/(?P<series>{_UID})"
    rf"(?:/(?:metadata|rendered|thumbnail|instances)"
    rf"|/instances/(?P<instance>{_UID})"
    rf"(?:/(?:metadata|rendered|thumbnail|frames/\d+(?:,\d+)*(?:/rendered)?|bulk(?:/[0-9A-Fa-f]{{8}}|/\d+)+))?"
    rf")?)?$"
)
_DICOMWEB_SEARCH = re.compile(r"^/dicomweb/projects/(?P<pid>\d+)/studies$")
_SEARCH_EXTRA_KEYS = {"includefield", "limit", "offset"}
_UID_ONLY = re.compile(rf"^{_UID}$")


def match_dicomweb(uri: str) -> DicomwebTarget | None:
    """`/dicomweb/projects/{pid}/...` 的原始 URI（含查詢字串）→ 目標研究；不是允許的形式一律 None。

    研究層級以下的路徑只接受固定的 DICOMweb 子資源。研究列表搜尋（QIDO /studies）會列出節點上所有研究，
    所以只允許 `?StudyInstanceUID=<單一 UID>`：不接受 UID 清單（, 或 \\）、萬用字元、重複鍵或以標籤碼寫的同義鍵。
    查詢字串不可含 %、;、\\、NUL，避免 Gateway 與 Orthanc 解碼不一致。"""
    path, _, query = uri.partition("?")
    normalized = _canonical(path)
    if normalized is None or any(c in query for c in _FORBIDDEN_CHARS + ("#",)):
        return None
    m = _DICOMWEB.match(normalized)
    if m:
        return DicomwebTarget(int(m["pid"]), m["study"], m["series"], m["instance"])
    m = _DICOMWEB_SEARCH.match(normalized)
    if not m:
        return None
    pairs = parse_qsl(query, keep_blank_values=True)
    keys = [k for k, _ in pairs]
    uids = [v for k, v in pairs if k == "StudyInstanceUID"]
    if len(uids) != 1 or not _UID_ONLY.match(uids[0]) or len(set(keys)) != len(keys):
        return None
    if any(k not in _SEARCH_EXTRA_KEYS | {"StudyInstanceUID"} for k in keys):
        return None
    return DicomwebTarget(int(m["pid"]), uids[0], None, None)


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
