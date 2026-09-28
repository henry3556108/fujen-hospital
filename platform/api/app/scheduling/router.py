from collections.abc import Iterator
from contextlib import contextmanager
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.deps import ProjectContext, client_ip, get_session, require_admin, require_project_permission
from app.models import User
from app.permissions import Permission
from app.scheduling import service
from app.scheduling.backend import JobBackend, backend_from_env
from app.scheduling.models import GpuGroup

router = APIRouter()


@contextmanager
def _errors() -> Iterator[None]:
    try:
        yield
    except service.SchedulingError as exc:
        raise HTTPException(exc.status_code, str(exc))


def sched_session(session: Session = Depends(get_session)) -> Session:
    with _errors():
        service.ensure_defaults(session)
    return session


def get_backend(request: Request) -> JobBackend:
    backend = getattr(request.app.state, "job_backend", None)
    if backend is None:
        backend = backend_from_env()
        if backend is None:
            raise HTTPException(503, "排程服務尚未設定（JOB_BACKEND）")
        request.app.state.job_backend = backend
    return backend


# ---------- 專案工作（需 training 權限） ----------

class JobIn(BaseModel):
    kind: Literal["training", "data-cleaning"] = "training"
    duration_seconds: int = Field(default=30, ge=1, le=3600)
    fail: bool = False
    memory_mb: int = Field(default=16, ge=1, le=256)


@router.post("/api/projects/{project_id}/jobs", status_code=201)
def submit_job(body: JobIn, request: Request, ctx: ProjectContext = Depends(require_project_permission(Permission.TRAINING)),
               backend: JobBackend = Depends(get_backend)) -> dict:
    with _errors():
        job = service.submit_job(ctx.session, backend, project=ctx.project, actor=ctx.user.username,
                                 source_ip=client_ip(request), **body.model_dump())
    return service.job_out(job)


@router.get("/api/projects/{project_id}/jobs")
def list_jobs(ctx: ProjectContext = Depends(require_project_permission(Permission.TRAINING)),
              backend: JobBackend = Depends(get_backend)) -> list[dict]:
    return [service.job_out(j) for j in service.list_jobs(ctx.session, backend, ctx.project.id)]


@router.get("/api/projects/{project_id}/jobs/{job_id}")
def get_job(job_id: int, ctx: ProjectContext = Depends(require_project_permission(Permission.TRAINING)),
            backend: JobBackend = Depends(get_backend)) -> dict:
    with _errors():
        return service.job_out(service.refresh_job(ctx.session, backend, ctx.project.id, job_id))


@router.post("/api/projects/{project_id}/jobs/{job_id}/cancel")
def cancel_job(job_id: int, request: Request,
               ctx: ProjectContext = Depends(require_project_permission(Permission.TRAINING)),
               backend: JobBackend = Depends(get_backend)) -> dict:
    with _errors():
        job = service.cancel_job(ctx.session, backend, project_id=ctx.project.id, job_id=job_id,
                                 actor=ctx.user.username, source_ip=client_ip(request))
    return service.job_out(job)


# ---------- GPU 群組（Admin） ----------

class GroupIn(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    pool: str
    gpu_count: int
    mode: str


class GroupPatch(BaseModel):
    pool: str = Field(default=None)
    gpu_count: int = Field(default=None)
    mode: str = Field(default=None)


@router.get("/api/admin/gpu-groups")
def list_groups(admin: User = Depends(require_admin), session: Session = Depends(sched_session)) -> list[dict]:
    return [service.group_out(g) for g in session.scalars(select(GpuGroup).order_by(GpuGroup.id))]


@router.post("/api/admin/gpu-groups", status_code=201)
def create_group(body: GroupIn, request: Request, admin: User = Depends(require_admin),
                 session: Session = Depends(sched_session)) -> dict:
    with _errors():
        g = service.create_group(session, actor=admin.username, source_ip=client_ip(request), **body.model_dump())
    return service.group_out(g)


@router.patch("/api/admin/gpu-groups/{name}")
def update_group(name: str, body: GroupPatch, request: Request, admin: User = Depends(require_admin),
                 session: Session = Depends(sched_session)) -> dict:
    with _errors():
        g = service.update_group(session, actor=admin.username, name=name,
                                 changes=body.model_dump(exclude_unset=True), source_ip=client_ip(request))
    return service.group_out(g)


@router.delete("/api/admin/gpu-groups/{name}", status_code=204)
def delete_group(name: str, request: Request, admin: User = Depends(require_admin),
                 session: Session = Depends(sched_session)) -> Response:
    with _errors():
        service.delete_group(session, actor=admin.username, name=name, source_ip=client_ip(request))
    return Response(status_code=204)


# ---------- 叢集（Admin） ----------

class SharedSettingsIn(BaseModel):
    time_slice_replicas: int = Field(ge=1, le=16)
    job_timeout_minutes: int = Field(ge=1, le=1440)


@router.get("/api/admin/cluster/nodes")
def list_nodes(admin: User = Depends(require_admin), backend: JobBackend = Depends(get_backend)) -> list[dict]:
    try:
        nodes = backend.nodes()
    except Exception as exc:
        raise HTTPException(503, f"無法讀取叢集節點：{exc}")
    return [service.node_out(n) for n in sorted(nodes, key=lambda n: n.name)]


@router.get("/api/admin/cluster/gpu-dashboard")
def gpu_dashboard(admin: User = Depends(require_admin), backend: JobBackend = Depends(get_backend)) -> list[dict]:
    try:
        return service.gpu_dashboard(backend)
    except Exception as exc:
        raise HTTPException(503, f"無法讀取 GPU 配置：{exc}")


@router.get("/api/admin/cluster/shared-scheduling")
def get_shared_settings(admin: User = Depends(require_admin), session: Session = Depends(sched_session)) -> dict:
    return service.settings_out(service.ensure_defaults(session))


@router.put("/api/admin/cluster/shared-scheduling")
def put_shared_settings(body: SharedSettingsIn, request: Request, admin: User = Depends(require_admin),
                        session: Session = Depends(sched_session), backend: JobBackend = Depends(get_backend)) -> dict:
    with _errors():
        s = service.update_shared_settings(session, backend, actor=admin.username, source_ip=client_ip(request),
                                           **body.model_dump())
    return service.settings_out(s)
