"""Wiki 知識庫：文件編輯、版本管理、全文檢索由 Wiki.js 提供，平台經它的 GraphQL API 操作。

平台負責：專案歸屬（每頁屬於一個專案，路徑加上 projects/<id>/ 前綴）、權限、稽核，以及「Wiki 與 LLM 串接」——
以 Wiki API 取回文件內容後交給模型，呼叫紀錄的 context_source 是 wiki_api，過程不經過向量庫。
"""
import os
import re
import threading
from collections.abc import Mapping
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from typing import Protocol

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit import AuditCategory, record
from app.llm import prompts
from app.llm.calls import call_llm
from app.llm.chat import GROUNDING, choose_model
from app.llm.client import LlmError
from app.llm.errors import Conflict, Invalid, LlmServiceError, NotFound, Unavailable
from app.llm.models import WikiPageLink
from app.llm.params import to_openai
from app.llm.services import LlmServices
from app.models import utcnow
from app.llm.util import iso

_PATH = re.compile(r"^[a-z0-9][a-z0-9_-]*(/[a-z0-9][a-z0-9_-]*)*$")
MAX_ASK_PAGES = 3
MAX_CONTEXT_CHARS = 12000


class WikiNotFound(LlmServiceError):
    status_code = 404


class WikiUnavailable(LlmServiceError):
    status_code = 503

    def __init__(self, message: str = "Wiki 服務中斷，請稍後重試"):
        super().__init__(message, code="wiki_unavailable")


class WikiRejected(LlmServiceError):
    status_code = 409


@dataclass(frozen=True)
class WikiPage:
    id: int
    path: str
    title: str
    content: str
    description: str = ""
    tags: tuple[str, ...] = ()
    updated_at: str = ""


@dataclass(frozen=True)
class WikiVersion:
    version_id: int
    date: str
    author: str
    action: str


@dataclass(frozen=True)
class WikiHit:
    id: int
    path: str
    title: str
    description: str = ""


class WikiClient(Protocol):
    def create_page(self, *, path: str, title: str, content: str, description: str = "",
                    tags: list[str] | None = None) -> WikiPage: ...
    def update_page(self, page_id: int, *, title: str, content: str, description: str = "",
                    tags: list[str] | None = None) -> WikiPage: ...
    def get_page(self, page_id: int) -> WikiPage: ...
    def delete_page(self, page_id: int) -> None: ...
    def history(self, page_id: int) -> list[WikiVersion]: ...
    def get_version(self, page_id: int, version_id: int) -> WikiPage: ...
    def search(self, query: str) -> list[WikiHit]: ...


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class InMemoryWiki:
    """單元測試用。行為比照 Wiki.js：每次更新把「更新前」的內容存成一個版本。"""
    pages: dict[int, WikiPage] = field(default_factory=dict)
    versions: dict[int, list[tuple[WikiVersion, WikiPage]]] = field(default_factory=dict)
    calls: list[str] = field(default_factory=list)      # 呼叫過的 API 名稱，用來驗證「走的是 Wiki API」
    down: bool = False
    _next: int = 1
    _next_version: int = 1

    def _op(self, name: str) -> None:
        if self.down:
            raise WikiUnavailable()
        self.calls.append(name)

    def _page(self, page_id: int) -> WikiPage:
        if page_id not in self.pages:
            raise WikiNotFound(f"Wiki 沒有頁面 {page_id}")
        return self.pages[page_id]

    def _snapshot(self, page: WikiPage, action: str) -> None:
        version = WikiVersion(version_id=self._next_version, date=page.updated_at, author="platform", action=action)
        self._next_version += 1
        self.versions.setdefault(page.id, []).append((version, page))

    def create_page(self, *, path, title, content, description="", tags=None) -> WikiPage:
        self._op("pages.create")
        if any(p.path == path for p in self.pages.values()):
            raise WikiRejected(f"Wiki 已有路徑 {path}")
        page = WikiPage(id=self._next, path=path, title=title, content=content, description=description,
                        tags=tuple(tags or ()), updated_at=_now())
        self._next += 1
        self.pages[page.id] = page
        return page

    def update_page(self, page_id, *, title, content, description="", tags=None) -> WikiPage:
        self._op("pages.update")
        old = self._page(page_id)
        self._snapshot(old, "updated" if self.versions.get(page_id) else "initial")
        page = replace(old, title=title, content=content, description=description, tags=tuple(tags or ()),
                       updated_at=_now())
        self.pages[page_id] = page
        return page

    def get_page(self, page_id) -> WikiPage:
        self._op("pages.single")
        return self._page(page_id)

    def delete_page(self, page_id) -> None:
        self._op("pages.delete")
        self._page(page_id)
        del self.pages[page_id]
        self.versions.pop(page_id, None)

    def history(self, page_id) -> list[WikiVersion]:
        self._op("pages.history")
        self._page(page_id)
        return [v for v, _ in self.versions.get(page_id, [])]

    def get_version(self, page_id, version_id) -> WikiPage:
        self._op("pages.version")
        for version, page in self.versions.get(page_id, []):
            if version.version_id == version_id:
                return page
        raise WikiNotFound(f"頁面 {page_id} 沒有版本 {version_id}")

    def search(self, query) -> list[WikiHit]:
        self._op("pages.search")
        needle = query.strip().lower()
        return [WikiHit(id=p.id, path=p.path, title=p.title, description=p.description)
                for p in self.pages.values()
                if needle and any(needle in text.lower() for text in (p.title, p.description, p.content))]


