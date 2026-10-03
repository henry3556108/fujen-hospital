"""唯讀稽核檢視（A-03 第 6 項、D-01 抽查）。只有 GET：稽核紀錄沒有修改或刪除的 API（TC-SS-07），
資料庫層另由 db-init 限制平台帳號對 audit_log 只有 INSERT 與 SELECT。"""
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.audit import AuditCategory
from app.deps import get_session, require_admin
from app.models import AuditLog, User

router = APIRouter(prefix="/api/admin/audit", tags=["audit"])


def _utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def _escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def entry_out(e: AuditLog) -> dict:
    return {"id": e.id, "at": _utc(e.at), "actor": e.actor, "category": e.category, "action": e.action,
            "target": e.target, "result": e.result, "source_ip": e.source_ip, "detail": e.detail}


@router.get("")
def list_audit(
    category: AuditCategory | None = None,
    actor: str | None = Query(default=None, max_length=64, description="操作者帳號（完全相同）"),
    action: str | None = Query(default=None, max_length=64, description="動作開頭，例如 labeling_group."),
    result: str | None = Query(default=None, max_length=16, description="結果（完全相同），例如 success、failed"),
    since: datetime | None = Query(default=None, description="起（含），ISO 8601；未帶時區視為 UTC"),
    until: datetime | None = Query(default=None, description="迄（不含），ISO 8601"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=200),
    admin: User = Depends(require_admin),
    session: Session = Depends(get_session),
) -> dict:
    since, until = _utc(since), _utc(until)
    if since and until and until <= since:
        raise HTTPException(422, "結束時間不可早於或等於開始時間")
    conditions = []
    if category is not None:
        conditions.append(AuditLog.category == category.value)
    if actor:
        conditions.append(AuditLog.actor == actor)
    if action:
        conditions.append(AuditLog.action.like(_escape_like(action) + "%", escape="\\"))
    if result:
        conditions.append(AuditLog.result == result)
    if since is not None:
        conditions.append(AuditLog.at >= since)
    if until is not None:
        conditions.append(AuditLog.at < until)
    total = session.scalar(select(func.count()).select_from(AuditLog).where(*conditions)) or 0
    rows = session.scalars(select(AuditLog).where(*conditions).order_by(AuditLog.id.desc())
                           .offset((page - 1) * page_size).limit(page_size)).all()
    return {"total": total, "page": page, "page_size": page_size, "items": [entry_out(e) for e in rows]}
