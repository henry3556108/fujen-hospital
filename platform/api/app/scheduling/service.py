import logging
import re
import secrets

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit import AuditCategory, record
from app.models import Project, User, utcnow
from app.permissions import AccountType
from collections.abc import Callable

from app.scheduling.backend import BackendJob, JobBackend, JobSpec, NotWaiting, PartialReorder, Workload
from app.scheduling.models import GpuGroup, Job, JobHold, SharedSchedulingSettings
from app.scheduling.states import TERMINAL, InvalidTransition, JobStatus, check_transition, path_to

# 兩個 GPU 池（架構決策：獨占 2 張、共享 1 張時間片；不用 MIG）
POOL_MODES = {"gpu-exclusive": "exclusive", "gpu-shared": "shared"}
DEFAULT_GROUPS = [("gpu-exclusive", "gpu-exclusive", 2, "exclusive"), ("gpu-shared", "gpu-shared", 1, "shared")]

log = logging.getLogger(__name__)


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


class Forbidden(SchedulingError):
    status_code = 403


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
# inference／inference-cpu 是平台送出的批次推論（影像模型用 GPU、結構式模型只用 CPU），使用者不能直接送
JOB_KINDS = {"training": True, "data-cleaning": False, "inference": True, "inference-cpu": False}
CPU_POOLS = {"data-cleaning": "cpu-data", "inference-cpu": "cpu-data"}
TRAINING_KINDS = {"training"}
INFERENCE_KINDS = {"inference", "inference-cpu"}


def _category(kind: str) -> AuditCategory:
    return AuditCategory.INFERENCE if kind in INFERENCE_KINDS else AuditCategory.TRAINING

_LABEL_BAD = re.compile(r"[^A-Za-z0-9_.-]+")


def label_value(value: str) -> str:
    """轉成合法的 Kubernetes 標籤值（英數字開頭結尾、最多 63 字）。"""
    return _LABEL_BAD.sub("-", value)[:63].strip("-_.")


# 舊版本寫進資料庫的內部訊息（排程狀態判斷），不顯示給使用者
_INTERNAL_MESSAGE_PREFIXES = ("忽略後端回報的狀態",)


def user_message(message: str | None) -> str:
    message = message or ""
    return "" if message.startswith(_INTERNAL_MESSAGE_PREFIXES) else message


