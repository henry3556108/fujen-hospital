"""刪除專案後清掉平台以外的資料：Orthanc 影像與物件儲存檔案。

採 outbox：資料庫是唯一事實來源。
1. `stage()`：與刪除專案同一個交易，刪掉專案的影像／結構式索引列，並把要清的外部資料寫進 `storage_cleanup_tasks`。
2. `run_pending()`：commit 之後才執行。成功的工作刪掉；失敗的留著（記次數與最後錯誤），之後任何一次
   專案刪除、種子重設或 `python -m app.project_cleanup` 都會重試。
3. 專案刪除本身不因清理失敗而失敗：殘留的是使用者已經看不到的孤兒資料，由稽核（dataset／project.data_cleanup，
   result=partial）與待清理清單追蹤。

物件儲存約定：專案的檔案一律放在 `projects/{project_id}/` 之下，清理時整個前綴刪除。
Orthanc 是跨專案共用的節點（同一張影像只存一份），所以只刪「沒有任何專案還在引用」的影像。
"""
import logging
from datetime import datetime

from sqlalchemy import DateTime, Integer, String, delete, select
from sqlalchemy.orm import Mapped, Session, mapped_column

from app.audit import AuditCategory, record
from app.imaging.models import (AccessionAllowlist, ImagingFile, ImagingInstance, ImagingInstanceSource,
                                ImagingSeries, ImagingStudy, ImportFileResult, ImportJob)
from app.models import Base, Project, utcnow
from app.tabular_api.models import TabularDataset, TabularTargetFeature

log = logging.getLogger(__name__)

OBJECT_PREFIX = "object_prefix"
ORTHANC_INSTANCE = "orthanc_instance"


