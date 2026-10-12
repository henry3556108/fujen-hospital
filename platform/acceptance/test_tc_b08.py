"""TC-B08 LangGraph 工作流與 Wiki 知識庫（經 Gateway；Wiki 是真的 Wiki.js 容器）。執行方式見 llm_support.py。"""
import time

import pytest

from llm_support import documents, llm, reply_text, unique  # noqa: F401


def workflow(kb_id: int) -> dict:
    return {
        "state": {"question": "", "context": "", "draft": "", "answer": ""},
        "entry": "retrieve",
        "nodes": [
            {"id": "retrieve", "type": "retrieve", "kb_id": kb_id, "query": "{question}", "output": "context"},
            {"id": "draft", "type": "llm", "prompt": "請回答：{question}", "context": "context", "output": "draft"},
            {"id": "check", "type": "condition", "key": "draft", "operator": "contains", "value": "轉人工",
             "then": "handoff", "else": "finalise"},
            {"id": "finalise", "type": "template", "template": "答覆：{draft}", "output": "answer"},
            {"id": "handoff", "type": "template", "template": "已轉交服務台：{question}", "output": "answer"},
        ],
        "edges": [["retrieve", "draft"], ["draft", "check"], ["finalise", "END"], ["handoff", "END"]],
    }


@pytest.fixture
def flow(api, llm, documents):
    kb = llm.knowledge_base(llm.ca, documents)
    created = api.post(f"{llm.base}/workflows", headers=llm.ca,
                       json={"name": unique("規範問答流程"), "definition": workflow(kb["id"])})
    assert created.status_code == 201, created.text
    llm.later("DELETE", f"{llm.base}/workflows/{created.json()['id']}", llm.ca)
    return created.json()


def test_tc_b08_01_workflow_three_runs_every_node_recorded(api, llm, flow):
    assert len(flow["definition"]["nodes"]) >= 3
    for question in ("夜間門診是星期幾", "資訊室分機幾號", "乾洗手要搓多久"):
        run = api.post(f"{llm.base}/workflows/{flow['id']}/runs", headers=llm.ca, json={"input": {"question": question}},
                       timeout=60)
        assert run.status_code == 201, run.text
        body = run.json()
        assert body["status"] == "succeeded", body["error"]
        assert [n["node"] for n in body["nodes"]] == ["retrieve", "draft", "check", "finalise"]
        for node in body["nodes"]:
            assert node["status"] == "succeeded" and node["started_at"] and node["finished_at"]
        assert body["nodes"][1]["state_in"]["context"] == body["nodes"][0]["state_out"]["context"] != ""
        assert body["final_state"]["answer"] == "答覆：" + body["final_state"]["draft"]
        assert api.get(f"{llm.base}/workflows/{flow['id']}/runs/{body['id']}", headers=llm.ca).json() == body
    assert len(api.get(f"{llm.base}/workflows/{flow['id']}/runs", headers=llm.ca).json()) == 3
    assert api.post(f"{llm.base}/workflows/{flow['id']}/runs", headers=llm.vw, json={}).status_code == 403


def test_tc_b08_03_workflow_llm_call_is_recorded(api, llm, flow, documents):
    body = api.post(f"{llm.base}/workflows/{flow['id']}/runs", headers=llm.ca, timeout=60,
                    json={"input": {"question": "體內有心律調節器可以做磁振造影嗎"}}).json()
    node = next(n for n in body["nodes"] if n["type"] == "llm")
    assert node["llm_request"]["messages"][-1]["content"] == "請回答：體內有心律調節器可以做磁振造影嗎"
    assert "心律調節器" in node["llm_request"]["messages"][0]["content"]
    assert reply_text(node["llm_response"]) == node["state_out"]["draft"]
    call = api.get(f"{llm.base}/calls/{node['call_id']}", headers=llm.ca).json()
    assert (call["origin"], call["origin_ref"]) == ("workflow", f"workflow-run:{body['id']}:draft")
    assert call["context_source"] == "vector" and call["context_refs"][0]["filename"] == documents["docx"][0]