class WikiJsClient:
    """Wiki.js 2 的 GraphQL API。以服務帳號登入取得 JWT，過期（或被拒）時重新登入一次。"""

    def __init__(self, base_url: str, *, email: str, password: str, locale: str = "en", timeout: float = 15.0,
                 http: httpx.Client | None = None):
        self.base_url = base_url.rstrip("/")
        self.email, self.password, self.locale, self.timeout = email, password, locale, timeout
        self._http = http or httpx.Client()
        self._jwt: str | None = None
        self._lock = threading.Lock()

    def _post(self, query: str, variables: dict, *, token: str | None) -> dict:
        try:
            response = self._http.post(f"{self.base_url}/graphql", json={"query": query, "variables": variables},
                                       headers={"Authorization": f"Bearer {token}"} if token else {},
                                       timeout=self.timeout)
        except httpx.HTTPError:
            raise WikiUnavailable()
        if response.status_code >= 500:
            raise WikiUnavailable()
        try:
            return response.json()
        except ValueError:
            raise WikiUnavailable("Wiki 回傳的內容不是 JSON（可能尚未完成首次設定）")

    def _login(self) -> str:
        body = self._post(
            "mutation($u: String!, $p: String!) { authentication { login(username: $u, password: $p, "
            "strategy: \"local\") { responseResult { succeeded message } jwt } } }",
            {"u": self.email, "p": self.password}, token=None)
        try:
            result = body["data"]["authentication"]["login"]
        except (KeyError, TypeError):
            raise WikiUnavailable("無法登入 Wiki（尚未完成首次設定？）")
        if not result["responseResult"]["succeeded"] or not result.get("jwt"):
            raise WikiUnavailable(f"無法登入 Wiki：{result['responseResult'].get('message', '')}")
        return result["jwt"]

    @staticmethod
    def _denied(body: dict) -> bool:
        return any("forbidden" in str(e.get("message", "")).lower() or
                   str((e.get("extensions") or {}).get("exception", {}).get("code", "")) in ("6013", "1003")
                   for e in body.get("errors") or [])

    def _call(self, query: str, variables: dict) -> dict:
        with self._lock:
            if self._jwt is None:
                self._jwt = self._login()
            body = self._post(query, variables, token=self._jwt)
            if self._denied(body):
                self._jwt = self._login()
                body = self._post(query, variables, token=self._jwt)
        if body.get("errors") and not body.get("data"):
            message = "；".join(str(e.get("message", "")) for e in body["errors"])[:300]
            if "not exist" in message.lower() or "not found" in message.lower():
                raise WikiNotFound("Wiki 沒有這個頁面或版本")
            raise WikiRejected(f"Wiki 拒絕了這個操作：{message}")
        return body.get("data") or {}

    @staticmethod
    def _check(result: dict) -> None:
        status = result["responseResult"]
        if not status["succeeded"]:
            raise WikiRejected(f"Wiki 拒絕了這個操作：{status.get('message', '')}")

    @staticmethod
    def _page(row: dict) -> WikiPage:
        tags = row.get("tags") or []
        return WikiPage(id=int(row.get("id") or row.get("pageId")), path=row["path"], title=row["title"],
                        content=row.get("content") or "", description=row.get("description") or "",
                        tags=tuple(t["tag"] if isinstance(t, dict) else t for t in tags),
                        updated_at=row.get("updatedAt") or row.get("versionDate") or "")

    _FIELDS = "id path title description content updatedAt tags { tag }"

    def create_page(self, *, path, title, content, description="", tags=None) -> WikiPage:
        data = self._call(
            "mutation($content: String!, $description: String!, $path: String!, $tags: [String]!, $title: String!, "
            "$locale: String!) { pages { create(content: $content, description: $description, editor: \"markdown\", "
            "isPublished: true, isPrivate: false, locale: $locale, path: $path, tags: $tags, title: $title) { "
            "responseResult { succeeded message } page { id } } } }",
            {"content": content, "description": description, "path": path, "tags": tags or [], "title": title,
             "locale": self.locale})
        result = data["pages"]["create"]
        self._check(result)
        return self.get_page(int(result["page"]["id"]))

    def update_page(self, page_id, *, title, content, description="", tags=None) -> WikiPage:
        data = self._call(
            "mutation($id: Int!, $content: String!, $description: String!, $tags: [String]!, $title: String!) { "
            "pages { update(id: $id, content: $content, description: $description, editor: \"markdown\", "
            "isPublished: true, isPrivate: false, tags: $tags, title: $title) { "
            "responseResult { succeeded message } page { id } } } }",
            {"id": page_id, "content": content, "description": description, "tags": tags or [], "title": title})
        self._check(data["pages"]["update"])
        return self.get_page(page_id)

    def get_page(self, page_id) -> WikiPage:
        data = self._call(f"query($id: Int!) {{ pages {{ single(id: $id) {{ {self._FIELDS} }} }} }}", {"id": page_id})
        row = (data.get("pages") or {}).get("single")
        if not row:
            raise WikiNotFound(f"Wiki 沒有頁面 {page_id}")
        return self._page(row)

    def delete_page(self, page_id) -> None:
        data = self._call("mutation($id: Int!) { pages { delete(id: $id) { responseResult { succeeded message } } } }",
                          {"id": page_id})
        self._check(data["pages"]["delete"])

    def history(self, page_id) -> list[WikiVersion]:
        data = self._call(
            "query($id: Int!) { pages { history(id: $id, offsetPage: 0, offsetSize: 100) { "
            "trail { versionId versionDate authorName actionType } total } } }", {"id": page_id})
        trail = ((data.get("pages") or {}).get("history") or {}).get("trail") or []
        versions = [WikiVersion(version_id=int(t["versionId"]), date=t["versionDate"], author=t["authorName"],
                                action=t["actionType"]) for t in trail]
        return sorted(versions, key=lambda v: v.version_id)

    def get_version(self, page_id, version_id) -> WikiPage:
        data = self._call(
            "query($page: Int!, $version: Int!) { pages { version(pageId: $page, versionId: $version) { "
            "pageId path title description content versionDate tags } } }", {"page": page_id, "version": version_id})
        row = (data.get("pages") or {}).get("version")
        if not row:
            raise WikiNotFound(f"頁面 {page_id} 沒有版本 {version_id}")
        return self._page({**row, "id": row.get("pageId") or page_id})

    def search(self, query) -> list[WikiHit]:
        data = self._call("query($q: String!) { pages { search(query: $q) { results { id title description path } "
                          "totalHits } } }", {"q": query})
        results = ((data.get("pages") or {}).get("search") or {}).get("results") or []
        return [WikiHit(id=int(r["id"]), path=r["path"], title=r["title"], description=r.get("description") or "")
                for r in results if str(r.get("id", "")).isdigit()]


