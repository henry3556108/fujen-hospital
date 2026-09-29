import re
import secrets

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit import AuditCategory, record
from app.models import Project, utcnow
from collections.abc import Callable

from app.scheduling.backend import JobBackend, JobSpec, Workload
from app.scheduling.models import GpuGroup, Job, SharedSchedulingSettings
from app.scheduling.states import TERMINAL, InvalidTransition, JobStatus, check_transition, path_to

# 兩個 GPU 池（架構決策：獨占 2 張、共享 1 張時間片；不用 MIG）
POOL_MODES = {"gpu-exclusive": "exclusive", "gpu-shared": "shared"}
DEFAULT_GROUPS = [("gpu-exclusive", "gpu-exclusive", 2, "exclusive"), ("gpu-shared", "gpu-shared", 1, "shared")]


class SchedulingError(Exception):
    status_code = 400


class Conflict(SchedulingError):
    status_code = 409


class NotFound(SchedulingError):
    status_code = 404


class Invalid(SchedulingError):
    status_code = 422


class Unavailable(SchedulingError):
    status_code = 503


def ensure_defaults(session: Session) -> SharedSchedulingSettings:
    """首次使用排程功能時建立共享排程設定與種子基線的 2 個 GPU 群組。
    以設定列是否存在判斷「首次」，所以管理者刪掉預設群組後不會被自動加回。"""
    settings = session.get(SharedSchedulingSettings, 1)
    if settings is None:
        settings = SharedSchedulingSettings(id=1, time_slice_replicas=4, job_timeout_minutes=60)
        session.add(settings)
        existing = set(session.scalars(select(GpuGroup.name)))
        for name, pool, count, mode in DEFAULT_GROUPS:
            if name not in existing:
                session.add(GpuGroup(name=name, pool=pool, gpu_count=count, mode=mode))
        session.commit()
    return settings


def group_out(g: GpuGroup) -> dict:
    return {"name": g.name, "pool": g.pool, "gpu_count": g.gpu_count, "mode": g.mode, "queue": g.pool}


def _validate(pool: str, mode: str, gpu_count: int) -> None:
    if pool not in POOL_MODES:
        raise Invalid(f"不存在的 GPU 池：{pool}（可用：{', '.join(POOL_MODES)}）")
    if mode != POOL_MODES[pool]:
        raise Invalid(f"{pool} 只能使用 {POOL_MODES[pool]} 模式")
    if gpu_count < 1:
        raise Invalid("GPU 數量至少為 1")


def get_group(session: Session, name: str) -> GpuGroup:
    group = session.scalar(select(GpuGroup).where(GpuGroup.name == name))
    if group is None:
        raise NotFound(f"找不到 GPU 群組 {name}")
    return group


def create_group(session: Session, *, actor: str, name: str, pool: str, gpu_count: int, mode: str,
                 source_ip: str | None) -> GpuGroup:
    _validate(pool, mode, gpu_count)
    if session.scalar(select(GpuGroup).where(GpuGroup.name == name)):
        raise Conflict(f"GPU 群組「{name}」已存在")
    group = GpuGroup(name=name, pool=pool, gpu_count=gpu_count, mode=mode)
    session.add(group)
    record(session, actor=actor, category=AuditCategory.PROJECT, action="gpu_group.create",
           target=f"gpu_group:{name}", source_ip=source_ip, detail=group_out(group))
    session.commit()
    return group


def update_group(session: Session, *, actor: str, name: str, changes: dict, source_ip: str | None) -> GpuGroup:
    group = get_group(session, name)
    merged = {"pool": group.pool, "mode": group.mode, "gpu_count": group.gpu_count} | changes
    _validate(merged["pool"], merged["mode"], merged["gpu_count"])
    for key, value in changes.items():
        setattr(group, key, value)
    record(session, actor=actor, category=AuditCategory.PROJECT, action="gpu_group.update",
           target=f"gpu_group:{name}", source_ip=source_ip, detail=changes)
    session.commit()
    return group


def delete_group(session: Session, *, actor: str, name: str, source_ip: str | None) -> None:
    group = get_group(session, name)
    bound = session.scalars(select(Project.name).where(Project.gpu_group == name)).all()
    if bound:
        raise Conflict(f"GPU 群組「{name}」仍綁定專案：{', '.join(bound)}")
    session.delete(group)
    record(session, actor=actor, category=AuditCategory.PROJECT, action="gpu_group.delete",
           target=f"gpu_group:{name}", source_ip=source_ip)
    session.commit()


