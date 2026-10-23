"""標註資料集與版本。

資料集＝名稱＋任務＋資料範圍＋類別，本身是「篩選標註的條件」，內容隨標註增加；
版本是某一刻的快照（納入的標註 id 與各自的版本號），建立後不再改。
送出訓練時對資料集建版：內容與最新版相同就沿用，不同才建新版，所以使用者不用自己管版本。
"""
import hashlib
import json
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app import audit
from app.admin_service import Conflict, NotFound
from app.audit import AuditCategory
from app.imaging.models import ImagingScope, ImagingStudy
from app.labeling.models import Annotation, LabelDataset, LabelDatasetVersion
from app.labeling.payloads import MAX_LABEL, InvalidPayload, labels_of
from app.models import Project

TASKS = ("classification", "detection", "segmentation")
SOURCES = ("manual", "csv", "autolabel")
DEFAULT_SUFFIX = {"classification": "分類標註", "detection": "偵測標註", "segmentation": "分割標註"}


def _iso(value) -> str | None:
    from app.labeling.service import _iso as iso
    return iso(value) if value is not None else None


def _audit(session: Session, ds: LabelDataset, action: str, *, actor: str, source_ip: str | None, **detail) -> None:
    audit.record(session, actor=actor, category=AuditCategory.DATASET, action=action,
                 target=f"project:{ds.project_id}/label_dataset:{ds.id}", source_ip=source_ip,
                 detail={"name": ds.name, "task": ds.task, **detail})


# ---------------------------------------------------------------- 查詢

def get_dataset(session: Session, project_id: int, dataset_id: int) -> LabelDataset:
    ds = session.get(LabelDataset, dataset_id)
    if ds is None or ds.project_id != project_id:
        raise NotFound(f"找不到標註資料集 {dataset_id}")
    return ds


def list_datasets(session: Session, project_id: int) -> list[LabelDataset]:
    return list(session.scalars(select(LabelDataset).where(LabelDataset.project_id == project_id)
                                .order_by(LabelDataset.id)))


def _studies(session: Session, ds: LabelDataset) -> dict[str, str]:
    """資料集涵蓋的研究（study_uid → accession）：有範圍用範圍，沒有就是全部可存取的研究。"""
    from app.imaging.service import _studies_query

    filters: dict = {}
    if ds.scope_id is not None:
        scope = session.get(ImagingScope, ds.scope_id)
        if scope is not None and scope.project_id == ds.project_id:
            filters = dict(scope.filters or {})
    q = _studies_query(session, ds.project_id, **filters)
    rows = session.execute(q.with_only_columns(ImagingStudy.study_instance_uid, ImagingStudy.accession_number))
    return {uid: accession for uid, accession in rows}


def _matches(ds: LabelDataset, a: Annotation) -> bool:
    if not ds.classes:
        return True
    return bool(set(labels_of(a.kind, a.payload)) & set(ds.classes))


def members(session: Session, ds: LabelDataset) -> tuple[list[Annotation], dict[str, str]]:
    """符合資料集條件的標註（含待確認），依 id 排序；以及研究的 accession 對照。"""
    studies = _studies(session, ds)
    rows = session.scalars(select(Annotation).where(Annotation.project_id == ds.project_id,
                                                    Annotation.kind == ds.task).order_by(Annotation.id))
    return [a for a in rows if a.study_instance_uid in studies and _matches(ds, a)], studies


def _by_class(ds: LabelDataset, rows: list[Annotation]) -> dict[str, int]:
    counts: dict[str, int] = {c: 0 for c in ds.classes}
    for a in rows:
        for label in labels_of(a.kind, a.payload):
            if not ds.classes or label in ds.classes:
                counts[label] = counts.get(label, 0) + 1
    return dict(sorted(counts.items()))


def current(session: Session, ds: LabelDataset) -> dict[str, Any]:
    rows, _ = members(session, ds)
    confirmed = [a for a in rows if a.status != "draft"]
    return {"annotations": len(confirmed), "studies": len({a.study_instance_uid for a in confirmed}),
            "by_class": _by_class(ds, confirmed),
            "by_source": {s: sum(1 for a in confirmed if a.source == s) for s in SOURCES},
            "drafts_excluded": len(rows) - len(confirmed)}


def latest_version(session: Session, ds: LabelDataset) -> LabelDatasetVersion | None:
    return session.scalar(select(LabelDatasetVersion).where(LabelDatasetVersion.dataset_id == ds.id)
                          .order_by(LabelDatasetVersion.version.desc()).limit(1))


def version_out(v: LabelDatasetVersion) -> dict[str, Any]:
    return {"id": v.id, "version": v.version, "created_at": _iso(v.created_at), "created_by": v.created_by,
            "annotations": v.annotations, "by_class": v.by_class}