def wiki_from_env(env: Mapping[str, str] = os.environ) -> WikiClient | None:
    """WIKI_URL 未設定時回 None，Wiki 端點回 503。"""
    url = env.get("WIKI_URL", "").strip()
    if not url:
        return None
    return WikiJsClient(url, email=env.get("WIKI_ADMIN_EMAIL", ""), password=env.get("WIKI_ADMIN_PASSWORD", ""),
                        locale=env.get("WIKI_LOCALE", "en"))


# ---------------------------------------------------------------- 平台服務

def require_wiki(services: LlmServices) -> WikiClient:
    if services.wiki is None:
        raise Unavailable("Wiki 尚未設定（WIKI_URL）")
    return services.wiki


def prefix(project_id: int) -> str:
    return f"projects/{project_id}/"


def page_out(page: WikiPage, link: WikiPageLink) -> dict:
    return {"id": page.id, "project_id": link.project_id, "path": link.path, "title": page.title,
            "description": page.description, "content": page.content, "tags": list(page.tags),
            "created_by": link.created_by, "updated_by": link.updated_by, "updated_at": page.updated_at}


def link_out(link: WikiPageLink) -> dict:
    return {"id": link.wiki_id, "project_id": link.project_id, "path": link.path, "title": link.title,
            "created_by": link.created_by, "updated_by": link.updated_by, "updated_at": iso(link.updated_at)}


