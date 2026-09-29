"""Wiki 知識庫：TC-B08-02、TC-B08-04。Wiki.js 以 InMemoryWiki 代替；真的 Wiki.js 在經 Gateway 驗收時驗證。"""
import httpx
import pytest
from sqlalchemy import select

from app.llm.models import LlmCallRecord
from app.llm.wiki import WikiJsClient, WikiUnavailable
from app.models import AuditLog

PAGES = [
    {"path": "sop/outpatient", "title": "門診時間規範", "content": "門診時間為週一至週五 08:30 至 17:00。", "tags": ["門診"]},
    {"path": "sop/mri", "title": "磁振造影檢查前準備", "content": "檢查前需取下所有金屬物品。"},
    {"path": "sop/hand-hygiene", "title": "手部衛生", "content": "乾洗手搓揉時間至少 20 秒。"},
]


@pytest.fixture
def pages(client, llm, coder, base):
    created = [client.post(f"{base}/wiki/pages", headers=coder, json=p) for p in PAGES]
    assert [r.status_code for r in created] == [201] * 3, [r.text for r in created]
    return [r.json() for r in created]


def test_tc_b08_02_edit_version_and_search_three_times_each(client, llm, pages, coder, project, base, session):
    # 編輯 3 次
    page = pages[0]
    contents = ["門診時間為週一至週五 08:30 至 17:30。", "門診時間為週一至週六 08:30 至 17:30。",
                "門診時間為週一至週六 08:00 至 17:30，夜間門診另行公告。"]
    for content in contents:
        updated = client.put(f"{base}/wiki/pages/{page['id']}", headers=coder,
                             json={"title": page["title"], "content": content})
        assert updated.status_code == 200, updated.text
        assert client.get(f"{base}/wiki/pages/{page['id']}", headers=coder).json()["content"] == content
    # 版本 3 筆，舊版內容都看得到
    history = client.get(f"{base}/wiki/pages/{page['id']}/history", headers=coder).json()
    assert len(history) == 3
    old = [client.get(f"{base}/wiki/pages/{page['id']}/history/{v['version_id']}", headers=coder).json()["content"]
           for v in history]
    assert old == [PAGES[0]["content"], contents[0], contents[1]]
    # 全文檢索 3 次（內文，不只是標題）
    for query, expected in (("金屬物品", "sop/mri"), ("乾洗手", "sop/hand-hygiene"), ("夜間門診", "sop/outpatient")):
        hits = client.get(f"{base}/wiki/search", headers=coder, params={"q": query}).json()
        assert [(h["path"], h["match"]) for h in hits] == [(expected, "index")], query
    # 頁面在 Wiki 裡放在專案的前綴下
    assert llm.wiki.pages[page["id"]].path == f"projects/{project.id}/sop/outpatient"
    session.expire_all()
    actions = [a.action for a in session.scalars(select(AuditLog).where(AuditLog.category == "dataset"))]
    assert actions.count("llm.wiki.page.create") == 3 and actions.count("llm.wiki.page.update") == 3


def test_tc_b08_04_wiki_ask_goes_through_wiki_api_not_vector_search(client, llm, pages, coder, base, session):
    llm.wiki.calls.clear()
    answer = client.post(f"{base}/wiki/ask", headers=coder,
                         json={"question": "做磁振造影前要注意什麼", "page_id": pages[1]["id"]})
    assert answer.status_code == 200, answer.text
    body = answer.json()
    assert body["context_source"] == "wiki_api" and body["pages"][0]["via"] == "wiki_api:pages.single"
    assert body["pages"][0]["page_id"] == pages[1]["id"] and "context:" in body["answer"]
    # 走 Wiki API 取文件；沒有呼叫 embedding，也沒有查向量庫
    assert llm.wiki.calls == ["pages.single"]
    assert llm.client.embed_calls == [] and llm.vectors.searches == 0
    sent = llm.client.chat_calls[-1]["messages"]
    assert "檢查前需取下所有金屬物品" in sent[0]["content"] and sent[-1]["content"] == "做磁振造影前要注意什麼"
    call = client.get(f"{base}/calls/{body['call_id']}", headers=coder).json()
    assert (call["origin"], call["context_source"]) == ("wiki", "wiki_api")
    assert call["context_refs"][0]["title"] == "磁振造影檢查前準備"
    assert call["request"]["messages"] == sent and call["response"]["choices"][0]["message"]["content"] == body["answer"]
    session.expire_all()
    audit = session.scalars(select(AuditLog).where(AuditLog.action == "llm.wiki.ask")).one()
    assert audit.category == "inference" and audit.detail["pages"] == [pages[1]["id"]]