@pytest.fixture
def wiki(api, llm):
    probe = api.get(f"{llm.base}/wiki/pages", headers=llm.ca)
    assert probe.status_code == 200, probe.text

    def create(path, title, content):
        r = api.post(f"{llm.base}/wiki/pages", headers=llm.ca, json={"path": path, "title": title, "content": content},
                     timeout=60)
        if r.status_code == 503:
            pytest.skip(f"Wiki 尚未設定或未完成首次設定：{r.text}")
        assert r.status_code == 201, r.text
        llm.later("DELETE", f"{llm.base}/wiki/pages/{r.json()['id']}", llm.ca)
        return r.json()
    return create


def search(api, llm, query, want_id):
    """Wiki.js 的索引在儲存後才更新，最多等 20 秒。"""
    hits = []
    for _ in range(20):
        response = api.get(f"{llm.base}/wiki/search", headers=llm.ca, params={"q": query}, timeout=30)
        assert response.status_code == 200, response.text
        hits = response.json()
        if any(h["id"] == want_id for h in hits):
            return hits
        time.sleep(1)
    return hits


def test_tc_b08_02_wiki_edit_versions_and_search(api, llm, wiki):
    mark = unique("b0802")
    pages = [wiki(f"{mark}/outpatient", "門診時間規範", "門診時間為週一至週五 08:30 至 17:00。"),
             wiki(f"{mark}/mri", "磁振造影檢查前準備", f"檢查前需取下所有金屬物品。識別碼 {mark}mri"),
             wiki(f"{mark}/hand-hygiene", "手部衛生", f"乾洗手搓揉時間至少 20 秒。識別碼 {mark}hand")]
    page = pages[0]
    url = f"{llm.base}/wiki/pages/{page['id']}"
    contents = ["門診時間為週一至週五 08:30 至 17:30。", "門診時間為週一至週六 08:30 至 17:30。",
                f"門診時間為週一至週六 08:00 至 17:30，夜間門診另行公告。識別碼 {mark}night"]
    # 編輯 3 次
    for content in contents:
        updated = api.put(url, headers=llm.ca, json={"title": page["title"], "content": content}, timeout=60)
        assert updated.status_code == 200, updated.text
        assert api.get(url, headers=llm.ca).json()["content"] == content
    # 版本：3 次編輯留下 3 個舊版，內容都能回看
    history = api.get(f"{url}/history", headers=llm.ca).json()
    assert len(history) >= 3, history
    old = [api.get(f"{url}/history/{v['version_id']}", headers=llm.ca).json()["content"] for v in history]
    for content in ("門診時間為週一至週五 08:30 至 17:00。", contents[0], contents[1]):
        assert content in old, (content, old)
    # 全文檢索 3 次：以內文裡的字詞找到對的頁面
    for query, target in ((f"{mark}mri", pages[1]), (f"{mark}hand", pages[2]), ("夜間門診另行公告", pages[0])):
        hits = search(api, llm, query, target["id"])
        assert target["id"] in [h["id"] for h in hits], (query, hits)
    assert api.get(f"{llm.base}/wiki/pages", headers=llm.vw).status_code == 403


def test_tc_b08_04_wiki_document_goes_to_llm_through_wiki_api(api, llm, wiki):
    mark = unique("b0804")
    page = wiki(f"{mark}/visiting", "探病規定", "探病時間為每日 11:00 至 13:00 與 18:00 至 20:00。")
    answer = api.post(f"{llm.base}/wiki/ask", headers=llm.ca, timeout=60,
                      json={"question": "晚上可以探病嗎", "page_id": page["id"]})
    assert answer.status_code == 200, answer.text
    body = answer.json()
    assert body["context_source"] == "wiki_api" and body["pages"][0]["page_id"] == page["id"]
    assert body["pages"][0]["via"] == "wiki_api:pages.single" and body["answer"]
    if not llm.real:
        assert "context:" in body["answer"]
    call = api.get(f"{llm.base}/calls/{body['call_id']}", headers=llm.ca).json()
    assert (call["origin"], call["context_source"]) == ("wiki", "wiki_api")
    assert call["context_refs"][0]["title"] == "探病規定"
    assert "探病時間為每日 11:00 至 13:00" in call["request"]["messages"][0]["content"]
    assert reply_text(call["response"]) == body["answer"]
    # 同一時間沒有任何走向量檢索的呼叫被記在這次問答上
    vector_calls = [c for c in api.get(f"{llm.base}/calls", headers=llm.ca, params={"origin": "wiki"}).json()
                    if c["id"] == body["call_id"] and c["context_source"] != "wiki_api"]
    assert vector_calls == []