def page_ref(page: WikiPage) -> dict:
    return {"page_id": page.id, "path": page.path, "title": page.title, "updated_at": page.updated_at,
            "via": "wiki_api:pages.single"}


def _link(session: Session, *, project_id: int, page_id: int) -> WikiPageLink:
    link = session.scalar(select(WikiPageLink).where(WikiPageLink.wiki_id == page_id))
    # 別的專案的頁面與不存在的頁面回一樣的訊息
    if link is None or link.project_id != project_id:
        raise NotFound(f"找不到 Wiki 頁面 {page_id}")
    return link


def list_pages(session: Session, *, project_id: int) -> list[WikiPageLink]:
    return list(session.scalars(select(WikiPageLink).where(WikiPageLink.project_id == project_id)
                                .order_by(WikiPageLink.path)))


def fetch_page(session: Session, services: LlmServices, *, project_id: int, page_id: int) -> WikiPage:
    _link(session, project_id=project_id, page_id=page_id)
    return require_wiki(services).get_page(page_id)


def get_page(session: Session, services: LlmServices, *, project_id: int, page_id: int) -> dict:
    link = _link(session, project_id=project_id, page_id=page_id)
    return page_out(require_wiki(services).get_page(page_id), link)


def create_page(session: Session, services: LlmServices, *, project_id: int, actor: str, source_ip: str | None,
                path: str, title: str, content: str, description: str = "", tags: list[str] | None = None) -> dict:
    wiki = require_wiki(services)
    if not _PATH.match(path) or len(path) > 200:
        raise Invalid("路徑只能用小寫英數字、底線、連字號，以 / 分層")
    if session.scalar(select(WikiPageLink).where(WikiPageLink.project_id == project_id, WikiPageLink.path == path)):
        raise Conflict(f"專案內已有路徑 {path}")
    page = wiki.create_page(path=prefix(project_id) + path, title=title, content=content, description=description,
                            tags=prompts.clean_tags(tags or []))
    link = WikiPageLink(project_id=project_id, wiki_id=page.id, path=path, title=title, created_by=actor,
                        updated_by=actor)
    session.add(link)
    record(session, actor=actor, category=AuditCategory.DATASET, action="llm.wiki.page.create",
           target=f"wiki:{page.id}", source_ip=source_ip, detail={"path": path, "title": title})
    try:
        session.commit()
    except Exception:
        session.rollback()
        wiki.delete_page(page.id)      # 平台這邊沒記到歸屬，就不要在 Wiki 留下無主的頁面
        raise
    return page_out(page, link)


def update_page(session: Session, services: LlmServices, *, project_id: int, actor: str, source_ip: str | None,
                page_id: int, title: str, content: str, description: str = "", tags: list[str] | None = None) -> dict:
    link = _link(session, project_id=project_id, page_id=page_id)
    page = require_wiki(services).update_page(page_id, title=title, content=content, description=description,
                                              tags=prompts.clean_tags(tags or []))
    link.title, link.updated_by, link.updated_at = title, actor, utcnow()
    record(session, actor=actor, category=AuditCategory.DATASET, action="llm.wiki.page.update",
           target=f"wiki:{page_id}", source_ip=source_ip, detail={"path": link.path, "title": title})
    session.commit()
    return page_out(page, link)


