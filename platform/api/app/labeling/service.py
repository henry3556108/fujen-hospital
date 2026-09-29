"""標註服務：CRUD、評分、摘要、CSV 自動分類、自動標註。寫入與 dataset 稽核同一個交易。"""
import time
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import audit
from app.admin_service import NotFound
from app.audit import AuditCategory
from app.imaging.models import ImagingInstance, ImagingSeries, ImagingStudy
from app.imaging.service import allowlist, find_accessible_study
from app.labeling import csv_labels, formats
from app.labeling.autolabel import AutolabelClient, AutolabelRejected, AutolabelUnavailable
from app.labeling.models import Annotation, AutolabelRun
from app.labeling.payloads import KINDS, MAX_LABEL, InvalidPayload, labels_of, normalize
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


def rate_annotation(session: Session, *, project_id: int, annotation_id: int, actor: str, source_ip: str | None,
                    rating: int | None) -> Annotation:
    """評分是對標註品質的評等，不算內容修改：version 不變。"""
    a = get_annotation(session, project_id, annotation_id)
    a.rating = rating
    a.updated_by, a.updated_at = actor, utcnow()
    _audit(session, a, "annotation.rate", actor=actor, source_ip=source_ip, rating=rating)
    session.commit()
    return a


def summary(session: Session, project_id: int) -> dict:
    """各研究的標註數與各標籤筆數；訓練選 Label 與標註清單頁共用。只算可存取的研究。"""
    rows = list_annotations(session, project_id)
    allowed = allowlist(session, project_id)
    studies = [s for s in session.scalars(select(ImagingStudy).where(ImagingStudy.project_id == project_id)
                                          .order_by(ImagingStudy.id))
               if not allowed or s.accession_number in allowed]
    per_study = {s.study_instance_uid: {k: 0 for k in KINDS} for s in studies}
    labels: dict[str, dict[str, int]] = {k: {} for k in KINDS}
    for a in rows:
        per_study[a.study_instance_uid][a.kind] += 1
        for label in labels_of(a.kind, a.payload):
            labels[a.kind][label] = labels[a.kind].get(label, 0) + 1
    return {
        "total": len(rows),
        "rated": sum(1 for a in rows if a.rating is not None),
        "by_kind": {k: sum(1 for a in rows if a.kind == k) for k in KINDS},
        "by_source": {s: sum(1 for a in rows if a.source == s) for s in SOURCES},
        "labels": {k: dict(sorted(v.items())) for k, v in labels.items()},
        "studies": [{"study_instance_uid": s.study_instance_uid, "accession_number": s.accession_number,
                     "patient_id": s.patient_id, "study_date": s.study_date,
                     "study_description": s.study_description,
                     "annotations": sum(per_study[s.study_instance_uid].values()),
                     "by_kind": per_study[s.study_instance_uid]} for s in studies],
    }


# ---------- CSV 自動分類標註 ----------

def classify_from_csv(session: Session, *, project_id: int, actor: str, source_ip: str | None, filename: str,
                      data: bytes, key: str, key_column: str | None = None,
                      label_column: str | None = None) -> dict:
    """每個對到的研究一筆 source=csv 的研究層級分類標註；同一研究重傳時更新，不重複建立。
    逐列回報 matched／unmatched／conflict／invalid；只有 matched 會寫入。"""
    rows = csv_labels.parse(data, key=key, key_column=key_column, label_column=label_column)
    column = ImagingStudy.patient_id if key == "patient_id" else ImagingStudy.accession_number
    allowed = allowlist(session, project_id)
    by_key: dict[str, list[str]] = {}
    for study in session.scalars(select(ImagingStudy).where(ImagingStudy.project_id == project_id)
                                 .order_by(ImagingStudy.id)):
        if allowed and study.accession_number not in allowed:
            continue
        value = getattr(study, column.key)
        if value:
            by_key.setdefault(value, []).append(study.study_instance_uid)

    labels_per_key: dict[str, set[str]] = {}
    for r in rows:
        if r.key and r.label and len(r.label) <= MAX_LABEL:
            labels_per_key.setdefault(r.key, set()).add(r.label)

    existing = {a.study_instance_uid: a for a in session.scalars(select(Annotation).where(
        Annotation.project_id == project_id, Annotation.source == "csv", Annotation.kind == "classification",
        Annotation.sop_instance_uid.is_(None)))}
    counts = {"created": 0, "updated": 0, "unchanged": 0}
    written: dict[str, list[int]] = {}     # 鍵 → 標註 id（同一鍵重複出現時只寫一次）
    results = []
    for r in rows:
        item = {"row": r.row, "key": r.key, "label": r.label, "status": "matched", "reason": "",
                "study_instance_uids": [], "annotation_ids": []}
        if not r.key or not r.label:
            item |= {"status": "invalid", "reason": "缺少鍵值" if not r.key else "缺少診斷結果"}
        elif len(r.label) > MAX_LABEL:
            item |= {"status": "invalid", "reason": f"診斷結果超過 {MAX_LABEL} 個字"}
        elif len(labels_per_key[r.key]) > 1:
            item |= {"status": "conflict",
                     "reason": f"同一個鍵有不同的診斷結果：{'、'.join(sorted(labels_per_key[r.key]))}"}
        elif r.key not in by_key:
            item |= {"status": "unmatched", "reason": "專案內找不到對應的研究（或不在 Accession 清單內）"}
        else:
            if r.key not in written:
                ids = []
                for study_uid in by_key[r.key]:
                    a = existing.get(study_uid)
                    if a is None:
                        a = Annotation(project_id=project_id, study_instance_uid=study_uid, kind="classification",
                                       payload={"label": r.label}, source="csv", created_by=actor, updated_by=actor)
                        session.add(a)
                        session.flush()
                        existing[study_uid] = a
                        counts["created"] += 1
                    elif a.payload != {"label": r.label}:
                        a.payload = {"label": r.label}
                        a.version += 1
                        a.updated_by, a.updated_at = actor, utcnow()
                        counts["updated"] += 1
                    else:
                        counts["unchanged"] += 1
                    ids.append(a.id)
                written[r.key] = ids
            item |= {"study_instance_uids": list(by_key[r.key]), "annotation_ids": written[r.key]}
        results.append(item)

    tally = {s: sum(1 for i in results if i["status"] == s) for s in ("matched", "unmatched", "conflict", "invalid")}
    annotation_ids = sorted({i for ids in written.values() for i in ids})
    audit.record(session, actor=actor, category=AuditCategory.DATASET, action="annotation.csv_classification",
                 target=f"project:{project_id}", source_ip=source_ip,
                 detail={"filename": filename, "key": key, "rows": len(rows), **tally, **counts,
                         "annotation_ids": annotation_ids})
    session.commit()
    return {"key": key, "rows": len(rows), **tally, **counts, "annotated_studies": len(annotation_ids),
            "results": results}


