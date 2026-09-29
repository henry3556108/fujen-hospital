from fastapi import APIRouter, Depends, File, Request, Response, UploadFile

from app import scanning
from pydantic import BaseModel, ConfigDict, Field

from app.deps import ProjectContext, client_ip
from app.llm import calls, chat, knowledge
from app.llm.documents import MAX_DOCUMENT_BYTES
from app.llm.http import coding, errors
from app.llm.services import LlmServices, get_services

router = APIRouter(prefix="/api/projects/{project_id}/llm")


class KbIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=128)
    description: str = Field(default="", max_length=512)
    chunk_size: int = Field(default=500, ge=100, le=4000)
    chunk_overlap: int = Field(default=50, ge=0, le=1000)


class SearchIn(BaseModel):
    query: str = Field(min_length=1, max_length=2000)
    k: int = Field(default=3, ge=1, le=20)


class ChatIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mode: str = "free"
    message: str = Field(min_length=1, max_length=8000)
    kb_id: int | None = None
    session_id: int | None = None
    prompt_id: int | None = None
    model: str | None = None
    top_k: int = Field(default=3, ge=1, le=20)


@router.get("/knowledge-bases")
def list_kbs(ctx: ProjectContext = Depends(coding)) -> list[dict]:
    return knowledge.list_kbs(ctx.session, project_id=ctx.project.id)


@router.post("/knowledge-bases", status_code=201)
def create_kb(body: KbIn, request: Request, ctx: ProjectContext = Depends(coding),
              services: LlmServices = Depends(get_services)) -> dict:
    with errors():
        kb = knowledge.create_kb(ctx.session, services, project_id=ctx.project.id, actor=ctx.user.username,
                                 source_ip=client_ip(request), **body.model_dump())
    return knowledge.kb_out(kb)


@router.get("/knowledge-bases/{kb_id}")
def get_kb(kb_id: int, ctx: ProjectContext = Depends(coding)) -> dict:
    with errors():
        return knowledge.describe(ctx.session, knowledge.get_kb(ctx.session, project_id=ctx.project.id, kb_id=kb_id))


@router.delete("/knowledge-bases/{kb_id}", status_code=204)
def delete_kb(kb_id: int, request: Request, ctx: ProjectContext = Depends(coding),
              services: LlmServices = Depends(get_services)) -> Response:
    with errors():
        knowledge.delete_kb(ctx.session, services, project_id=ctx.project.id, actor=ctx.user.username,
                            source_ip=client_ip(request), kb_id=kb_id)
    return Response(status_code=204)


@router.get("/knowledge-bases/{kb_id}/documents")
def list_documents(kb_id: int, ctx: ProjectContext = Depends(coding)) -> list[dict]:
    with errors():
        kb = knowledge.get_kb(ctx.session, project_id=ctx.project.id, kb_id=kb_id)
    return [knowledge.document_out(d) for d in knowledge.documents_of(ctx.session, kb.id)]


@router.post("/knowledge-bases/{kb_id}/documents", status_code=201)
def add_documents(kb_id: int, request: Request, files: list[UploadFile] = File(...),
                  ctx: ProjectContext = Depends(coding), services: LlmServices = Depends(get_services)) -> dict:
    with errors():
        kb = knowledge.get_kb(ctx.session, project_id=ctx.project.id, kb_id=kb_id)
        # 多讀 1 個位元組，讓過大的檔案在解析時被擋下而不是整個讀進記憶體
        payload = [(f.filename or "", f.file.read(MAX_DOCUMENT_BYTES + 1)) for f in files]
        return knowledge.add_documents(ctx.session, services, kb=kb, actor=ctx.user.username,
                                       source_ip=client_ip(request), files=payload,
                                       blocked=lambda name, data: scanning.blocked_reason(request, name, data))


@router.delete("/knowledge-bases/{kb_id}/documents/{document_id}", status_code=204)
def delete_document(kb_id: int, document_id: int, request: Request, ctx: ProjectContext = Depends(coding),
                    services: LlmServices = Depends(get_services)) -> Response:
    with errors():
        kb = knowledge.get_kb(ctx.session, project_id=ctx.project.id, kb_id=kb_id)
        knowledge.delete_document(ctx.session, services, kb=kb, actor=ctx.user.username,
                                  source_ip=client_ip(request), document_id=document_id)
    return Response(status_code=204)


@router.post("/knowledge-bases/{kb_id}/search")
def search(kb_id: int, body: SearchIn, ctx: ProjectContext = Depends(coding),
           services: LlmServices = Depends(get_services)) -> list[dict]:
    with errors():
        kb = knowledge.get_kb(ctx.session, project_id=ctx.project.id, kb_id=kb_id)
        return knowledge.search(ctx.session, services, kb=kb, query=body.query, k=body.k)


# ---------------------------------------------------------------- Playground

@router.get("/models/available")
def available_models(ctx: ProjectContext = Depends(coding), services: LlmServices = Depends(get_services)) -> dict:
    models = calls.allowed_models(ctx.session, services)
    return {"default": models[0], "models": models, "configured": services.client is not None}


@router.post("/chat")
def post_chat(body: ChatIn, request: Request, ctx: ProjectContext = Depends(coding),
              services: LlmServices = Depends(get_services)) -> dict:
    with errors():
        return chat.chat(ctx.session, services, project_id=ctx.project.id, actor=ctx.user.username,
                         source_ip=client_ip(request), **body.model_dump())


@router.get("/chat/sessions")
def chat_sessions(ctx: ProjectContext = Depends(coding)) -> list[dict]:
    return [chat.session_out(s) for s in chat.list_sessions(ctx.session, project_id=ctx.project.id,
                                                            username=ctx.user.username)]


@router.get("/chat/sessions/{session_id}")
def chat_session(session_id: int, ctx: ProjectContext = Depends(coding)) -> dict:
    with errors():
        s = chat.get_session(ctx.session, project_id=ctx.project.id, username=ctx.user.username,
                             session_id=session_id)
    return {**chat.session_out(s), "messages": [chat.message_out(m) for m in chat.messages_of(ctx.session, s.id)]}


@router.get("/calls")
def list_calls(origin: str | None = None, ctx: ProjectContext = Depends(coding)) -> list[dict]:
    return [calls.call_out(c) for c in calls.list_calls(ctx.session, project_id=ctx.project.id, origin=origin)]


@router.get("/calls/{call_id}")
def get_call(call_id: int, ctx: ProjectContext = Depends(coding)) -> dict:
    with errors():
        return calls.call_out(calls.get_call(ctx.session, project_id=ctx.project.id, call_id=call_id), full=True)