def test_wiki_ask_by_search_uses_wiki_search_then_fetch(client, llm, pages, coder, base):
    llm.wiki.calls.clear()
    body = client.post(f"{base}/wiki/ask", headers=coder, json={"question": "乾洗手要搓多久", "query": "乾洗手"}).json()
    assert llm.wiki.calls == ["pages.search", "pages.single"] and llm.vectors.searches == 0
    assert [p["title"] for p in body["pages"]] == ["手部衛生"]
    missing = client.post(f"{base}/wiki/ask", headers=coder, json={"question": "x", "query": "不存在的字詞"})
    assert missing.status_code == 404


def test_search_falls_back_to_page_content_when_the_index_misses(client, llm, pages, coder, base):
    """Wiki.js 的索引以空白斷詞：中文句子裡的片段查不到。模擬索引沒有結果的情況。"""
    llm.wiki.search = lambda query: llm.wiki.calls.append("pages.search") or []
    llm.wiki.calls.clear()
    hits = client.get(f"{base}/wiki/search", headers=coder, params={"q": "金屬物品"}).json()
    assert [(h["path"], h["match"]) for h in hits] == [("sop/mri", "content")]
    assert llm.wiki.calls == ["pages.search", "pages.single", "pages.single", "pages.single"]
    assert client.get(f"{base}/wiki/search", headers=coder, params={"q": "沒有這個詞"}).json() == []
    body = client.post(f"{base}/wiki/ask", headers=coder, json={"question": "要取下什麼", "query": "金屬物品"}).json()
    assert [p["title"] for p in body["pages"]] == ["磁振造影檢查前準備"] and body["context_source"] == "wiki_api"
    assert llm.vectors.searches == 0 and llm.client.embed_calls == []


def test_wiki_node_in_workflow_records_wiki_api_as_context_source(client, llm, pages, coder, base):
    flow = client.post(f"{base}/workflows", headers=coder, json={"name": "Wiki 問答", "definition": {
        "state": {"question": ""},
        "nodes": [{"id": "read", "type": "wiki", "page_id": pages[2]["id"], "output": "doc"},
                  {"id": "answer", "type": "llm", "prompt": "{question}", "context": "doc", "output": "reply"},
                  {"id": "wrap", "type": "template", "template": "答覆：{reply}", "output": "final"}],
        "edges": [["read", "answer"], ["answer", "wrap"]]}})
    assert flow.status_code == 201, flow.text
    body = client.post(f"{base}/workflows/{flow.json()['id']}/runs", headers=coder,
                       json={"input": {"question": "乾洗手要搓多久"}}).json()
    assert body["status"] == "succeeded", body["error"]
    assert body["nodes"][1]["context_source"] == "wiki_api"
    assert "乾洗手搓揉時間至少 20 秒" in body["nodes"][1]["llm_request"]["messages"][0]["content"]
    assert llm.vectors.searches == 0


def test_wiki_pages_are_project_scoped(client, llm, pages, coder, viewer, session, member, base):
    from app.models import Project
    other = Project(name="P-other")
    session.add(other)
    session.commit()
    outsider = member(other, "ca09")
    theirs = f"/api/projects/{other.id}/llm/wiki"
    # 同樣的路徑在另一個專案可以各自存在
    mine = client.post(f"{theirs}/pages", headers=outsider,
                       json={"path": "sop/mri", "title": "別的專案", "content": "金屬物品另有規定"})
    assert mine.status_code == 201, mine.text
    page_id = pages[1]["id"]
    assert client.get(f"{theirs}/pages/{page_id}", headers=outsider).status_code == 404
    assert client.put(f"{theirs}/pages/{page_id}", headers=outsider,
                      json={"title": "x", "content": "x"}).status_code == 404
    assert client.delete(f"{theirs}/pages/{page_id}", headers=outsider).status_code == 404
    assert client.get(f"{theirs}/pages/{page_id}/history", headers=outsider).status_code == 404
    assert client.post(f"{theirs}/ask", headers=outsider, json={"question": "x", "page_id": page_id}).status_code == 404
    assert [h["title"] for h in client.get(f"{theirs}/search", headers=outsider, params={"q": "金屬物品"}).json()] == ["別的專案"]
    assert [h["path"] for h in client.get(f"{base}/wiki/search", headers=coder, params={"q": "金屬物品"}).json()] == ["sop/mri"]
    assert [p["path"] for p in client.get(f"{theirs}/pages", headers=outsider).json()] == ["sop/mri"]
    assert client.get(f"{base}/wiki/pages", headers=outsider).status_code == 403
    assert client.get(f"{base}/wiki/pages", headers=viewer).status_code == 403