# ---------- 叢集 ----------

def node_out(n) -> dict:
    return {"name": n.name, "pool": n.pool, "ready": n.ready, "gpu_capacity": n.gpu_capacity,
            "gpu_allocatable": n.gpu_allocatable, "gpu_physical": n.gpu_physical}


def _int_label(labels: dict, key: str) -> int | None:
    value = labels.get(key)
    return int(value) if value and value.isdigit() else None


def gpu_dashboard(backend: JobBackend) -> list[dict]:
    """GPU Dashboard 只讀 Job 標籤（Mac 上沒有 DCGM），甲方環境同一張表再加上 DCGM 使用率。"""
    rows = [
        {"node": a.node, "gpu_index": a.gpu_index, "slot": a.slot, "k8s_name": a.job_name,
         "project_id": _int_label(a.labels, "platform/project-id"),
         "job_id": _int_label(a.labels, "platform/job-id"),
         "training_id": _int_label(a.labels, "platform/training-id"),
         "user": a.labels.get("platform/user")}
        for a in backend.allocations()
    ]
    return sorted(rows, key=lambda r: (r["node"], r["gpu_index"], r["slot"]))


def settings_out(s: SharedSchedulingSettings) -> dict:
    return {"time_slice_replicas": s.time_slice_replicas, "job_timeout_minutes": s.job_timeout_minutes}


def update_shared_settings(session: Session, backend: JobBackend, *, actor: str, time_slice_replicas: int,
                           job_timeout_minutes: int, source_ip: str | None) -> SharedSchedulingSettings:
    settings = ensure_defaults(session)
    settings.time_slice_replicas = time_slice_replicas
    settings.job_timeout_minutes = job_timeout_minutes
    record(session, actor=actor, category=AuditCategory.PROJECT, action="shared_scheduling.update",
           target="shared_scheduling", source_ip=source_ip, detail=settings_out(settings))
    session.flush()
    try:
        backend.configure_shared(time_slice_replicas)
    except Exception as exc:
        session.rollback()
        raise Unavailable(f"無法套用共享排程設定到叢集：{exc}")
    session.commit()
    return settings


# ---------- 工作 ----------

# 工作種類 → 是否用 GPU；GPU 工作走專案綁定群組的池，CPU 工作走固定的池
JOB_KINDS = {"training": True, "data-cleaning": False}
CPU_POOLS = {"data-cleaning": "cpu-data"}
TRAINING_KINDS = {"training"}

_LABEL_BAD = re.compile(r"[^A-Za-z0-9_.-]+")


def label_value(value: str) -> str:
    """轉成合法的 Kubernetes 標籤值（英數字開頭結尾、最多 63 字）。"""
    return _LABEL_BAD.sub("-", value)[:63].strip("-_.")


def job_out(job: Job) -> dict:
    return {
        "id": job.id, "project_id": job.project_id, "user": job.user, "kind": job.kind,
        "gpu_group": job.gpu_group, "queue": job.queue, "status": job.status, "k8s_name": job.k8s_name,
        "message": job.message, "created_at": job.created_at, "started_at": job.started_at,
        "finished_at": job.finished_at,
    }


def job_labels(job: Job, training_id: int | None = None) -> dict[str, str]:
    labels = {"platform/project-id": str(job.project_id), "platform/job-id": str(job.id),
              "platform/user": label_value(job.user)}
    if job.kind in TRAINING_KINDS:
        labels["platform/training-id"] = str(training_id if training_id is not None else job.id)
    return labels