def dataset_out(session: Session, ds: LabelDataset) -> dict[str, Any]:
    latest = latest_version(session, ds)
    return {"id": ds.id, "name": ds.name, "task": ds.task, "scope_id": ds.scope_id, "classes": list(ds.classes or []),
            "auto": ds.auto, "created_by": ds.created_by, "created_at": _iso(ds.created_at),
            "current": current(session, ds), "latest_version": version_out(latest) if latest else None}


def items(session: Session, ds: LabelDataset, *, offset: int = 0, limit: int = 50) -> dict[str, Any]:
    rows, studies = members(session, ds)
    page = rows[offset:offset + limit]
    return {"total": len(rows), "items": [
        {"annotation_id": a.id, "study_instance_uid": a.study_instance_uid,
         "accession_number": studies.get(a.study_instance_uid, ""), "sop_instance_uid": a.sop_instance_uid,
         "label": ", ".join(labels_of(a.kind, a.payload)), "source": a.source, "status": a.status or "confirmed",
         "updated_by": a.updated_by, "updated_at": _iso(a.updated_at)} for a in page]}


# ---------------------------------------------------------------- 新增、修改、刪除

def _check_name(session: Session, project_id: int, name: Any, exclude: int | None = None) -> str:
    name = name.strip() if isinstance(name, str) else ""
    if not name or len(name) > 128:
        raise InvalidPayload("資料集名稱不可空白，最多 128 字")
    q = select(LabelDataset.id).where(LabelDataset.project_id == project_id, LabelDataset.name == name)
    if exclude is not None:
        q = q.where(LabelDataset.id != exclude)
    if session.scalar(q) is not None:
        raise Conflict(f"已有名稱為「{name}」的標註資料集")
    return name


def _check_scope(session: Session, project_id: int, scope_id: Any) -> int | None:
    if scope_id is None:
        return None
    scope = session.get(ImagingScope, scope_id) if isinstance(scope_id, int) else None
    if scope is None or scope.project_id != project_id:
        raise NotFound(f"找不到資料範圍 {scope_id}")
    return scope.id


def _check_classes(classes: Any) -> list[str]:
    if classes is None:
        return []
    if not isinstance(classes, list) or not all(isinstance(c, str) and c.strip() for c in classes):
        raise InvalidPayload("類別必須是文字清單")
    out = sorted({c.strip() for c in classes})
    if any(len(c) > MAX_LABEL for c in out):
        raise InvalidPayload(f"類別名稱最多 {MAX_LABEL} 字")
    return out


def create_dataset(session: Session, *, project_id: int, actor: str, source_ip: str | None, name: Any,
                   task: Any, scope_id: Any = None, classes: Any = None, auto: bool = False,
                   commit: bool = True) -> LabelDataset:
    if task not in TASKS:
        raise InvalidPayload(f"任務必須是：{'、'.join(TASKS)}")
    ds = LabelDataset(project_id=project_id, name=_check_name(session, project_id, name), task=task,
                      scope_id=_check_scope(session, project_id, scope_id), classes=_check_classes(classes),
                      auto=auto, created_by=actor)
    session.add(ds)
    session.flush()
    if not auto:            # 系統自動建立的預設資料集不是使用者的操作，不另寫稽核
        _audit(session, ds, "label_dataset.create", actor=actor, source_ip=source_ip, scope_id=ds.scope_id,
               classes=ds.classes)
    if commit:
        session.commit()
    return ds


_UNSET: Any = object()


def update_dataset(session: Session, *, project_id: int, dataset_id: int, actor: str, source_ip: str | None,
                   name: Any = _UNSET, scope_id: Any = _UNSET, classes: Any = _UNSET) -> LabelDataset:
    """任務不可改（換任務就是另一份資料集）。"""
    ds = get_dataset(session, project_id, dataset_id)
    if name is not _UNSET and name is not None:
        ds.name = _check_name(session, project_id, name, exclude=ds.id)
    if scope_id is not _UNSET:
        ds.scope_id = _check_scope(session, project_id, scope_id)
    if classes is not _UNSET:
        ds.classes = _check_classes(classes)
    _audit(session, ds, "label_dataset.update", actor=actor, source_ip=source_ip, scope_id=ds.scope_id,
           classes=ds.classes)
    session.commit()
    return ds


def delete_dataset(session: Session, *, project_id: int, dataset_id: int, actor: str, source_ip: str | None) -> None:
    """刪除資料集與它的版本；標註本身不動。用過它的訓練紀錄保留版本號（名稱顯示為已刪除）。"""
    ds = get_dataset(session, project_id, dataset_id)
    _audit(session, ds, "label_dataset.delete", actor=actor, source_ip=source_ip)
    session.execute(delete(LabelDatasetVersion).where(LabelDatasetVersion.dataset_id == ds.id))
    session.delete(ds)
    session.commit()


# ---------------------------------------------------------------- 版本