def test_wiki_validation_delete_and_outage(client, llm, pages, coder, base):
    for bad in ({"path": "../etc", "title": "x", "content": "x"}, {"path": "/abs", "title": "x", "content": "x"},
                {"path": "Upper", "title": "x", "content": "x"}, {"path": "a//b", "title": "x", "content": "x"},
                {"path": "ok", "title": "", "content": "x"}, {"path": "ok", "title": "x", "content": ""}):
        assert client.post(f"{base}/wiki/pages", headers=coder, json=bad).status_code == 422, bad
    assert client.post(f"{base}/wiki/pages", headers=coder, json=PAGES[0]).status_code == 409
    assert client.get(f"{base}/wiki/search", headers=coder, params={"q": " "}).status_code == 422
    assert client.get(f"{base}/wiki/pages/{pages[0]['id']}/history/999", headers=coder).status_code == 404
    assert client.delete(f"{base}/wiki/pages/{pages[2]['id']}", headers=coder).status_code == 204
    assert client.get(f"{base}/wiki/pages/{pages[2]['id']}", headers=coder).status_code == 404
    assert pages[2]["id"] not in llm.wiki.pages
    llm.wiki.down = True
    down = client.get(f"{base}/wiki/pages/{pages[0]['id']}", headers=coder)
    assert down.status_code == 503 and down.json()["detail"]["code"] == "wiki_unavailable"
    llm.wiki = None
    assert client.get(f"{base}/wiki/pages/{pages[0]['id']}", headers=coder).status_code == 503


def test_wiki_ask_when_model_is_down_is_retryable(client, llm, pages, coder, base, session):
    llm.client.fail = "down"
    response = client.post(f"{base}/wiki/ask", headers=coder, json={"question": "x", "page_id": pages[0]["id"]})
    assert response.status_code == 503 and response.json()["detail"]["retry"] is True
    session.expire_all()
    assert [c.status for c in session.scalars(select(LlmCallRecord))] == ["unavailable"]


# ---------------------------------------------------------------- WikiJsClient（GraphQL 形狀）

def graphql(handler):
    seen = []

    def transport(request):
        import json
        body = json.loads(request.content)
        seen.append((body["query"], body["variables"], request.headers.get("authorization")))
        return httpx.Response(200, json=handler(body["query"], body["variables"], len(seen)))
    client = WikiJsClient("http://wiki:3000/", email="svc@platform.local", password="pw",
                          http=httpx.Client(transport=httpx.MockTransport(transport)))
    return client, seen


def login_ok(jwt="jwt-1"):
    return {"data": {"authentication": {"login": {"responseResult": {"succeeded": True, "message": ""}, "jwt": jwt}}}}


def test_wikijs_client_logs_in_once_and_sends_bearer():
    def handler(query, variables, n):
        if "login" in query:
            return login_ok()
        return {"data": {"pages": {"single": {"id": 7, "path": "projects/1/a", "title": "T", "description": "",
                                               "content": "C", "updatedAt": "2026-01-01T00:00:00Z",
                                               "tags": [{"tag": "x"}]}}}}
    client, seen = graphql(handler)
    page = client.get_page(7)
    client.get_page(7)
    assert (page.id, page.title, page.content, page.tags) == (7, "T", "C", ("x",))
    assert [("login" in q) for q, _, _ in seen] == [True, False, False]
    assert seen[0][1] == {"u": "svc@platform.local", "p": "pw"} and seen[0][2] is None
    assert seen[1][2] == "Bearer jwt-1"


def test_wikijs_client_logs_in_again_when_token_is_refused():
    state = {"logins": 0}

    def handler(query, variables, n):
        if "login" in query:
            state["logins"] += 1
            return login_ok(f"jwt-{state['logins']}")
        if state["logins"] == 1:
            return {"errors": [{"message": "Forbidden"}], "data": None}
        return {"data": {"pages": {"search": {"results": [{"id": "3", "title": "T", "description": "d",
                                                            "path": "projects/1/a"}], "totalHits": 1}}}}
    client, seen = graphql(handler)
    hits = client.search("門診")
    assert [(h.id, h.path) for h in hits] == [(3, "projects/1/a")] and state["logins"] == 2
    assert seen[-1][2] == "Bearer jwt-2"


def test_wikijs_client_maps_failures():
    client, _ = graphql(lambda q, v, n: login_ok() if "login" in q else {
        "data": {"pages": {"create": {"responseResult": {"succeeded": False, "message": "duplicate path"},
                                       "page": None}}}})
    with pytest.raises(Exception, match="duplicate path"):
        client.create_page(path="a", title="t", content="c")
    failing = WikiJsClient("http://wiki:3000", email="a", password="b", http=httpx.Client(
        transport=httpx.MockTransport(lambda r: (_ for _ in ()).throw(httpx.ConnectError("refused")))))
    with pytest.raises(WikiUnavailable):
        failing.get_page(1)
    bad_login, _ = graphql(lambda q, v, n: {"data": {"authentication": {"login": {
        "responseResult": {"succeeded": False, "message": "bad credentials"}, "jwt": None}}}})
    with pytest.raises(WikiUnavailable, match="bad credentials"):
        bad_login.get_page(1)