def delete_page(session: Session, services: LlmServices, *, project_id: int, actor: str, source_ip: str | None,
                page_id: int) -> None:
    link = _link(session, project_id=project_id, page_id=page_id)
    try:
        require_wiki(services).delete_page(page_id)
    except WikiNotFound:
        pass
    session.delete(link)
    record(session, actor=actor, category=AuditCategory.DATASET, action="llm.wiki.page.delete",
           target=f"wiki:{page_id}", source_ip=source_ip, detail={"path": link.path})
    session.commit()


def history(session: Session, services: LlmServices, *, project_id: int, page_id: int) -> list[dict]:
    _link(session, project_id=project_id, page_id=page_id)
    return [{"version_id": v.version_id, "date": v.date, "author": v.author, "action": v.action}
            for v in require_wiki(services).history(page_id)]


def get_version(session: Session, services: LlmServices, *, project_id: int, page_id: int, version_id: int) -> dict:
    link = _link(session, project_id=project_id, page_id=page_id)
    page = require_wiki(services).get_version(page_id, version_id)
    return {"page_id": page_id, "version_id": version_id, "path": link.path, "title": page.title,
            "description": page.description, "content": page.content, "date": page.updated_at}


def search(session: Session, services: LlmServices, *, project_id: int, query: str) -> list[dict]:
    """Wiki 的檢索不分專案，所以只留下歸屬於本專案的頁面。"""
    if not query.strip():
        raise Invalid("請輸入檢索字詞")
    links = {l.wiki_id: l for l in list_pages(session, project_id=project_id)}
    return [{"id": h.id, "path": links[h.id].path, "title": h.title, "description": h.description}
            for h in require_wiki(services).search(query.strip()) if h.id in links]


def ask(session: Session, services: LlmServices, *, project_id: int, actor: str, source_ip: str | None,
        question: str, page_id: int | None = None, query: str | None = None, model: str | None = None) -> dict:
    """以 Wiki API 取文件 → 交給 LLM。不呼叫 embedding、不查向量庫。"""
    wiki = require_wiki(services)
    if page_id is not None:
        ids = [_link(session, project_id=project_id, page_id=page_id).wiki_id]
    else:
        ids = [h["id"] for h in search(session, services, project_id=project_id, query=query or question)]
        ids = ids[:MAX_ASK_PAGES]
        if not ids:
            raise NotFound("Wiki 裡找不到相關的文件，請換個檢索字詞或指定頁面")
    pages = [wiki.get_page(i) for i in ids]
    budget = MAX_CONTEXT_CHARS // len(pages)
    context = "Context:\n" + "\n\n".join(f"[{i}]（Wiki：{p.title}）{p.content[:budget]}"
                                         for i, p in enumerate(pages, start=1))
    params = prompts.get_generation_params(session, project_id=project_id, username=actor)
    system = "\n\n".join(s for s in (params.system_prompt.strip(), GROUNDING, context) if s)
    refs = [page_ref(p) for p in pages]
    try:
        call, result = call_llm(session, services, project_id=project_id, username=actor, origin="wiki",
                                origin_ref=",".join(f"wiki:{p.id}" for p in pages),
                                model=choose_model(session, services, model), params=to_openai(params),
                                context_source="wiki_api", context_refs=refs,
                                messages=[{"role": "system", "content": system},
                                          {"role": "user", "content": question}])
    except LlmError as exc:
        session.rollback()
        record(session, actor=actor, category=AuditCategory.INFERENCE, action="llm.wiki.ask",
               target=f"wiki:{ids[0]}", result="failed", source_ip=source_ip, detail={"reason": exc.code})
        session.commit()
        raise
    record(session, actor=actor, category=AuditCategory.INFERENCE, action="llm.wiki.ask", target=f"wiki:{ids[0]}",
           source_ip=source_ip, detail={"call_id": call.id, "pages": [p.id for p in pages]})
    session.commit()
    return {"answer": result.content, "pages": refs, "context_source": "wiki_api", "call_id": call.id,
            "usage": result.usage}