# ---------- 自動標註 ----------

class AutolabelFailed(Exception):
    """自動標註沒有完成；status 決定回給用戶端的狀態碼。"""

    def __init__(self, status: int, message: str, reason: str):
        super().__init__(message)
        self.status, self.message, self.reason = status, message, reason


def autolabel_models(client: AutolabelClient) -> list[dict]:
    try:
        models = formats.validate_info(client.info())
    except (AutolabelUnavailable, AutolabelRejected):
        raise AutolabelFailed(503, "自動標註服務目前無法連線，請稍後再試", "unavailable")
    except formats.FormatError as exc:
        raise AutolabelFailed(502, f"自動標註服務的回應不合規格：{exc}", "bad_format")
    return [{"name": name, "type": m["type"], "labels": m["labels"], "dimension": m["dimension"],
             "description": m.get("description", "")} for name, m in sorted(models.items())]


def run_out(run: AutolabelRun) -> dict:
    return {"id": run.id, "project_id": run.project_id, "model": run.model, "model_type": run.model_type,
            "study_instance_uid": run.study_instance_uid, "sop_instance_uid": run.sop_instance_uid,
            "annotation_id": run.annotation_id, "duration_ms": run.duration_ms, "created_by": run.created_by,
            "created_at": _iso(run.created_at)}


def list_runs(session: Session, project_id: int) -> list[AutolabelRun]:
    visible = accessible_study_uids(session, project_id)
    rows = session.scalars(select(AutolabelRun).where(AutolabelRun.project_id == project_id)
                           .order_by(AutolabelRun.id.desc()))
    return [r for r in rows if r.study_instance_uid in visible]


def submit_autolabel(session: Session, client: AutolabelClient, *, project_id: int, actor: str,
                     source_ip: str | None, model: str, study_uid: str, sop_uid: str) -> tuple[AutolabelRun, Annotation]:
    """送出 → 驗證格式 → 標註、執行紀錄、稽核同一個交易寫入。
    任何一步失敗都不寫標註與執行紀錄，只留一筆 result=failure 的稽核。"""
    _, series_uid, _ = resolve_target(session, project_id, study_uid, None, sop_uid)
    target = f"project:{project_id}/image:{sop_uid}"
    started = time.monotonic()
    try:
        models = {m["name"]: m for m in autolabel_models(client)}
        if model not in models:
            raise AutolabelFailed(404, f"自動標註服務沒有模型 {model}", "unknown_model")
        model_type = models[model]["type"]
        try:
            body = client.infer(model, sop_uid)
        except AutolabelUnavailable:
            raise AutolabelFailed(503, "自動標註服務目前無法連線，請稍後再試", "unavailable")
        except AutolabelRejected as exc:
            raise AutolabelFailed(502, f"自動標註服務拒絕這次請求（{exc}）", "rejected")
        try:
            payload = formats.to_payload(model_type, body, model=model, image=sop_uid)
        except formats.FormatError as exc:
            raise AutolabelFailed(502, f"自動標註服務的回應不合規格：{exc}", "bad_format")
        if payload is None:
            raise AutolabelFailed(422, "自動標註沒有偵測到物件，未建立標註", "empty")
    except AutolabelFailed as failure:
        session.rollback()
        audit.record(session, actor=actor, category=AuditCategory.DATASET, action="autolabel.submit", target=target,
                     result="failure", source_ip=source_ip,
                     detail={"model": model, "study_instance_uid": study_uid, "reason": failure.reason})
        session.commit()
        raise
    duration_ms = int((time.monotonic() - started) * 1000)
    annotation = Annotation(project_id=project_id, study_instance_uid=study_uid, series_instance_uid=series_uid,
                            sop_instance_uid=sop_uid, kind=model_type, payload=payload, source="autolabel",
                            created_by=actor, updated_by=actor)
    session.add(annotation)
    session.flush()
    run = AutolabelRun(project_id=project_id, model=model, model_type=model_type, study_instance_uid=study_uid,
                       sop_instance_uid=sop_uid, annotation_id=annotation.id, duration_ms=duration_ms,
                       created_by=actor)
    session.add(run)
    session.flush()
    annotation.autolabel_run_id = run.id
    audit.record(session, actor=actor, category=AuditCategory.DATASET, action="autolabel.submit", target=target,
                 source_ip=source_ip,
                 detail={"model": model, "model_type": model_type, "study_instance_uid": study_uid,
                         "annotation_id": annotation.id, "run_id": run.id, "duration_ms": duration_ms,
                         "spec_version": formats.SPEC_VERSION})
    session.commit()
    return run, annotation
