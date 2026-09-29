"""Prompt 範本（個人／公開、tag、搜尋）與每人每專案的生成參數。"""
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit import AuditCategory, record
from app.llm.errors import Forbidden, Invalid, NotFound
from app.llm.models import GenerationSettings, PromptTemplate
from app.llm.params import GenerationParams
from app.models import utcnow

VISIBILITIES = ("personal", "public")


def prompt_out(p: PromptTemplate) -> dict:
    return {"id": p.id, "project_id": p.project_id, "owner": p.owner, "visibility": p.visibility, "title": p.title,
            "content": p.content, "tags": list(p.tags), "created_at": p.created_at.isoformat(),
            "updated_at": p.updated_at.isoformat()}


def clean_tags(tags: list[str]) -> list[str]:
    cleaned: list[str] = []
    for tag in tags:
        tag = tag.strip()
        if not tag:
            continue
        if len(tag) > 32:
            raise Invalid("tag 最長 32 個字")
        if tag.lower() not in (t.lower() for t in cleaned):
            cleaned.append(tag)
    if len(cleaned) > 10:
        raise Invalid("一個 Prompt 最多 10 個 tag")
    return cleaned


def _visible(p: PromptTemplate, username: str) -> bool:
    return p.visibility == "public" or p.owner == username


def create_prompt(session: Session, *, project_id: int, actor: str, source_ip: str | None, title: str, content: str,
                  tags: list[str], visibility: str) -> PromptTemplate:
    if visibility not in VISIBILITIES:
        raise Invalid("visibility 只能是 personal 或 public")
    prompt = PromptTemplate(project_id=project_id, owner=actor, visibility=visibility, title=title.strip(),
                            content=content, tags=clean_tags(tags))
    session.add(prompt)
    session.flush()
    record(session, actor=actor, category=AuditCategory.PROJECT, action="llm.prompt.create",
           target=f"prompt:{prompt.id}", source_ip=source_ip, detail={"visibility": visibility, "title": prompt.title})
    session.commit()
    return prompt


def get_prompt(session: Session, *, project_id: int, username: str, prompt_id: int) -> PromptTemplate:
    prompt = session.get(PromptTemplate, prompt_id)
    # 別人的個人範本與不存在的範本回一樣的訊息，不透露是否存在
    if prompt is None or prompt.project_id != project_id or not _visible(prompt, username):
        raise NotFound(f"找不到 Prompt 範本 {prompt_id}")
    return prompt


def search_prompts(session: Session, *, project_id: int, username: str, q: str = "", tags: list[str] | None = None,
                   visibility: str | None = None) -> list[PromptTemplate]:
    rows = session.scalars(select(PromptTemplate).where(PromptTemplate.project_id == project_id)
                           .order_by(PromptTemplate.id))
    needle = q.strip().lower()
    wanted = [t.strip().lower() for t in (tags or []) if t.strip()]
    found = []
    for p in rows:
        if not _visible(p, username) or (visibility and p.visibility != visibility):
            continue
        own_tags = [t.lower() for t in p.tags]
        if any(t not in own_tags for t in wanted):
            continue
        if needle and needle not in p.title.lower() and needle not in p.content.lower() \
                and not any(needle in t for t in own_tags):
            continue
        found.append(p)
    return found


def _owned(session: Session, *, project_id: int, username: str, is_admin: bool, prompt_id: int) -> PromptTemplate:
    prompt = get_prompt(session, project_id=project_id, username=username, prompt_id=prompt_id)
    if prompt.owner != username and not is_admin:
        raise Forbidden("只有建立者可以修改或刪除這個 Prompt 範本")
    return prompt


def update_prompt(session: Session, *, project_id: int, actor: str, is_admin: bool, source_ip: str | None,
                  prompt_id: int, changes: dict) -> PromptTemplate:
    prompt = _owned(session, project_id=project_id, username=actor, is_admin=is_admin, prompt_id=prompt_id)
    if "visibility" in changes and changes["visibility"] not in VISIBILITIES:
        raise Invalid("visibility 只能是 personal 或 public")
    if "tags" in changes:
        changes["tags"] = clean_tags(changes["tags"])
    if "title" in changes:
        changes["title"] = changes["title"].strip()
    for key, value in changes.items():
        setattr(prompt, key, value)
    prompt.updated_at = utcnow()
    record(session, actor=actor, category=AuditCategory.PROJECT, action="llm.prompt.update",
           target=f"prompt:{prompt.id}", source_ip=source_ip, detail={"fields": sorted(changes)})
    session.commit()
    return prompt


def delete_prompt(session: Session, *, project_id: int, actor: str, is_admin: bool, source_ip: str | None,
                  prompt_id: int) -> None:
    prompt = _owned(session, project_id=project_id, username=actor, is_admin=is_admin, prompt_id=prompt_id)
    session.delete(prompt)
    record(session, actor=actor, category=AuditCategory.PROJECT, action="llm.prompt.delete",
           target=f"prompt:{prompt_id}", source_ip=source_ip)
    session.commit()


# ---------------------------------------------------------------- 生成參數

def get_generation_params(session: Session, *, project_id: int, username: str) -> GenerationParams:
    row = session.scalar(select(GenerationSettings).where(GenerationSettings.project_id == project_id,
                                                          GenerationSettings.username == username))
    return GenerationParams(**row.params) if row else GenerationParams()


def put_generation_params(session: Session, *, project_id: int, actor: str, source_ip: str | None,
                          params: GenerationParams) -> GenerationParams:
    row = session.scalar(select(GenerationSettings).where(GenerationSettings.project_id == project_id,
                                                          GenerationSettings.username == actor))
    if row is None:
        row = GenerationSettings(project_id=project_id, username=actor, params={})
        session.add(row)
    row.params, row.updated_at = params.model_dump(), utcnow()
    record(session, actor=actor, category=AuditCategory.PROJECT, action="llm.generation_params.update",
           target=f"project:{project_id}", source_ip=source_ip,
           detail={k: v for k, v in params.model_dump().items() if k != "system_prompt"})
    session.commit()
    return params
