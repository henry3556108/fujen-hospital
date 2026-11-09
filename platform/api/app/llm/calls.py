"""每一次送給模型服務的呼叫都經過這裡：送出、計時、寫 LlmCallRecord。失敗也會留紀錄。"""
import time

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.llm.client import ChatResult, LlmError, LlmTimeout, LlmUnavailable
from app.llm.errors import NotFound, Unavailable
from app.llm.models import LlmCallRecord
from app.llm.client import LlmError, OllamaClient
from app.llm.services import LlmServices
from app.llm.util import iso

CONTEXT_SOURCES = ("none", "vector", "wiki_api")


def require_client(services: LlmServices):
    if services.client is None:
        raise Unavailable("模型服務尚未設定（LLM_BASE_URL）")
    return services.client


def allowed_models(session: Session, services: LlmServices) -> list[str]:
    """可用來對話的模型：部署設定的預設模型，加上已載入的白名單模型。"""
    from app.llm.models import InstalledModel
    loaded = session.scalars(select(InstalledModel.name).where(InstalledModel.loaded.is_(True)))
    skip = {services.settings.chat_model, services.settings.embed_model}   # 嵌入模型不能對話
    extra = sorted(n for n in loaded if n not in skip)
    if isinstance(services.client, OllamaClient) and extra:
        try:   # 資料表標示已載入、模型服務裡卻沒有的不列出，否則選了只會得到 503
            runnable = set(services.client.models())
        except LlmError:
            return [services.settings.chat_model, *extra]
        extra = [n for n in extra if n in runnable]
    return [services.settings.chat_model, *extra]


def call_llm(session: Session, services: LlmServices, *, project_id: int, username: str, origin: str,
             origin_ref: str = "", model: str, messages: list[dict], params: dict | None = None,
             context_source: str = "none", context_refs: list | None = None,
             prompt_id: int | None = None) -> tuple[LlmCallRecord, ChatResult]:
    """失敗時先把紀錄 commit 再把錯誤往上丟，呼叫端不需要自己補寫。"""
    assert context_source in CONTEXT_SOURCES
    client = require_client(services)
    request = {"model": model, "messages": messages, **(params or {})}
    record = LlmCallRecord(project_id=project_id, username=username, origin=origin, origin_ref=origin_ref,
                           model=model, context_source=context_source, context_refs=context_refs or [],
                           prompt_id=prompt_id,
                           request=request, status="success")
    started = time.monotonic()
    try:
        result = client.chat(model=model, messages=messages, params=params)
    except LlmError as exc:
        record.latency_ms = round((time.monotonic() - started) * 1000, 1)
        record.status = ("timeout" if isinstance(exc, LlmTimeout)
                         else "unavailable" if isinstance(exc, LlmUnavailable) else "error")
        record.error = str(exc)[:512]
        session.add(record)
        session.commit()
        raise
    record.latency_ms = round((time.monotonic() - started) * 1000, 1)
    record.request, record.response = result.request, result.response
    session.add(record)
    session.flush()
    return record, result


def call_out(c: LlmCallRecord, *, full: bool = False) -> dict:
    out = {"id": c.id, "project_id": c.project_id, "user": c.username, "origin": c.origin,
           "origin_ref": c.origin_ref, "model": c.model, "context_source": c.context_source,
           "context_refs": c.context_refs, "prompt_id": c.prompt_id, "status": c.status, "error": c.error,
           "latency_ms": c.latency_ms,
           "created_at": iso(c.created_at)}
    if full:
        out.update(request=c.request, response=c.response)
    return out


def list_calls(session: Session, *, project_id: int, origin: str | None = None, limit: int = 100) -> list[LlmCallRecord]:
    query = select(LlmCallRecord).where(LlmCallRecord.project_id == project_id)
    if origin:
        query = query.where(LlmCallRecord.origin == origin)
    return list(session.scalars(query.order_by(LlmCallRecord.id.desc()).limit(limit)))


def get_call(session: Session, *, project_id: int, call_id: int) -> LlmCallRecord:
    call = session.get(LlmCallRecord, call_id)
    if call is None or call.project_id != project_id:
        raise NotFound(f"找不到呼叫紀錄 {call_id}")
    return call
