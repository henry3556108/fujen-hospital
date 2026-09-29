"""標註服務：CRUD、評分、摘要。寫入與 dataset 稽核同一個交易。"""
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import audit
from app.admin_service import NotFound
from app.audit import AuditCategory
from app.imaging.models import ImagingInstance, ImagingSeries, ImagingStudy
from app.imaging.service import allowlist, find_accessible_study
from app.labeling.models import Annotation
from app.labeling.payloads import InvalidPayload, normalize
from app.models import utcnow

SOURCES = ("manual", "csv", "autolabel")


def _iso(value: datetime) -> str:
    if value.tzinfo is None:        # SQLite 不保留時區
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def annotation_out(a: Annotation) -> dict:
    return {
        "id": a.id, "project_id": a.project_id, "study_instance_uid": a.study_instance_uid,
        "series_instance_uid": a.series_instance_uid, "sop_instance_uid": a.sop_instance_uid,
        "kind": a.kind, "payload": a.payload, "source": a.source, "rating": a.rating, "version": a.version,
        "autolabel_run_id": a.autolabel_run_id, "created_by": a.created_by, "updated_by": a.updated_by,
        "created_at": _iso(a.created_at), "updated_at": _iso(a.updated_at),
    }


def _audit(session: Session, a: Annotation, action: str, *, actor: str, source_ip: str | None, **detail) -> None:
    audit.record(session, actor=actor, category=AuditCategory.DATASET, action=action,
                 target=f"project:{a.project_id}/annotation:{a.id}", source_ip=source_ip,
                 detail={"kind": a.kind, "source": a.source, "study_instance_uid": a.study_instance_uid,
                         "sop_instance_uid": a.sop_instance_uid, "version": a.version, **detail})


def resolve_target(session: Session, project_id: int, study_uid: str, series_uid: str | None,
                   sop_uid: str | None) -> tuple[ImagingStudy, str | None, str | None]:
    """確認研究可存取、series／影像屬於該研究；只給影像時補上它的 series。"""
    study = find_accessible_study(session, project_id, study_uid)
    if study is None:
        raise NotFound("找不到研究，或不在本專案的 Accession 清單內")
    series = None
    if series_uid is not None:
        series = session.scalar(select(ImagingSeries).where(ImagingSeries.study_id == study.id,
                                                            ImagingSeries.series_instance_uid == series_uid))
        if series is None:
            raise NotFound("找不到序列，或序列不屬於這個研究")
    if sop_uid is not None:
        q = (select(ImagingInstance, ImagingSeries).join(ImagingSeries, ImagingInstance.series_id == ImagingSeries.id)
             .where(ImagingSeries.study_id == study.id, ImagingInstance.sop_instance_uid == sop_uid))
        row = session.execute(q).first()
        if row is None or (series is not None and row[1].id != series.id):
            raise NotFound("找不到影像，或影像不屬於這個研究與序列")
        series = row[1]
    return study, (series.series_instance_uid if series else None), sop_uid


def accessible_study_uids(session: Session, project_id: int) -> set[str]:
    q = select(ImagingStudy.study_instance_uid, ImagingStudy.accession_number).where(
        ImagingStudy.project_id == project_id)
    allowed = allowlist(session, project_id)
    return {uid for uid, accession in session.execute(q) if not allowed or accession in allowed}


def list_annotations(session: Session, project_id: int, *, study_uid: str | None = None, sop_uid: str | None = None,
                     kind: str | None = None, source: str | None = None) -> list[Annotation]:
    q = select(Annotation).where(Annotation.project_id == project_id)
    if study_uid:
        q = q.where(Annotation.study_instance_uid == study_uid)
    if sop_uid:
        q = q.where(Annotation.sop_instance_uid == sop_uid)
    if kind:
        q = q.where(Annotation.kind == kind)
    if source:
        q = q.where(Annotation.source == source)
    visible = accessible_study_uids(session, project_id)
    return [a for a in session.scalars(q.order_by(Annotation.id)) if a.study_instance_uid in visible]


def get_annotation(session: Session, project_id: int, annotation_id: int) -> Annotation:
    a = session.get(Annotation, annotation_id)
    if a is None or a.project_id != project_id or find_accessible_study(session, project_id, a.study_instance_uid) is None:
        raise NotFound(f"找不到標註 {annotation_id}")
    return a


def new_annotation(session: Session, *, project_id: int, actor: str, study_uid: str, series_uid: str | None,
                   sop_uid: str | None, kind: str, payload: dict, source: str = "manual") -> Annotation:
    """驗證並加入 session（不 commit、不寫稽核）；呼叫端負責稽核與交易。"""
    clean = normalize(kind, payload)
    if kind != "classification" and sop_uid is None:
        raise InvalidPayload("分割與偵測標註必須指定影像（sop_instance_uid）")
    _, series_uid, sop_uid = resolve_target(session, project_id, study_uid, series_uid, sop_uid)
    a = Annotation(project_id=project_id, study_instance_uid=study_uid, series_instance_uid=series_uid,
                   sop_instance_uid=sop_uid, kind=kind, payload=clean, source=source,
                   created_by=actor, updated_by=actor)
    session.add(a)
    session.flush()
    return a


def create_annotation(session: Session, *, project_id: int, actor: str, source_ip: str | None, study_uid: str,
                      series_uid: str | None, sop_uid: str | None, kind: str, payload: dict) -> Annotation:
    a = new_annotation(session, project_id=project_id, actor=actor, study_uid=study_uid, series_uid=series_uid,
                       sop_uid=sop_uid, kind=kind, payload=payload)
    _audit(session, a, "annotation.create", actor=actor, source_ip=source_ip)
    session.commit()
    return a


def update_annotation(session: Session, *, project_id: int, annotation_id: int, actor: str,
                      source_ip: str | None, payload: dict) -> Annotation:
    a = get_annotation(session, project_id, annotation_id)
    a.payload = normalize(a.kind, payload)
    a.version += 1
    a.updated_by, a.updated_at = actor, utcnow()
    _audit(session, a, "annotation.update", actor=actor, source_ip=source_ip)
    session.commit()
    return a


def delete_annotation(session: Session, *, project_id: int, annotation_id: int, actor: str,
                      source_ip: str | None) -> None:
    a = get_annotation(session, project_id, annotation_id)
    _audit(session, a, "annotation.delete", actor=actor, source_ip=source_ip)
    session.delete(a)
    session.commit()
