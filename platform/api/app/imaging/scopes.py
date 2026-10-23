"""資料範圍（imaging scopes）：專案內具名的研究篩選條件。說明見 README-scopes.md。

filters 的 key 與研究列表 API（GET /imaging/studies）的查詢參數同名；存的是條件不是清單，
所以之後新匯入、符合條件的研究自動算在範圍內。研究一律先套用 Accession 清單（看得到的才算）。
"""
from typing import Any

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.audit import AuditCategory, record
from app.admin_service import NotFound
from app.imaging.models import ImagingScope, ImagingStudy
from app.imaging.service import _studies_query

# 與研究列表查詢參數同名
FILTER_KEYS = ("modality", "patient_sex", "study_description", "study_date", "study_date_from", "study_date_to",
               "series_description")
# 別名：前端若送 sex 也接受，存檔時改成 patient_sex
ALIASES = {"sex": "patient_sex"}


def _iso(value) -> str:
    from app.labeling.service import _iso as iso
    return iso(value)


def normalise_filters(raw: Any) -> dict[str, str]:
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise HTTPException(422, "filters 必須是物件")
    out: dict[str, str] = {}
    for key, value in raw.items():
        key = ALIASES.get(key, key)
        if key not in FILTER_KEYS:
            raise HTTPException(422, f"不支援的篩選條件：{key}（可用：{'、'.join(FILTER_KEYS)}）")
        if value is None or (isinstance(value, str) and not value.strip()):
            continue
        if not isinstance(value, str):
            raise HTTPException(422, f"篩選條件 {key} 必須是文字")
        out[key] = value.strip()[:256]
    return dict(sorted(out.items()))


def scope_query(session: Session, project_id: int, filters: dict[str, str]):
    return _studies_query(session, project_id, **filters)


def scope_study_uids(session: Session, scope: ImagingScope) -> set[str]:
    q = scope_query(session, scope.project_id, scope.filters or {})
    return set(session.scalars(q.with_only_columns(ImagingStudy.study_instance_uid)))


def study_count(session: Session, scope: ImagingScope) -> int:
    q = scope_query(session, scope.project_id, scope.filters or {})
    return session.scalar(select(func.count()).select_from(q.subquery())) or 0


def scope_out(session: Session, scope: ImagingScope) -> dict:
    return {"id": scope.id, "name": scope.name, "filters": scope.filters or {},
            "study_count": study_count(session, scope), "created_by": scope.created_by,
            "created_at": _iso(scope.created_at)}


def get_scope(session: Session, project_id: int, scope_id: int) -> ImagingScope:
    scope = session.get(ImagingScope, scope_id)
    if scope is None or scope.project_id != project_id:
        raise NotFound(f"找不到資料範圍 {scope_id}")
    return scope


def list_scopes(session: Session, project_id: int) -> list[ImagingScope]:
    return list(session.scalars(select(ImagingScope).where(ImagingScope.project_id == project_id)
                                .order_by(ImagingScope.id)))


def _check_name(session: Session, project_id: int, name: str, exclude: int | None = None) -> str:
    name = (name or "").strip()
    if not name or len(name) > 128:
        raise HTTPException(422, "名稱不可空白，最多 128 字")
    q = select(ImagingScope.id).where(ImagingScope.project_id == project_id, ImagingScope.name == name)
    if exclude is not None:
        q = q.where(ImagingScope.id != exclude)
    if session.scalar(q) is not None:
        raise HTTPException(409, f"已有名稱為「{name}」的資料範圍")
    return name


def _audit(session: Session, scope: ImagingScope, action: str, actor: str, source_ip: str | None) -> None:
    record(session, actor=actor, category=AuditCategory.DATASET, action=action,
           target=f"project:{scope.project_id}/scope:{scope.id}", source_ip=source_ip,
           detail={"name": scope.name, "filters": scope.filters})


def create_scope(session: Session, *, project_id: int, actor: str, source_ip: str | None, name: str,
                 filters: Any) -> ImagingScope:
    clean = normalise_filters(filters)
    scope_query(session, project_id, clean)       # 先驗證日期等格式
    scope = ImagingScope(project_id=project_id, name=_check_name(session, project_id, name), filters=clean,
                         created_by=actor)
    session.add(scope)
    session.flush()
    _audit(session, scope, "scope.create", actor, source_ip)
    session.commit()
    return scope


def update_scope(session: Session, *, project_id: int, scope_id: int, actor: str, source_ip: str | None,
                 name: str | None, filters: Any) -> ImagingScope:
    scope = get_scope(session, project_id, scope_id)
    if name is not None:
        scope.name = _check_name(session, project_id, name, exclude=scope.id)
    if filters is not None:
        clean = normalise_filters(filters)
        scope_query(session, project_id, clean)
        scope.filters = clean
    _audit(session, scope, "scope.update", actor, source_ip)
    session.commit()
    return scope


def delete_scope(session: Session, *, project_id: int, scope_id: int, actor: str, source_ip: str | None) -> None:
    """刪除範圍；用到它的標註資料集改成「不限範圍」。"""
    from app.labeling.models import LabelDataset

    scope = get_scope(session, project_id, scope_id)
    for ds in session.scalars(select(LabelDataset).where(LabelDataset.project_id == project_id,
                                                         LabelDataset.scope_id == scope.id)):
        ds.scope_id = None
    _audit(session, scope, "scope.delete", actor, source_ip)
    session.delete(scope)
    session.commit()
