"""刪除專案後清掉平台以外的資料：Orthanc 影像、物件儲存檔案、HAPI 的 FHIR 租戶，並取消叢集中還在排隊／執行的工作。

採 outbox：資料庫是唯一事實來源。
1. `stage()`：與刪除專案同一個交易，刪掉專案的影像／結構式索引列，並把要清的外部資料寫進 `storage_cleanup_tasks`。
2. `run_pending()`：commit 之後才執行。成功的工作刪掉；失敗的留著（記次數與最後錯誤），之後任何一次
   專案刪除、種子重設或 `python -m app.project_cleanup` 都會重試。
3. 專案刪除本身不因清理失敗而失敗：殘留的是使用者已經看不到的孤兒資料，由稽核（dataset／project.data_cleanup，
   result=partial）與待清理清單追蹤。

物件儲存約定：專案的檔案一律放在 `projects/{project_id}/` 之下，清理時整個前綴刪除。
Orthanc 是跨專案共用的節點（同一張影像只存一份），所以只刪「沒有任何專案還在引用」的影像。
FHIR：租戶＝專案（HAPI 分割區編號＝專案編號）。FHIR 有設定時才寫這筆工作；清理＝刪資源、expunge、刪分割區。
叢集工作：狀態為 queued／running 的排程工作（訓練也經由排程工作執行）各一筆，經 JobBackend.cancel 取消。
"""
import logging
from datetime import datetime

from sqlalchemy import DateTime, Integer, String, delete, select
from sqlalchemy.orm import Mapped, Session, mapped_column

from app.audit import AuditCategory, record
from app.fhir.client import fhir_from_env
from app.imaging.models import (AccessionAllowlist, ImagingFile, ImagingInstance, ImagingInstanceSource,
                                ImagingSeries, ImagingStudy, ImportFileResult, ImportJob)
from app.models import Base, Project, utcnow
from app.scheduling.backend import backend_from_env
from app.scheduling.models import Job
from app.scheduling.states import TERMINAL, JobStatus
from app.tabular_api.models import TabularDataset, TabularTargetFeature

log = logging.getLogger(__name__)

OBJECT_PREFIX = "object_prefix"
ORTHANC_INSTANCE = "orthanc_instance"
FHIR_TENANT = "fhir_tenant"
CLUSTER_JOB = "cluster_job"
_ACTIVE_JOB = (JobStatus.QUEUED.value, JobStatus.RUNNING.value)


class StorageCleanupTask(Base):
    """待清理清單。project_id 不設外鍵：專案已經刪除。"""
    __tablename__ = "storage_cleanup_tasks"
    id: Mapped[int] = mapped_column(primary_key=True)
    kind: Mapped[str] = mapped_column(String(32))    # object_prefix | orthanc_instance | fhir_tenant | cluster_job
    ref: Mapped[str] = mapped_column(String(512))    # 物件前綴、SOP Instance UID、FHIR 租戶編號、Kubernetes Job 名稱
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


def fhir_client(state):
    """與 FHIR 路由相同：app.state.fhir，沒有就依 FHIR_URL 建立；都沒有回 None（沒有 FHIR 伺服器，就沒有資料可清）。"""
    client = getattr(state, "fhir", None)
    if client is None:
        client = fhir_from_env()
        if client is not None:
            state.fhir = client
    return client


def job_backend(state):
    """與排程路由相同：app.state.job_backend，沒有就依 JOB_BACKEND 建立；建立失敗回 None（取消工作留著重試）。"""
    backend = getattr(state, "job_backend", None)
    if backend is None:
        try:
            backend = backend_from_env()
        except Exception:
            log.exception("無法建立排程後端；叢集工作的取消留在待清理清單")
            return None
        if backend is not None:
            state.job_backend = backend
    return backend


