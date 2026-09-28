from collections.abc import Iterator
from contextlib import contextmanager

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.deps import client_ip, get_session, require_admin
from app.models import User
from app.scheduling import service
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