def _snapshot(session: Session, ds: LabelDataset) -> tuple[list[list[int]], list[Annotation]]:
    rows, _ = members(session, ds)
    confirmed = [a for a in rows if a.status != "draft"]       # 訓練只用已確認的標註
    return [[a.id, a.version] for a in confirmed], confirmed


def _hash(entries: list[list[int]]) -> str:
    return hashlib.sha256(json.dumps(entries, separators=(",", ":")).encode()).hexdigest()


def ensure_version(session: Session, ds: LabelDataset, *, actor: str, source_ip: str | None = None,
                   commit: bool = True) -> tuple[LabelDatasetVersion, bool]:
    """內容與最新版相同就回最新版（created=False），不同就建新版（created=True）。"""
    entries, confirmed = _snapshot(session, ds)
    if not entries:
        raise InvalidPayload(f"標註資料集「{ds.name}」目前沒有已確認的標註，無法建立版本")
    digest = _hash(entries)
    latest = latest_version(session, ds)
    if latest is not None and latest.content_hash == digest:
        return latest, False
    version = LabelDatasetVersion(project_id=ds.project_id, dataset_id=ds.id,
                                  version=(latest.version + 1) if latest else 1, items=entries,
                                  content_hash=digest, annotations=len(entries),
                                  by_class=_by_class(ds, confirmed), created_by=actor)
    session.add(version)
    session.flush()
    _audit(session, ds, "label_dataset.version", actor=actor, source_ip=source_ip, version=version.version,
           annotations=len(entries))
    if commit:
        session.commit()
    return version, True


def list_versions(session: Session, ds: LabelDataset) -> list[LabelDatasetVersion]:
    return list(session.scalars(select(LabelDatasetVersion).where(LabelDatasetVersion.dataset_id == ds.id)
                                .order_by(LabelDatasetVersion.version.desc())))


# ---------------------------------------------------------------- 自動建立、CSV 匯入

def _free_name(session: Session, project_id: int, base: str) -> str:
    name, no = base[:128], 2
    while session.scalar(select(LabelDataset.id).where(LabelDataset.project_id == project_id,
                                                       LabelDataset.name == name)) is not None:
        name = f"{base[:120]}（{no}）"
        no += 1
    return name


def ensure_default(session: Session, project_id: int, task: str, actor: str) -> LabelDataset | None:
    """專案還沒有這個任務的資料集時，建立「（專案名）分類標註」等預設資料集。不 commit。"""
    if task not in TASKS:
        return None
    existing = session.scalar(select(LabelDataset).where(LabelDataset.project_id == project_id,
                                                         LabelDataset.task == task).order_by(LabelDataset.id)
                              .limit(1))
    if existing is not None:
        return existing
    project = session.get(Project, project_id)
    name = _free_name(session, project_id, f"{project.name if project else ''} {DEFAULT_SUFFIX[task]}".strip())
    return create_dataset(session, project_id=project_id, actor=actor, source_ip=None, name=name, task=task,
                          auto=True, commit=False)


def ensure_defaults(session: Session, project_id: int, actor: str) -> None:
    """既有專案（功能上線前已有標註）第一次列資料集時補上預設資料集。"""
    kinds = set(session.scalars(select(Annotation.kind).where(Annotation.project_id == project_id).distinct()))
    created = False
    for task in TASKS:
        if task in kinds and session.scalar(select(LabelDataset.id).where(
                LabelDataset.project_id == project_id, LabelDataset.task == task).limit(1)) is None:
            ensure_default(session, project_id, task, actor)
            created = True
    if created:
        session.commit()


def attach_csv(session: Session, *, project_id: int, actor: str, dataset_id: int | None, dataset_name: str | None,
               labels: list[str], source_ip: str | None) -> LabelDataset | None:
    """診斷表匯入後：
    - dataset_id：加入既有資料集（資料集有限定類別時補上這次的診斷類別）；
    - dataset_name：建立新的分類資料集（類別＝這次的診斷類別）；
    - 都沒給：回預設的分類資料集（沒有就是 None）。不 commit。"""
    if dataset_id is not None:
        ds = get_dataset(session, project_id, dataset_id)
        if ds.classes and labels:
            merged = sorted(set(ds.classes) | set(labels))
            if merged != ds.classes:
                ds.classes = merged
                _audit(session, ds, "label_dataset.update", actor=actor, source_ip=source_ip, classes=merged)
        return ds
    if dataset_name is not None and dataset_name.strip():
        return create_dataset(session, project_id=project_id, actor=actor, source_ip=source_ip, name=dataset_name,
                              task="classification", classes=labels, commit=False)
    return session.scalar(select(LabelDataset).where(LabelDataset.project_id == project_id,
                                                     LabelDataset.task == "classification",
                                                     LabelDataset.auto.is_(True)).order_by(LabelDataset.id).limit(1))