def stage(session: Session, project_id: int, *, fhir: bool = False) -> None:
    """與刪除專案同一個交易：寫待清理清單，並刪掉專案的索引列（不依賴資料庫的 ON DELETE CASCADE）。只 flush，不 commit。
    fhir=True（有 FHIR 伺服器）時多寫一筆清租戶的工作。"""
    elsewhere = select(ImagingInstance.sop_instance_uid).where(ImagingInstance.project_id != project_id)
    sops = session.scalars(select(ImagingInstance.sop_instance_uid)
                           .where(ImagingInstance.project_id == project_id,
                                  ImagingInstance.sop_instance_uid.not_in(elsewhere))
                           .order_by(ImagingInstance.id)).all()
    session.add(StorageCleanupTask(kind=OBJECT_PREFIX, ref=project_prefix(project_id), project_id=project_id))
    session.add_all(StorageCleanupTask(kind=ORTHANC_INSTANCE, ref=sop, project_id=project_id) for sop in sops)
    if fhir:
        session.add(StorageCleanupTask(kind=FHIR_TENANT, ref=str(project_id), project_id=project_id))
    active = session.scalars(select(Job.k8s_name).where(Job.project_id == project_id, Job.status.in_(_ACTIVE_JOB),
                                                        Job.k8s_name.is_not(None)).order_by(Job.id)).all()
    session.add_all(StorageCleanupTask(kind=CLUSTER_JOB, ref=name, project_id=project_id) for name in active)

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


def _run_one(session: Session, task: StorageCleanupTask, store, orthanc, fhir, jobs) -> tuple[str, int]:
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
    if task.kind == FHIR_TENANT:
        if session.get(Project, task.project_id) is not None:
            log.warning("專案編號 %s 已被重用，放棄清理 FHIR 租戶（避免刪到新專案的資料）", task.project_id)
            return "fhir_deleted", 0
        if fhir is None:
            raise RuntimeError("FHIR 服務未設定")
        return "fhir_deleted", fhir.delete_tenant(int(task.ref))
    if task.kind == CLUSTER_JOB:
        if jobs is None:
            raise RuntimeError("排程服務未設定")
        observed = jobs.get(task.ref)
        if observed is None or observed.state in TERMINAL:   # 資料庫的狀態可能還沒同步；已結束的由 TTL 清掉
            return "jobs_cancelled", 0
        jobs.cancel(task.ref)
        return "jobs_cancelled", 1
    raise RuntimeError(f"不認得的清理種類 {task.kind!r}")


def run_pending(session: Session, store, orthanc, *, actor: str, source_ip: str | None = None,
                fhir=None, jobs=None) -> dict[int, dict]:
    """執行所有待清理工作（含先前失敗的）。不拋例外；回傳 {project_id: {objects_deleted, orthanc_deleted, failed}}，
    有 FHIR 或叢集工作的清理成功時多 fhir_deleted、jobs_cancelled。"""
    try:
        return _run_pending(session, store, orthanc, fhir, jobs, actor=actor, source_ip=source_ip)
    except Exception:
        session.rollback()
        log.exception("專案資料清理中斷；待清理清單保留，之後會重試")
        return {}


def _run_pending(session: Session, store, orthanc, fhir, jobs, *, actor: str, source_ip: str | None) -> dict[int, dict]:
    summary: dict[int, dict] = {}
    for task in session.scalars(select(StorageCleanupTask).order_by(StorageCleanupTask.id)).all():
        counts = summary.setdefault(task.project_id, {"objects_deleted": 0, "orthanc_deleted": 0, "failed": 0})
        try:
            field, done = _run_one(session, task, store, orthanc, fhir, jobs)
        except Exception as exc:
            counts["failed"] += 1
            task.attempts += 1
            task.last_error = f"{type(exc).__name__}: {exc}"[:512]
            log.warning("專案 %s 的清理失敗（%s %s，第 %s 次）：%s", task.project_id, task.kind, task.ref,
                        task.attempts, task.last_error)
            if isinstance(exc, PartialCleanup):
                counts["objects_deleted"] += exc.deleted
            continue
        counts[field] = counts.get(field, 0) + done
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
                                     actor=os.environ.get("SEED_ADMIN", "admin01"), source_ip="local:project_cleanup",
                                     fhir=fhir_client(app.state), jobs=job_backend(app.state)),
                         ensure_ascii=False, indent=2))