def job_out(job: Job) -> dict:
    return {
        "id": job.id, "project_id": job.project_id, "user": job.user, "kind": job.kind,
        "gpu_group": job.gpu_group, "queue": job.queue, "status": job.status, "k8s_name": job.k8s_name,
        "message": user_message(job.message), "created_at": job.created_at, "started_at": job.started_at,
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
    record(session, actor=actor, category=_category(kind), action="job.submit", target=f"job:{job.id}",
           source_ip=source_ip, detail={"project_id": project.id, "kind": kind, "queue": pool,
                                        "gpu_group": job.gpu_group, "k8s_name": job.k8s_name})
    try:
        backend.submit(spec)
    except Exception as exc:
        session.rollback()
        raise Unavailable(f"無法送出工作到排程系統：{exc}")
    session.commit()
    return job


def _apply(job: Job, status: JobStatus, observed: BackendJob | None = None) -> None:
    """observed：後端回報的實際開始／結束時間（叢集時間）；沒有才用現在（例如平台自己取消）。"""
    check_transition(JobStatus(job.status), status)
    job.status = status.value
    now = utcnow()
    if status == JobStatus.RUNNING and job.started_at is None:
        job.started_at = (observed.started_at if observed else None) or now
    if status in TERMINAL:
        job.finished_at = (observed.finished_at if observed else None) or now


def sync_job(backend: JobBackend, job: Job) -> None:
    """以後端的實際狀態更新資料庫，只接受合法轉換。"""
    current = JobStatus(job.status)
    if current in TERMINAL or current == JobStatus.HELD:   # 暫存中的工作不在叢集裡，沒有東西可同步
        return
    observed = backend.get(job.k8s_name)
    if observed is None:
        target, message = JobStatus.FAILED, "工作在叢集中消失（可能被手動刪除）"
    else:
        target, message = observed.state, observed.message
    try:
        steps = path_to(current, target)
    except InvalidTransition:
        # 例如 Pod 重建時後端短暫回報 queued：屬內部判斷，只寫 log，不寫進使用者看得到的訊息
        log.info("工作 %s（%s）忽略後端回報的狀態 %s（目前 %s）", job.id, job.k8s_name, target.value, current.value)
        return
    for step in steps:
        _apply(job, step, observed)
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
    mark_cancelled(session, backend, job, actor=actor, source_ip=source_ip)
    session.commit()
    return job


def mark_cancelled(session: Session, backend: JobBackend, job: Job, *, actor: str, source_ip: str | None) -> None:
    """從排程系統刪除工作、狀態改為 cancelled、寫稽核，但不 commit：讓呼叫端把自己的狀態變更放進同一個交易。
    呼叫前工作必須尚未結束（先 sync_job）。暫存中的工作只要刪掉保存的定義。"""
    if job.status == JobStatus.HELD.value:
        hold = session.get(JobHold, job.id)
        if hold is not None:
            session.delete(hold)
    else:
        try:
            backend.cancel(job.k8s_name)
        except Exception as exc:
            raise Unavailable(f"無法取消排程系統中的工作：{exc}")
    _apply(job, JobStatus.CANCELLED)
    record(session, actor=actor, category=_category(job.kind), action="job.cancel", target=f"job:{job.id}",
           source_ip=source_ip, detail={"project_id": job.project_id, "k8s_name": job.k8s_name})


# ---------- 佇列順序與暫存 ----------

def _new_name(job: Job) -> str:
    return f"job-{job.id}-{secrets.token_hex(3)}"


def get_any_job(session: Session, job_id: int) -> Job:
    job = session.get(Job, job_id)
    if job is None:
        raise NotFound(f"找不到工作 {job_id}")
    return job


def check_owner(job: Job, user: User) -> None:
    """暫存與恢復排隊只限送出工作的人或 Admin。"""
    if job.user != user.username and user.account_type != AccountType.ADMIN:
        raise Forbidden(f"只有送出工作 {job.id} 的使用者（{job.user}）或 Admin 可以暫存或恢復排隊")


def mark_held(session: Session, backend: JobBackend, job: Job, *, actor: str, source_ip: str | None) -> None:
    """把排隊中的工作移出佇列：刪除叢集中的 Job、定義存進 job_holds、狀態改為 held、寫稽核。不 commit。"""
    sync_job(backend, job)
    status = JobStatus(job.status)
    if status == JobStatus.RUNNING:
        raise Conflict(f"工作 {job.id} 已在執行中，無法暫存（執行中的訓練無法中途保存進度，只能取消）")
    if status == JobStatus.HELD:
        raise Conflict(f"工作 {job.id} 已經暫存")
    if status in TERMINAL:
        raise Conflict(f"工作 {job.id} 已結束（{job.status}），無法暫存")
    try:
        manifest = backend.hold(job.k8s_name)
    except NotWaiting:
        raise Conflict(f"工作 {job.id} 已被排程放行、即將開始執行，無法暫存")
    except Exception as exc:
        raise Unavailable(f"無法從排程系統移出工作：{exc}")
    session.add(JobHold(job_id=job.id, manifest=manifest, held_by=actor))
    _apply(job, JobStatus.HELD)
    job.message = f"由 {actor} 暫存，恢復排隊後重新排到佇列最後"
    record(session, actor=actor, category=_category(job.kind), action="job.hold", target=f"job:{job.id}",
           source_ip=source_ip, detail={"project_id": job.project_id, "queue": job.queue, "k8s_name": job.k8s_name})


def mark_resumed(session: Session, backend: JobBackend, job: Job, *, actor: str, source_ip: str | None) -> None:
    """以保存的定義在叢集重建工作（新名稱、排到佇列最後），狀態改回 queued、寫稽核。不 commit。"""
    if job.status != JobStatus.HELD.value:
        raise Conflict(f"工作 {job.id} 不是暫存狀態（{job.status}），無法恢復排隊")
    hold = session.get(JobHold, job.id)
    if hold is None:
        raise Conflict(f"找不到工作 {job.id} 暫存的定義，請取消後重新送出")
    name = _new_name(job)
    try:
        backend.restore(hold.manifest, name)
    except Exception as exc:
        raise Unavailable(f"無法把工作送回排程系統：{exc}")
    previous, job.k8s_name = job.k8s_name, name
    session.delete(hold)
    _apply(job, JobStatus.QUEUED)
    job.message = ""
    record(session, actor=actor, category=_category(job.kind), action="job.resume", target=f"job:{job.id}",
           source_ip=source_ip, detail={"project_id": job.project_id, "queue": job.queue, "k8s_name": name,
                                        "previous_k8s_name": previous, "held_by": hold.held_by})


def hold_job(session: Session, backend: JobBackend, job: Job, *, actor: str, source_ip: str | None) -> Job:
    try:
        mark_held(session, backend, job, actor=actor, source_ip=source_ip)
    except SchedulingError:
        session.commit()   # 保留 sync_job 的狀態更新
        raise
    session.commit()
    return job


def resume_job(session: Session, backend: JobBackend, job: Job, *, actor: str, source_ip: str | None) -> Job:
    mark_resumed(session, backend, job, actor=actor, source_ip=source_ip)
    session.commit()
    return job


def queue_names(session: Session) -> list[str]:
    """所有佇列：GPU 群組用到的池，加上 CPU 池。"""
    pools = sorted({g.pool for g in session.scalars(select(GpuGroup))})
    return pools + sorted(set(CPU_POOLS.values()) - set(pools))


def _links(session: Session, ids: list[int]) -> dict[int, dict]:
    """工作對應的訓練或批次推論（排程模組不依賴訓練模組，這裡才載入）。"""
    from app.training.models import InferenceBatch, TrainingRun

    out: dict[int, dict] = {}
    if not ids:
        return out
    for run in session.scalars(select(TrainingRun).where(TrainingRun.job_id.in_(ids))):
        out[run.job_id] = {"training_run": {"id": run.id, "name": run.name}}
    for batch in session.scalars(select(InferenceBatch).where(InferenceBatch.job_id.in_(ids))):
        out[batch.job_id] = {"inference_id": batch.record_id}
    return out


def _queue_row(job: Job, *, projects: dict[int, str], links: dict[int, dict], position: int | None,
               admitted: bool = False, hold: JobHold | None = None) -> dict:
    link = links.get(job.id, {})
    return {"id": job.id, "project_id": job.project_id, "project_name": projects.get(job.project_id, ""),
            "user": job.user, "kind": job.kind, "status": job.status, "queue": job.queue, "k8s_name": job.k8s_name,
            "created_at": job.created_at, "started_at": job.started_at, "position": position,
            "admitted": admitted, "training_run": link.get("training_run"), "inference_id": link.get("inference_id"),
            "held_by": hold.held_by if hold else None, "held_at": hold.held_at if hold else None}


def _waiting_order(backend: JobBackend, queue: str) -> list[str]:
    try:
        return backend.order(queue)
    except Exception as exc:
        raise Unavailable(f"無法讀取佇列 {queue}：{exc}")


def queue_overview(session: Session, backend: JobBackend) -> list[dict]:
    """每個佇列的進行中工作：執行中（含已放行、容器啟動中）在前，等待中依實際開始的先後，暫存的另列。"""
    active = session.scalars(select(Job).where(Job.status.in_(
        [JobStatus.QUEUED.value, JobStatus.RUNNING.value, JobStatus.HELD.value])).order_by(Job.id)).all()
    try:
        for job in active:
            sync_job(backend, job)
    except Exception as exc:
        session.rollback()
        raise Unavailable(f"無法讀取排程系統的工作狀態：{exc}")
    session.commit()
    projects = dict(session.execute(select(Project.id, Project.name)).all())
    links = _links(session, [j.id for j in active])
    holds = {h.job_id: h for h in session.scalars(select(JobHold))}
    names = queue_names(session)
    names += sorted({j.queue for j in active} - set(names))
    out = []
    for queue in names:
        jobs = [j for j in active if j.queue == queue]
        order = {name: i for i, name in enumerate(_waiting_order(backend, queue))}
        waiting = sorted((j for j in jobs if j.status == JobStatus.QUEUED.value and j.k8s_name in order),
                         key=lambda j: order[j.k8s_name])
        started = [j for j in jobs if j.status == JobStatus.RUNNING.value
                   or (j.status == JobStatus.QUEUED.value and j.k8s_name not in order)]
        held = sorted((j for j in jobs if j.status == JobStatus.HELD.value),
                      key=lambda j: (holds[j.id].held_at if j.id in holds else j.created_at, j.id))

        def row(j: Job, **kw) -> dict:
            return _queue_row(j, projects=projects, links=links, **kw)

        out.append({
            "queue": queue,
            "running": [row(j, position=None, admitted=j.status == JobStatus.QUEUED.value) for j in started],
            "waiting": [row(j, position=i + 1) for i, j in enumerate(waiting)],
            "held": [row(j, position=None, hold=holds.get(j.id)) for j in held],
        })
    return out


def reorder_queue(session: Session, backend: JobBackend, *, queue: str, job_ids: list[int], actor: str,
                  source_ip: str | None) -> list[int]:
    """調整佇列中等待工作的先後。job_ids 必須剛好是目前等待中的全部工作。
    已在正確位置的開頭幾件不動，其餘依新順序重建（排到佇列最後）。回傳套用後的順序。"""
    if queue not in queue_names(session):
        raise NotFound(f"找不到佇列 {queue}")
    if len(set(job_ids)) != len(job_ids):
        raise Invalid("工作清單有重複的編號")
    jobs = session.scalars(select(Job).where(Job.queue == queue, Job.status == JobStatus.QUEUED.value)).all()
    try:
        for job in jobs:
            sync_job(backend, job)
    except Exception as exc:
        session.rollback()
        raise Unavailable(f"無法讀取排程系統的工作狀態：{exc}")
    by_name = {j.k8s_name: j for j in jobs if j.status == JobStatus.QUEUED.value}
    current = [by_name[n].id for n in _waiting_order(backend, queue) if n in by_name]
    if set(job_ids) != set(current):
        session.commit()
        listed = "、".join(map(str, current)) or "（沒有）"
        raise Conflict(f"佇列 {queue} 目前等待中的工作是 {listed}，與送出的清單不同（可能有工作已開始或剛送出）；"
                       "請重新整理後再調整")
    keep = 0
    while keep < len(current) and current[keep] == job_ids[keep]:
        keep += 1
    by_id = {j.id: j for j in by_name.values()}
    moving = [by_id[i] for i in job_ids[keep:]]
    moves = [(j.k8s_name, _new_name(j)) for j in moving]
    by_old = {j.k8s_name: j for j in moving}

    def rename(moved: dict[str, str]) -> list[int]:
        for old, new in moved.items():
            by_old[old].k8s_name = new
        return [by_old[old].id for old in moved]

    detail = {"queue": queue, "before": current, "after": job_ids}
    try:
        if moves:
            backend.reorder(moves)
    except NotWaiting as exc:
        moved = rename(exc.moved)
        blocked = by_old.get(exc.name)
        record(session, actor=actor, category=AuditCategory.PROJECT, action="queue.reorder", target=f"queue:{queue}",
               result="conflict", source_ip=source_ip, detail=detail | {"moved": moved})
        session.commit()
        who = f"工作 {blocked.id} " if blocked else "有工作"
        done = f"已移到佇列最後的工作：{'、'.join(map(str, moved))}" if moved else "順序沒有變更"
        raise Conflict(f"{who}在調整途中被排程放行、開始執行，無法完成調整（{done}）；請重新整理後再調整")
    except PartialReorder as exc:
        moved = rename(exc.moved)
        for old, manifest in exc.unplaced.items():
            job = by_old[old]
            session.add(JobHold(job_id=job.id, manifest=manifest, held_by=actor))
            _apply(job, JobStatus.HELD)
            job.message = "調整順序時無法送回排程系統，已改為暫存；請恢復排隊"
        record(session, actor=actor, category=AuditCategory.PROJECT, action="queue.reorder", target=f"queue:{queue}",
               result="failure", source_ip=source_ip,
               detail=detail | {"moved": moved, "held": [by_old[o].id for o in exc.unplaced]})
        session.commit()
        raise Unavailable(f"調整順序途中無法送出工作到排程系統：{exc}；未送出的工作已改為暫存，可在佇列頁恢復排隊")
    except Exception as exc:
        session.rollback()
        raise Unavailable(f"無法調整排程系統的佇列：{exc}")
    rename(dict(moves))
    record(session, actor=actor, category=AuditCategory.PROJECT, action="queue.reorder", target=f"queue:{queue}",
           source_ip=source_ip, detail=detail | {"moved": [j.id for j in moving]})
    session.commit()
    return list(job_ids)
