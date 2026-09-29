"""把對話設定（模型、生成參數、知識庫）發布成內部服務的 RESTful API，只有授權名單內的帳號可呼叫。"""
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit import AuditCategory, record
from app.llm import knowledge, prompts
from app.llm.calls import call_llm
from app.llm.chat import build_messages, choose_model, source_refs
from app.llm.client import LlmError
from app.llm.errors import Conflict, Forbidden, Invalid, NotFound
from app.llm.models import PublishedService
from app.llm.params import GenerationParams, to_openai
from app.llm.services import LlmServices
from app.models import User
from app.permissions import AccountType

MAX_TURNS = 40


def service_out(s: PublishedService) -> dict:
    return {"id": s.id, "project_id": s.project_id, "slug": s.slug, "name": s.name, "description": s.description,
            "model": s.model, "kb_id": s.kb_id, "top_k": s.top_k, "params": s.params, "enabled": s.enabled,
            "grants": list(s.grants), "endpoint": f"/api/llm-services/{s.slug}/invoke",
            "published_by": s.published_by, "published_at": s.published_at.isoformat()}


def _check_grants(session: Session, grants: list[str]) -> list[str]:
    wanted = sorted({g.strip() for g in grants if g.strip()})
    known = set(session.scalars(select(User.username).where(User.username.in_(wanted)))) if wanted else set()
    missing = [g for g in wanted if g not in known]
    if missing:
        raise Invalid(f"帳號不存在：{'、'.join(missing)}")
    return wanted


def get_service(session: Session, *, project_id: int, service_id: int) -> PublishedService:
    service = session.get(PublishedService, service_id)
    if service is None or service.project_id != project_id:
        raise NotFound(f"找不到已發布的服務 {service_id}")
    return service


def list_services(session: Session, *, project_id: int) -> list[PublishedService]:
    return list(session.scalars(select(PublishedService).where(PublishedService.project_id == project_id)
                                .order_by(PublishedService.id)))


def publish(session: Session, services: LlmServices, *, project_id: int, actor: str, source_ip: str | None,
            slug: str, name: str, description: str = "", model: str | None = None, kb_id: int | None = None,
            top_k: int = 3, params: GenerationParams | None = None, grants: list[str] | None = None) -> PublishedService:
    if session.scalar(select(PublishedService).where(PublishedService.slug == slug)):
        raise Conflict(f"服務代號 {slug} 已被使用")
    if kb_id is not None:
        knowledge.get_kb(session, project_id=project_id, kb_id=kb_id)
    params = params or prompts.get_generation_params(session, project_id=project_id, username=actor)
    service = PublishedService(project_id=project_id, slug=slug, name=name.strip(), description=description,
                               model=choose_model(session, services, model), kb_id=kb_id, top_k=top_k,
                               params=params.model_dump(), grants=_check_grants(session, grants or []),
                               published_by=actor)
    session.add(service)
    session.flush()
    record(session, actor=actor, category=AuditCategory.INFERENCE, action="llm.service.publish",
           target=f"llm-service:{slug}", source_ip=source_ip,
           detail={"service_id": service.id, "model": service.model, "kb_id": kb_id, "grants": service.grants})
    session.commit()
    return service


def update(session: Session, services: LlmServices, *, project_id: int, actor: str, source_ip: str | None,
           service_id: int, changes: dict) -> PublishedService:
    service = get_service(session, project_id=project_id, service_id=service_id)
    if "kb_id" in changes and changes["kb_id"] is not None:
        knowledge.get_kb(session, project_id=project_id, kb_id=changes["kb_id"])
    if "model" in changes:
        changes["model"] = choose_model(session, services, changes["model"])
    if "params" in changes:
        changes["params"] = GenerationParams(**changes["params"]).model_dump()
    if "grants" in changes:
        changes["grants"] = _check_grants(session, changes["grants"])
    for key, value in changes.items():
        setattr(service, key, value)
    record(session, actor=actor, category=AuditCategory.INFERENCE, action="llm.service.update",
           target=f"llm-service:{service.slug}", source_ip=source_ip,
           detail={"fields": sorted(changes), **({"grants": service.grants} if "grants" in changes else {})})
    session.commit()
    return service


def unpublish(session: Session, *, project_id: int, actor: str, source_ip: str | None, service_id: int) -> None:
    service = get_service(session, project_id=project_id, service_id=service_id)
    session.delete(service)
    record(session, actor=actor, category=AuditCategory.INFERENCE, action="llm.service.unpublish",
           target=f"llm-service:{service.slug}", source_ip=source_ip)
    session.commit()


def invoke(session: Session, services: LlmServices, *, caller: User, source_ip: str | None, slug: str,
           question: str | None = None, messages: list[dict] | None = None) -> dict:
    service = session.scalar(select(PublishedService).where(PublishedService.slug == slug))
    target = f"llm-service:{slug}"[:128]
    if caller.account_type != AccountType.ADMIN and (service is None or caller.username not in service.grants):
        # 未授權與不存在回一樣的訊息，不透露有哪些服務
        record(session, actor=caller.username, category=AuditCategory.INFERENCE, action="llm.service.invoke",
               target=target, result="denied", source_ip=source_ip, detail={"reason": "not_granted"})
        session.commit()
        raise Forbidden("你沒有呼叫這個服務的授權", code="not_granted")
    if service is None:
        raise NotFound(f"找不到服務 {slug}")
    if not service.enabled:
        raise Conflict("這個服務已停用")

    if messages:
        if len(messages) > MAX_TURNS or messages[-1]["role"] != "user":
            raise Invalid(f"messages 最多 {MAX_TURNS} 則，且最後一則必須是 user")
        history, question = messages[:-1], messages[-1]["content"]
    elif question:
        history = []
    else:
        raise Invalid("請提供 question 或 messages")

    params = GenerationParams(**service.params)
    try:
        sources = None
        if service.kb_id is not None:
            kb = knowledge.get_kb(session, project_id=service.project_id, kb_id=service.kb_id)
            sources = knowledge.search(session, services, kb=kb, query=question, k=service.top_k)
        call, result = call_llm(
            session, services, project_id=service.project_id, username=caller.username, origin="service",
            origin_ref=slug, model=service.model, params=to_openai(params),
            context_source="vector" if sources is not None else "none", context_refs=source_refs(sources or []),
            messages=build_messages(system_prompt=params.system_prompt, sources=sources, history=history,
                                    user_message=question))
    except LlmError as exc:
        session.rollback()
        record(session, actor=caller.username, category=AuditCategory.INFERENCE, action="llm.service.invoke",
               target=target, result="failed", source_ip=source_ip, detail={"reason": exc.code})
        session.commit()
        raise
    record(session, actor=caller.username, category=AuditCategory.INFERENCE, action="llm.service.invoke",
           target=target, source_ip=source_ip, detail={"call_id": call.id, "model": service.model})
    session.commit()
    return {"service": slug, "model": service.model, "answer": result.content,
            "sources": source_refs(sources or []), "usage": result.usage, "call_id": call.id}