def submit_job(session: Session, backend: JobBackend, *, project: Project, actor: str, kind: str,
               duration_seconds: int = 30, fail: bool = False, memory_mb: int = 16, source_ip: str | None,
               workload: Workload | None = None, on_created: Callable[[Job], None] | None = None) -> Job:
    """workload 有值時送出真實工作（映像＋指令），否則是假工作。
    on_created 在 Job 取得 id 之後、送進排程系統之前呼叫，讓呼叫端在同一個交易內建立關聯。"""
    settings = ensure_defaults(session)
    uses_gpu = JOB_KINDS[kind]
    group = None
    if uses_gpu:
        if not project.gpu_group:
            raise Conflict(f"專案「{project.name}」尚未綁定 GPU 群組，無法送出 GPU 工作")
        group = session.scalar(select(GpuGroup).where(GpuGroup.name == project.gpu_group))
        if group is None:
            raise Conflict(f"專案綁定的 GPU 群組「{project.gpu_group}」不存在")
    pool = group.pool if group else CPU_POOLS[kind]
    job = Job(project_id=project.id, user=actor, kind=kind, gpu_group=group.name if group else None, queue=pool)
    session.add(job)
    session.flush()
    job.k8s_name = f"job-{job.id}-{secrets.token_hex(3)}"
    # 共享池是大家輪流用的卡，加上執行時限；獨占池的長時間訓練不設限
    timeout = settings.job_timeout_minutes * 60 if group and group.mode == "shared" else None
    if workload is None:
        spec = JobSpec(name=job.k8s_name, queue=pool, pool=pool, gpus=1 if uses_gpu else 0,
                       duration_seconds=duration_seconds, fail=fail, memory_mb=memory_mb,
                       labels=job_labels(job), timeout_seconds=timeout)
    else:
        spec = JobSpec(name=job.k8s_name, queue=pool, pool=pool, gpus=1 if uses_gpu else 0,
                       duration_seconds=workload.expected_seconds, memory_mb=workload.memory_mb,
                       labels=job_labels(job, workload.training_id), timeout_seconds=timeout,
                       image=workload.image, command=tuple(workload.command),
                       env=tuple(sorted(workload.env.items())), cpu_request=workload.cpu_request)
    if on_created is not None:
        on_created(job)
    record(session, actor=actor, category=AuditCategory.TRAINING, action="job.submit", target=f"job:{job.id}",
           source_ip=source_ip, detail={"project_id": project.id, "kind": kind, "queue": pool,
                                        "gpu_group": job.gpu_group, "k8s_name": job.k8s_name})
    try:
        backend.submit(spec)
    except Exception as exc:
        session.rollback()
        raise Unavailable(f"無法送出工作到排程系統：{exc}")
    session.commit()
    return job


def _apply(job: Job, status: JobStatus) -> None:
    check_transition(JobStatus(job.status), status)
    job.status = status.value
    now = utcnow()
    if status == JobStatus.RUNNING and job.started_at is None:
        job.started_at = now
    if status in TERMINAL:
        job.finished_at = now


def sync_job(backend: JobBackend, job: Job) -> None:
    """以後端的實際狀態更新資料庫，只接受合法轉換。"""
    current = JobStatus(job.status)
    if current in TERMINAL:
        return
    observed = backend.get(job.k8s_name)
    if observed is None:
        target, message = JobStatus.FAILED, "工作在叢集中消失（可能被手動刪除）"
    else:
        target, message = observed.state, observed.message
    try:
        steps = path_to(current, target)
    except InvalidTransition:
        job.message = f"忽略後端回報的狀態 {target.value}（目前 {current.value}）"
        return
    for step in steps:
        _apply(job, step)
    if message:
        job.message = message


def get_job(session: Session, project_id: int, job_id: int) -> Job:
    job = session.get(Job, job_id)
    if job is None or job.project_id != project_id:
        raise NotFound(f"找不到工作 {job_id}")
    return job


def list_jobs(session: Session, backend: JobBackend, project_id: int) -> list[Job]:
    jobs = session.scalars(select(Job).where(Job.project_id == project_id).order_by(Job.id)).all()
    for job in jobs:
        sync_job(backend, job)
    session.commit()
    return list(jobs)


def refresh_job(session: Session, backend: JobBackend, project_id: int, job_id: int) -> Job:
    job = get_job(session, project_id, job_id)
    sync_job(backend, job)
    session.commit()
    return job


def cancel_job(session: Session, backend: JobBackend, *, project_id: int, job_id: int, actor: str,
               source_ip: str | None) -> Job:
    job = get_job(session, project_id, job_id)
    sync_job(backend, job)
    if JobStatus(job.status) in TERMINAL:
        session.commit()
        raise Conflict(f"工作 {job_id} 已結束（{job.status}），無法取消")
    try:
        backend.cancel(job.k8s_name)
    except Exception as exc:
        raise Unavailable(f"無法取消排程系統中的工作：{exc}")
    _apply(job, JobStatus.CANCELLED)
    record(session, actor=actor, category=AuditCategory.TRAINING, action="job.cancel", target=f"job:{job.id}",
           source_ip=source_ip, detail={"project_id": project_id, "k8s_name": job.k8s_name})
    session.commit()
    return job