class StorageCleanupTask(Base):
    """待清理清單。project_id 不設外鍵：專案已經刪除。"""
    __tablename__ = "storage_cleanup_tasks"
    id: Mapped[int] = mapped_column(primary_key=True)
    kind: Mapped[str] = mapped_column(String(32))            # object_prefix | orthanc_instance
    ref: Mapped[str] = mapped_column(String(512))            # 物件前綴，或 SOP Instance UID
    project_id: Mapped[int] = mapped_column(Integer, index=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    last_error: Mapped[str] = mapped_column(String(512), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class PartialCleanup(RuntimeError):
    def __init__(self, message: str, *, deleted: int):
        super().__init__(message)
        self.deleted = deleted


def project_prefix(project_id: int) -> str:
    return f"projects/{project_id}/"


def stage(session: Session, project_id: int) -> None:
    """與刪除專案同一個交易：寫待清理清單，並刪掉專案的索引列（不依賴資料庫的 ON DELETE CASCADE）。只 flush，不 commit。"""
    elsewhere = select(ImagingInstance.sop_instance_uid).where(ImagingInstance.project_id != project_id)
    sops = session.scalars(select(ImagingInstance.sop_instance_uid)
                           .where(ImagingInstance.project_id == project_id,
                                  ImagingInstance.sop_instance_uid.not_in(elsewhere))
                           .order_by(ImagingInstance.id)).all()
    session.add(StorageCleanupTask(kind=OBJECT_PREFIX, ref=project_prefix(project_id), project_id=project_id))
    session.add_all(StorageCleanupTask(kind=ORTHANC_INSTANCE, ref=sop, project_id=project_id) for sop in sops)

    studies = select(ImagingStudy.id).where(ImagingStudy.project_id == project_id)
    jobs = select(ImportJob.id).where(ImportJob.project_id == project_id)
    datasets = select(TabularDataset.id).where(TabularDataset.project_id == project_id)
    for statement in (
        delete(ImagingInstanceSource).where(ImagingInstanceSource.project_id == project_id),
        delete(ImagingInstance).where(ImagingInstance.project_id == project_id),
        delete(ImagingSeries).where(ImagingSeries.study_id.in_(studies)),
        delete(ImagingStudy).where(ImagingStudy.project_id == project_id),
        delete(AccessionAllowlist).where(AccessionAllowlist.project_id == project_id),
        delete(ImportFileResult).where(ImportFileResult.job_id.in_(jobs)),
        delete(ImportJob).where(ImportJob.project_id == project_id),
        delete(ImagingFile).where(ImagingFile.project_id == project_id),
        delete(TabularTargetFeature).where(TabularTargetFeature.dataset_id.in_(datasets)),
        delete(TabularDataset).where(TabularDataset.project_id == project_id),
    ):
        session.execute(statement.execution_options(synchronize_session=False))
    session.flush()
    session.expire_all()


def _run_one(session: Session, task: StorageCleanupTask, store, orthanc) -> tuple[str, int]:
    """執行一筆清理，回傳（計數欄位, 刪除數）。資料又被使用中時放棄清理（回 0）。失敗就拋例外。"""
    if task.kind == OBJECT_PREFIX:
        if session.get(Project, task.project_id) is not None:
            log.warning("專案編號 %s 已被重用，放棄清理 %s（避免刪到新專案的檔案）", task.project_id, task.ref)
            return "objects_deleted", 0
        if store is None:
            raise RuntimeError("物件儲存未設定")
        keys = store.list(task.ref)
        failures = []
        for key in keys:
            try:
                store.delete(key)
            except Exception as exc:  # 單一檔案失敗不擋其他檔案
                failures.append(f"{key}: {type(exc).__name__}: {exc}")
        if failures:
            raise PartialCleanup(f"{len(failures)} 個檔案刪除失敗；{failures[0]}", deleted=len(keys) - len(failures))
        return "objects_deleted", len(keys)
    if task.kind == ORTHANC_INSTANCE:
        in_use = session.scalar(select(ImagingInstance.id).where(ImagingInstance.sop_instance_uid == task.ref).limit(1))
        if in_use is not None:
            return "orthanc_deleted", 0
        if orthanc is None:
            raise RuntimeError("影像節點未設定")
        orthanc.delete(task.ref)
        return "orthanc_deleted", 1
    raise RuntimeError(f"不認得的清理種類 {task.kind!r}")


def run_pending(session: Session, store, orthanc, *, actor: str, source_ip: str | None = None) -> dict[int, dict]:
    """執行所有待清理工作（含先前失敗的）。不拋例外；回傳 {project_id: {objects_deleted, orthanc_deleted, failed}}。"""
    try:
        return _run_pending(session, store, orthanc, actor=actor, source_ip=source_ip)
    except Exception:
        session.rollback()
        log.exception("專案資料清理中斷；待清理清單保留，之後會重試")
        return {}


def _run_pending(session: Session, store, orthanc, *, actor: str, source_ip: str | None) -> dict[int, dict]:
    summary: dict[int, dict] = {}
    for task in session.scalars(select(StorageCleanupTask).order_by(StorageCleanupTask.id)).all():
        counts = summary.setdefault(task.project_id, {"objects_deleted": 0, "orthanc_deleted": 0, "failed": 0})
        try:
            field, done = _run_one(session, task, store, orthanc)
        except Exception as exc:
            counts["failed"] += 1
            task.attempts += 1
            task.last_error = f"{type(exc).__name__}: {exc}"[:512]
            log.warning("專案 %s 的清理失敗（%s %s，第 %s 次）：%s", task.project_id, task.kind, task.ref,
                        task.attempts, task.last_error)
            if isinstance(exc, PartialCleanup):
                counts["objects_deleted"] += exc.deleted
            continue
        counts[field] += done
        session.execute(delete(StorageCleanupTask).where(StorageCleanupTask.id == task.id)
                        .execution_options(synchronize_session=False))
    for project_id, counts in summary.items():
        if any(counts.values()):  # 沒有任何資料的專案不寫稽核
            record(session, actor=actor, category=AuditCategory.DATASET, action="project.data_cleanup",
                   target=f"project:{project_id}", result="partial" if counts["failed"] else "success",
                   source_ip=source_ip, detail=dict(counts))
    session.commit()
    return summary


if __name__ == "__main__":
    import json
    import os

    from app.asgi import app

    with app.state.sessionmaker() as s:
        print(json.dumps(run_pending(s, app.state.store, getattr(app.state, "orthanc", None),
                                     actor=os.environ.get("SEED_ADMIN", "admin01"), source_ip="local:project_cleanup"),
                         ensure_ascii=False, indent=2))
