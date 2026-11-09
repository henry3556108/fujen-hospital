"""Playground：Free Chat 與 Chat with Knowledge Base。"""
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit import AuditCategory, record
from app.llm import knowledge, prompts
from app.llm.calls import allowed_models, call_llm
from app.llm.client import LlmError
from app.llm.errors import Invalid, NotFound
from app.llm.models import ChatMessage, ChatSession
from app.llm.params import GenerationParams, to_openai
from app.llm.services import LlmServices
from app.llm.util import iso

MODES = ("free", "kb")
HISTORY_MESSAGES = 20
# 舊文字「請只根據以下資料回答；資料中沒有的內容請回答『資料中沒有提到』」讓 gemma-3-4b 常在答對後又補一句
# 「資料中沒有提到」，或資料寫了也拒答。11/8 以 12 題可回答＋3 題不可回答、各 5 次比較：單輪答對 55/60 → 60/60，
# 多輪 49/60 → 51/60，不可回答的題目兩者都 30/30 誠實回答沒有提到（紀錄：八-6八-8測試紀錄/RAG指示文字比較.json）。
GROUNDING = ("請根據以下資料回答使用者的問題。資料能直接回答或可以合理推論出答案時，請直接回答並簡短說明依據；"
             "資料完全沒有相關內容時，才回答「資料中沒有提到」，不要自行補充資料以外的內容。")


def context_block(sources: list[dict]) -> str:
    lines = [f"[{i}]（{s.get('filename') or s.get('title') or s.get('path', '')}）{s['content']}"
             for i, s in enumerate(sources, start=1)]
    return "Context:\n" + "\n".join(lines)


def build_messages(*, system_prompt: str, sources: list[dict] | None, history: list[dict], user_message: str) -> list[dict]:
    system = [system_prompt.strip()] if system_prompt.strip() else []
    if sources is not None:
        system += [GROUNDING, context_block(sources)]
    messages = [{"role": "system", "content": "\n\n".join(system)}] if system else []
    return [*messages, *history, {"role": "user", "content": user_message}]


def apply_prompt(template: str, message: str) -> str:
    return template.replace("{input}", message) if "{input}" in template else f"{template}\n\n{message}"


def choose_model(session: Session, services: LlmServices, model: str | None) -> str:
    models = allowed_models(session, services)
    if not model:
        return models[0]
    if model not in models:
        raise Invalid(f"模型 {model} 尚未載入（可用：{'、'.join(models)}）")
    return model


def session_out(s: ChatSession) -> dict:
    return {"id": s.id, "project_id": s.project_id, "user": s.username, "mode": s.mode, "kb_id": s.kb_id,
            "model": s.model, "title": s.title, "created_at": iso(s.created_at)}


def message_out(m: ChatMessage) -> dict:
    return {"id": m.id, "role": m.role, "content": m.content, "sources": m.sources, "call_id": m.call_id,
            "created_at": iso(m.created_at)}


def get_session(session: Session, *, project_id: int, username: str, session_id: int) -> ChatSession:
    chat = session.get(ChatSession, session_id)
    if chat is None or chat.project_id != project_id or chat.username != username:
        raise NotFound(f"找不到對話 {session_id}")
    return chat


def messages_of(session: Session, session_id: int) -> list[ChatMessage]:
    return list(session.scalars(select(ChatMessage).where(ChatMessage.session_id == session_id)
                                .order_by(ChatMessage.id)))


def list_sessions(session: Session, *, project_id: int, username: str) -> list[ChatSession]:
    return list(session.scalars(select(ChatSession).where(
        ChatSession.project_id == project_id, ChatSession.username == username).order_by(ChatSession.id.desc())))


def source_refs(sources: list[dict]) -> list[dict]:
    return [{k: s[k] for k in ("document_id", "filename", "chunk_index", "score") if k in s} for s in sources]


def chat(session: Session, services: LlmServices, *, project_id: int, actor: str, source_ip: str | None,
         mode: str, message: str, kb_id: int | None = None, session_id: int | None = None,
         prompt_id: int | None = None, model: str | None = None, top_k: int = 3) -> dict:
    if mode not in MODES:
        raise Invalid("mode 只能是 free 或 kb")
    if mode == "kb" and kb_id is None:
        raise Invalid("Chat with Knowledge Base 需要指定知識庫")
    if mode == "free" and kb_id is not None:
        raise Invalid("Free Chat 不使用知識庫")

    if session_id is not None:
        conversation = get_session(session, project_id=project_id, username=actor, session_id=session_id)
        if (conversation.mode, conversation.kb_id) != (mode, kb_id):
            raise Invalid("同一段對話不能切換模式或知識庫，請開新對話")
        model = conversation.model
        history = [{"role": m.role, "content": m.content} for m in messages_of(session, conversation.id)]
    else:
        conversation, history = None, []
        model = choose_model(session, services, model)
    kb = knowledge.get_kb(session, project_id=project_id, kb_id=kb_id) if mode == "kb" else None

    text = message
    if prompt_id is not None:
        template = prompts.get_prompt(session, project_id=project_id, username=actor, prompt_id=prompt_id)
        text = apply_prompt(template.content, message)
    params = prompts.get_generation_params(session, project_id=project_id, username=actor)

    target = f"chat:{conversation.id}" if conversation else "chat:new"
    try:
        sources = knowledge.search(session, services, kb=kb, query=message, k=top_k) if kb else None
        call, result = call_llm(
            session, services, project_id=project_id, username=actor, origin="playground", origin_ref=target,
            model=model, params=to_openai(params), context_source="vector" if kb else "none",
            context_refs=source_refs(sources or []), prompt_id=prompt_id,
            messages=build_messages(system_prompt=params.system_prompt, sources=sources,
                                    history=history[-HISTORY_MESSAGES:], user_message=text))
    except LlmError as exc:
        # 失敗不留下半段對話；只留稽核與呼叫紀錄
        session.rollback()
        record(session, actor=actor, category=AuditCategory.INFERENCE, action="llm.chat", target=target,
               result="failed", source_ip=source_ip, detail={"mode": mode, "model": model, "reason": exc.code})
        session.commit()
        raise

    if conversation is None:
        conversation = ChatSession(project_id=project_id, username=actor, mode=mode, kb_id=kb_id, model=model,
                                   title=message.strip()[:60])
        session.add(conversation)
        session.flush()
        call.origin_ref = f"chat:{conversation.id}"
    session.add(ChatMessage(session_id=conversation.id, role="user", content=text))
    reply = ChatMessage(session_id=conversation.id, role="assistant", content=result.content, call_id=call.id,
                        sources=sources or [])
    session.add(reply)
    session.flush()
    record(session, actor=actor, category=AuditCategory.INFERENCE, action="llm.chat",
           target=f"chat:{conversation.id}", source_ip=source_ip,
           detail={"mode": mode, "model": model, "kb_id": kb_id, "prompt_id": prompt_id, "call_id": call.id})
    session.commit()
    return {"session_id": conversation.id, "mode": mode, "model": model, "message": message_out(reply),
            "call_id": call.id, "usage": result.usage, "latency_ms": call.latency_ms}


def params_for(params: GenerationParams) -> dict:
    return to_openai(params)
