from fastapi import APIRouter, Depends, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field

from app.deps import ProjectContext, client_ip
from app.llm import prompts
from app.llm.http import coding, errors, is_admin
from app.llm.params import GenerationParams

router = APIRouter(prefix="/api/projects/{project_id}/llm")


class PromptIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(min_length=1, max_length=128)
    content: str = Field(min_length=1, max_length=20000)
    tags: list[str] = Field(default_factory=list)
    visibility: str = "personal"


class PromptPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(default=None, min_length=1, max_length=128)
    content: str = Field(default=None, min_length=1, max_length=20000)
    tags: list[str] = Field(default=None)
    visibility: str = Field(default=None)


@router.post("/prompts", status_code=201)
def create(body: PromptIn, request: Request, ctx: ProjectContext = Depends(coding)) -> dict:
    with errors():
        p = prompts.create_prompt(ctx.session, project_id=ctx.project.id, actor=ctx.user.username,
                                  source_ip=client_ip(request), **body.model_dump())
    return prompts.prompt_out(p)


@router.get("/prompts")
def search(q: str = "", tag: list[str] = Query(default_factory=list), visibility: str | None = None,
           ctx: ProjectContext = Depends(coding)) -> list[dict]:
    return [prompts.prompt_out(p) for p in prompts.search_prompts(
        ctx.session, project_id=ctx.project.id, username=ctx.user.username, q=q, tags=tag, visibility=visibility)]


@router.get("/prompts/{prompt_id}")
def get(prompt_id: int, ctx: ProjectContext = Depends(coding)) -> dict:
    with errors():
        return prompts.prompt_out(prompts.get_prompt(ctx.session, project_id=ctx.project.id,
                                                     username=ctx.user.username, prompt_id=prompt_id))


@router.patch("/prompts/{prompt_id}")
def update(prompt_id: int, body: PromptPatch, request: Request, ctx: ProjectContext = Depends(coding)) -> dict:
    with errors():
        p = prompts.update_prompt(ctx.session, project_id=ctx.project.id, actor=ctx.user.username,
                                  is_admin=is_admin(ctx.user), source_ip=client_ip(request), prompt_id=prompt_id,
                                  changes=body.model_dump(exclude_unset=True))
    return prompts.prompt_out(p)


@router.delete("/prompts/{prompt_id}", status_code=204)
def delete(prompt_id: int, request: Request, ctx: ProjectContext = Depends(coding)) -> Response:
    with errors():
        prompts.delete_prompt(ctx.session, project_id=ctx.project.id, actor=ctx.user.username,
                              is_admin=is_admin(ctx.user), source_ip=client_ip(request), prompt_id=prompt_id)
    return Response(status_code=204)


@router.get("/generation-params")
def get_params(ctx: ProjectContext = Depends(coding)) -> dict:
    return prompts.get_generation_params(ctx.session, project_id=ctx.project.id,
                                         username=ctx.user.username).model_dump()


@router.put("/generation-params")
def put_params(body: GenerationParams, request: Request, ctx: ProjectContext = Depends(coding)) -> dict:
    return prompts.put_generation_params(ctx.session, project_id=ctx.project.id, actor=ctx.user.username,
                                         source_ip=client_ip(request), params=body).model_dump()
