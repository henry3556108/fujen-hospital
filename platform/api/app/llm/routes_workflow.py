from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, ConfigDict, Field

from app.deps import ProjectContext, client_ip
from app.llm import wiki, workflow
from app.llm.http import coding, errors
from app.llm.services import LlmServices, get_services

router = APIRouter(prefix="/api/projects/{project_id}/llm")


class WorkflowIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=128)
    description: str = Field(default="", max_length=512)
    definition: dict


class RunIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    input: dict = Field(default_factory=dict)
    continue_from: int | None = None


class PageIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    path: str = Field(min_length=1, max_length=200)
    title: str = Field(min_length=1, max_length=200)
    content: str = Field(min_length=1, max_length=200_000)
    description: str = Field(default="", max_length=500)
    tags: list[str] = Field(default_factory=list)


class PageUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(min_length=1, max_length=200)
    content: str = Field(min_length=1, max_length=200_000)
    description: str = Field(default="", max_length=500)
    tags: list[str] = Field(default_factory=list)


class AskIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    question: str = Field(min_length=1, max_length=8000)
    page_id: int | None = None
    query: str | None = Field(default=None, max_length=200)
    model: str | None = None


# ---------------------------------------------------------------- 工作流

@router.get("/workflows")
def list_workflows(ctx: ProjectContext = Depends(coding)) -> list[dict]:
    return [workflow.workflow_out(w) for w in workflow.list_workflows(ctx.session, project_id=ctx.project.id)]


@router.post("/workflows", status_code=201)
def create_workflow(body: WorkflowIn, request: Request, ctx: ProjectContext = Depends(coding)) -> dict:
    with errors():
        w = workflow.create_workflow(ctx.session, project_id=ctx.project.id, actor=ctx.user.username,
                                     source_ip=client_ip(request), **body.model_dump())
    return workflow.workflow_out(w)


@router.get("/workflows/{workflow_id}")
def get_workflow(workflow_id: int, ctx: ProjectContext = Depends(coding)) -> dict:
    with errors():
        return workflow.workflow_out(workflow.get_workflow(ctx.session, project_id=ctx.project.id,
                                                           workflow_id=workflow_id))


@router.put("/workflows/{workflow_id}")
def update_workflow(workflow_id: int, body: WorkflowIn, request: Request,
                    ctx: ProjectContext = Depends(coding)) -> dict:
    with errors():
        w = workflow.update_workflow(ctx.session, project_id=ctx.project.id, actor=ctx.user.username,
                                     source_ip=client_ip(request), workflow_id=workflow_id, **body.model_dump())
    return workflow.workflow_out(w)


@router.delete("/workflows/{workflow_id}", status_code=204)
def delete_workflow(workflow_id: int, request: Request, ctx: ProjectContext = Depends(coding)) -> Response:
    with errors():
        workflow.delete_workflow(ctx.session, project_id=ctx.project.id, actor=ctx.user.username,
                                 source_ip=client_ip(request), workflow_id=workflow_id)
    return Response(status_code=204)


@router.post("/workflows/{workflow_id}/runs", status_code=201)
def run_workflow(workflow_id: int, body: RunIn, request: Request, ctx: ProjectContext = Depends(coding),
                 services: LlmServices = Depends(get_services)) -> dict:
    with errors():
        run = workflow.run_workflow(ctx.session, services, project_id=ctx.project.id, actor=ctx.user.username,
                                    source_ip=client_ip(request), workflow_id=workflow_id, **body.model_dump())
    return workflow.run_out(ctx.session, run)


@router.get("/workflows/{workflow_id}/runs")
def list_runs(workflow_id: int, ctx: ProjectContext = Depends(coding)) -> list[dict]:
    with errors():
        workflow.get_workflow(ctx.session, project_id=ctx.project.id, workflow_id=workflow_id)
    return [workflow.run_out(ctx.session, r, detail=False)
            for r in workflow.list_runs(ctx.session, project_id=ctx.project.id, workflow_id=workflow_id)]


@router.get("/workflows/{workflow_id}/runs/{run_id}")
def get_run(workflow_id: int, run_id: int, ctx: ProjectContext = Depends(coding)) -> dict:
    with errors():
        run = workflow.get_run(ctx.session, project_id=ctx.project.id, workflow_id=workflow_id, run_id=run_id)
    return workflow.run_out(ctx.session, run)


# ---------------------------------------------------------------- Wiki

@router.get("/wiki/pages")
def list_pages(ctx: ProjectContext = Depends(coding)) -> list[dict]:
    return [wiki.link_out(link) for link in wiki.list_pages(ctx.session, project_id=ctx.project.id)]


@router.post("/wiki/pages", status_code=201)
def create_page(body: PageIn, request: Request, ctx: ProjectContext = Depends(coding),
                services: LlmServices = Depends(get_services)) -> dict:
    with errors():
        return wiki.create_page(ctx.session, services, project_id=ctx.project.id, actor=ctx.user.username,
                                source_ip=client_ip(request), **body.model_dump())


@router.get("/wiki/search")
def search(q: str = "", ctx: ProjectContext = Depends(coding), services: LlmServices = Depends(get_services)) -> list[dict]:
    with errors():
        return wiki.search(ctx.session, services, project_id=ctx.project.id, query=q)


@router.post("/wiki/ask")
def ask(body: AskIn, request: Request, ctx: ProjectContext = Depends(coding),
        services: LlmServices = Depends(get_services)) -> dict:
    with errors():
        return wiki.ask(ctx.session, services, project_id=ctx.project.id, actor=ctx.user.username,
                        source_ip=client_ip(request), **body.model_dump())


@router.get("/wiki/pages/{page_id}")
def get_page(page_id: int, ctx: ProjectContext = Depends(coding), services: LlmServices = Depends(get_services)) -> dict:
    with errors():
        return wiki.get_page(ctx.session, services, project_id=ctx.project.id, page_id=page_id)


@router.put("/wiki/pages/{page_id}")
def update_page(page_id: int, body: PageUpdate, request: Request, ctx: ProjectContext = Depends(coding),
                services: LlmServices = Depends(get_services)) -> dict:
    with errors():
        return wiki.update_page(ctx.session, services, project_id=ctx.project.id, actor=ctx.user.username,
                                source_ip=client_ip(request), page_id=page_id, **body.model_dump())


@router.delete("/wiki/pages/{page_id}", status_code=204)
def delete_page(page_id: int, request: Request, ctx: ProjectContext = Depends(coding),
                services: LlmServices = Depends(get_services)) -> Response:
    with errors():
        wiki.delete_page(ctx.session, services, project_id=ctx.project.id, actor=ctx.user.username,
                         source_ip=client_ip(request), page_id=page_id)
    return Response(status_code=204)


@router.get("/wiki/pages/{page_id}/history")
def history(page_id: int, ctx: ProjectContext = Depends(coding), services: LlmServices = Depends(get_services)) -> list[dict]:
    with errors():
        return wiki.history(ctx.session, services, project_id=ctx.project.id, page_id=page_id)


@router.get("/wiki/pages/{page_id}/history/{version_id}")
def get_version(page_id: int, version_id: int, ctx: ProjectContext = Depends(coding),
                services: LlmServices = Depends(get_services)) -> dict:
    with errors():
        return wiki.get_version(ctx.session, services, project_id=ctx.project.id, page_id=page_id,
                                version_id=version_id)
