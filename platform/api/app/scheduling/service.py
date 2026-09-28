from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit import AuditCategory, record
from app.models import Project
from app.scheduling.models import GpuGroup, SharedSchedulingSettings

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
