from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.deps import ProjectContext, client_ip, get_session, require_admin
from app.llm import registry
from app.llm.http import coding, errors, is_admin
from app.llm.services import LlmServices, get_services
from app.models import User
from app.llm.util import iso

router = APIRouter()
_SHA = r"^[0-9a-fA-F]{64}$"


class WhitelistIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
    source: str = Field(min_length=1, max_length=128)
    repo: str = Field(min_length=1, max_length=256)
    revision: str = Field(min_length=7, max_length=64, pattern=r"^[0-9a-fA-F]+$")
    sha256: str = Field(pattern=_SHA)
    license: str = Field(default="", max_length=64)
    requires_token: bool = False
    has_remote_code: bool = False
    note: str = Field(default="", max_length=512)


class InspectIn(BaseModel):
    source: str
    repo: str
    revision: str
    token: str | None = None


class DownloadIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str | None = None
    source: str | None = None
    repo: str | None = None


class ExecuteIn(BaseModel):
    token: str | None = Field(default=None, max_length=512)


class ReviewIn(BaseModel):
    reason: str = Field(default="", max_length=512)


class LoadConfigIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    quantization: str
    cpu: int = Field(ge=1, le=256)
    memory_gb: int = Field(ge=1, le=2048)
    gpu_type: str
    gpu_count: int = Field(ge=0, le=16)


# ---------------------------------------------------------------- Admin

@router.get("/api/admin/llm/whitelist")
def list_whitelist(admin: User = Depends(require_admin), session: Session = Depends(get_session)) -> list[dict]:
    return registry.list_catalog(session)


@router.post("/api/admin/llm/whitelist", status_code=201)
def add_whitelist(body: WhitelistIn, request: Request, admin: User = Depends(require_admin),
                  session: Session = Depends(get_session)) -> dict:
    with errors():
        entry = registry.add_whitelist(session, actor=admin.username, source_ip=client_ip(request),
                                       **body.model_dump())
    return registry.whitelist_out(entry)


@router.delete("/api/admin/llm/whitelist/{name}", status_code=204)
def remove_whitelist(name: str, request: Request, admin: User = Depends(require_admin),
                     session: Session = Depends(get_session)) -> Response:
    with errors():
        registry.remove_whitelist(session, actor=admin.username, source_ip=client_ip(request), name=name)
    return Response(status_code=204)


@router.post("/api/admin/llm/whitelist/inspect")
def inspect(body: InspectIn, admin: User = Depends(require_admin),
            services: LlmServices = Depends(get_services)) -> dict:
    with errors():
        return registry.inspect_source(services.sources, **body.model_dump())


@router.get("/api/admin/llm/downloads")
def admin_downloads(admin: User = Depends(require_admin), session: Session = Depends(get_session)) -> list[dict]:
    return [registry.download_out(d) for d in registry.list_downloads(session)]


@router.post("/api/admin/llm/downloads/{download_id}/approve")
def approve(download_id: int, request: Request, body: ReviewIn | None = None, admin: User = Depends(require_admin),
            session: Session = Depends(get_session)) -> dict:
    with errors():
        d = registry.review_download(session, actor=admin.username, source_ip=client_ip(request),
                                     download_id=download_id, approve=True, reason=body.reason if body else "")
    return registry.download_out(d)


@router.post("/api/admin/llm/downloads/{download_id}/reject")
def reject(download_id: int, request: Request, body: ReviewIn | None = None, admin: User = Depends(require_admin),
           session: Session = Depends(get_session)) -> dict:
    with errors():
        d = registry.review_download(session, actor=admin.username, source_ip=client_ip(request),
                                     download_id=download_id, approve=False, reason=body.reason if body else "")
    return registry.download_out(d)


@router.post("/api/admin/llm/models/{name}/remote-code-approval", status_code=201)
def approve_remote_code(name: str, request: Request, admin: User = Depends(require_admin),
                        session: Session = Depends(get_session)) -> dict:
    with errors():
        a = registry.approve_remote_code(session, actor=admin.username, source_ip=client_ip(request), name=name)
    return {"name": a.name, "commit": a.commit, "approved_by": a.approved_by, "approved_at": iso(a.approved_at)}


@router.delete("/api/admin/llm/models/{name}/remote-code-approval", status_code=204)
def revoke_remote_code(name: str, request: Request, admin: User = Depends(require_admin),
                       session: Session = Depends(get_session)) -> Response:
    with errors():
        registry.revoke_remote_code(session, actor=admin.username, source_ip=client_ip(request), name=name)
    return Response(status_code=204)


# ---------------------------------------------------------------- 專案範圍（coding）

P = "/api/projects/{project_id}/llm/models"


@router.get(P + "/catalog")
def catalog(ctx: ProjectContext = Depends(coding)) -> list[dict]:
    return registry.list_catalog(ctx.session)


@router.post(P + "/downloads", status_code=201)
def request_download(body: DownloadIn, request: Request, ctx: ProjectContext = Depends(coding)) -> dict:
    with errors():
        d = registry.request_download(ctx.session, actor=ctx.user.username, source_ip=client_ip(request),
                                      project_id=ctx.project.id, **body.model_dump())
    return registry.download_out(d)


@router.get(P + "/downloads")
def downloads(ctx: ProjectContext = Depends(coding)) -> list[dict]:
    return [registry.download_out(d) for d in registry.list_downloads(ctx.session, project_id=ctx.project.id)]


@router.post(P + "/downloads/{download_id}/execute")
def execute(download_id: int, body: ExecuteIn, request: Request, ctx: ProjectContext = Depends(coding),
            services: LlmServices = Depends(get_services)) -> dict:
    with errors():
        d = registry.execute_download(ctx.session, sources=services.sources, offline=services.offline,
                                      model_dir=services.model_dir, actor=ctx.user.username,
                                      is_admin=is_admin(ctx.user), source_ip=client_ip(request),
                                      download_id=download_id, token=body.token)
    return registry.download_out(d)


@router.delete(P + "/{name}", status_code=204)
def delete_model(name: str, request: Request, ctx: ProjectContext = Depends(coding),
                 services: LlmServices = Depends(get_services)) -> Response:
    with errors():
        registry.delete_model(ctx.session, runtime=services.runtime, actor=ctx.user.username,
                              is_admin=is_admin(ctx.user), source_ip=client_ip(request), name=name)
    return Response(status_code=204)


@router.get(P + "/{name}/load-config")
def get_load_config(name: str, ctx: ProjectContext = Depends(coding)) -> dict:
    with errors():
        return registry.load_config_out(registry.get_load_config(ctx.session, name, actor=ctx.user.username))


@router.put(P + "/{name}/load-config")
def put_load_config(name: str, body: LoadConfigIn, request: Request, ctx: ProjectContext = Depends(coding)) -> dict:
    with errors():
        c = registry.put_load_config(ctx.session, actor=ctx.user.username, source_ip=client_ip(request), name=name,
                                     **body.model_dump())
    return registry.load_config_out(c)


@router.post(P + "/{name}/load")
def load(name: str, request: Request, ctx: ProjectContext = Depends(coding),
         services: LlmServices = Depends(get_services)) -> dict:
    with errors():
        return registry.load_model(ctx.session, runtime=services.runtime, actor=ctx.user.username,
                                   source_ip=client_ip(request), name=name)


@router.post(P + "/{name}/unload")
def unload(name: str, request: Request, ctx: ProjectContext = Depends(coding),
           services: LlmServices = Depends(get_services)) -> dict:
    with errors():
        return registry.unload_model(ctx.session, runtime=services.runtime, actor=ctx.user.username,
                                     source_ip=client_ip(request), name=name)
