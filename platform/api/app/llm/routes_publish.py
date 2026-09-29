from typing import Literal

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.deps import ProjectContext, client_ip, current_user, get_session
from app.llm import publish
from app.llm.http import coding, errors
from app.llm.params import GenerationParams
from app.llm.services import LlmServices, get_services
from app.models import User

router = APIRouter()
P = "/api/projects/{project_id}/llm/services"


class ServiceIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    slug: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{2,62}$")
    name: str = Field(min_length=1, max_length=128)
    description: str = Field(default="", max_length=512)
    model: str | None = None
    kb_id: int | None = None
    top_k: int = Field(default=3, ge=1, le=20)
    params: GenerationParams | None = None
    grants: list[str] = Field(default_factory=list)


class ServicePatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(default=None, min_length=1, max_length=128)
    description: str = Field(default=None, max_length=512)
    model: str = Field(default=None)
    kb_id: int | None = None
    top_k: int = Field(default=None, ge=1, le=20)
    params: GenerationParams = Field(default=None)
    enabled: bool = Field(default=None)


class GrantsIn(BaseModel):
    grants: list[str]


class Turn(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=8000)


class InvokeIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    question: str | None = Field(default=None, min_length=1, max_length=8000)
    messages: list[Turn] | None = None


@router.get(P)
def list_services(ctx: ProjectContext = Depends(coding)) -> list[dict]:
    return [publish.service_out(s) for s in publish.list_services(ctx.session, project_id=ctx.project.id)]


@router.post(P, status_code=201)
def create(body: ServiceIn, request: Request, ctx: ProjectContext = Depends(coding),
           services: LlmServices = Depends(get_services)) -> dict:
    with errors():
        s = publish.publish(ctx.session, services, project_id=ctx.project.id, actor=ctx.user.username,
                            source_ip=client_ip(request), **{**body.model_dump(), "params": body.params})
    return publish.service_out(s)


@router.get(P + "/{service_id}")
def get(service_id: int, ctx: ProjectContext = Depends(coding)) -> dict:
    with errors():
        return publish.service_out(publish.get_service(ctx.session, project_id=ctx.project.id,
                                                       service_id=service_id))


@router.patch(P + "/{service_id}")
def patch(service_id: int, body: ServicePatch, request: Request, ctx: ProjectContext = Depends(coding),
          services: LlmServices = Depends(get_services)) -> dict:
    with errors():
        s = publish.update(ctx.session, services, project_id=ctx.project.id, actor=ctx.user.username,
                           source_ip=client_ip(request), service_id=service_id,
                           changes=body.model_dump(exclude_unset=True))
    return publish.service_out(s)


@router.put(P + "/{service_id}/grants")
def put_grants(service_id: int, body: GrantsIn, request: Request, ctx: ProjectContext = Depends(coding),
               services: LlmServices = Depends(get_services)) -> dict:
    with errors():
        s = publish.update(ctx.session, services, project_id=ctx.project.id, actor=ctx.user.username,
                           source_ip=client_ip(request), service_id=service_id, changes={"grants": body.grants})
    return publish.service_out(s)


@router.delete(P + "/{service_id}", status_code=204)
def delete(service_id: int, request: Request, ctx: ProjectContext = Depends(coding)) -> Response:
    with errors():
        publish.unpublish(ctx.session, project_id=ctx.project.id, actor=ctx.user.username,
                          source_ip=client_ip(request), service_id=service_id)
    return Response(status_code=204)


@router.post("/api/llm-services/{slug}/invoke")
def invoke(slug: str, body: InvokeIn, request: Request, caller: User = Depends(current_user),
           session: Session = Depends(get_session), services: LlmServices = Depends(get_services)) -> dict:
    with errors():
        return publish.invoke(session, services, caller=caller, source_ip=client_ip(request), slug=slug,
                              question=body.question,
                              messages=[t.model_dump() for t in body.messages] if body.messages else None)
