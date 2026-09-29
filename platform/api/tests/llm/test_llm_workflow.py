"""LangGraph 工作流：TC-B08-01、TC-B08-03。"""
import pytest
from sqlalchemy import select

from app.llm.models import LlmCallRecord, WorkflowNodeRecord
from app.llm.workflow import render
from app.models import AuditLog

from docs_support import FILENAMES, FILES


@pytest.fixture
def kb(client, llm, coder, base):
    kb = client.post(f"{base}/knowledge-bases", headers=coder, json={"name": "規範"}).json()
    files = [("files", (name, data, "application/octet-stream")) for name, data in FILES.items()]
    client.post(f"{base}/knowledge-bases/{kb['id']}/documents", headers=coder, files=files)
    return kb


def definition(kb_id):
    """檢索 → 起草 → 判斷是否有答案 → 定稿／轉人工：5 個節點，含條件分支。"""
    return {
        "state": {"question": "", "context": "", "draft": "", "answer": "", "route": ""},
        "entry": "retrieve",
        "nodes": [
            {"id": "retrieve", "type": "retrieve", "kb_id": kb_id, "query": "{question}", "output": "context"},
            {"id": "draft", "type": "llm", "prompt": "請回答：{question}", "context": "context", "output": "draft"},
            {"id": "check", "type": "condition", "key": "draft", "operator": "contains", "value": "轉人工",
             "then": "handoff", "else": "finalise"},
            {"id": "finalise", "type": "template", "template": "答覆：{draft}", "output": "answer"},
            {"id": "handoff", "type": "template", "template": "已轉交服務台處理：{question}", "output": "answer"},
        ],
        "edges": [["retrieve", "draft"], ["draft", "check"], ["finalise", "END"], ["handoff", "END"]],
    }


@pytest.fixture
def flow(client, llm, kb, coder, base):
    response = client.post(f"{base}/workflows", headers=coder,
                           json={"name": "規範問答流程", "definition": definition(kb["id"])})
    assert response.status_code == 201, response.text
    return response.json()


def test_tc_b08_01_three_runs_every_node_recorded(client, llm, flow, coder, base, session):
    assert len(flow["definition"]["nodes"]) >= 3
    questions = ["夜間門診是星期幾", "資訊室分機幾號", "乾洗手要搓多久"]
    for question in questions:
        run = client.post(f"{base}/workflows/{flow['id']}/runs", headers=coder, json={"input": {"question": question}})
        assert run.status_code == 201, run.text
        body = run.json()
        assert body["status"] == "succeeded", body["error"]
        assert [n["node"] for n in body["nodes"]] == ["retrieve", "draft", "check", "finalise"]
        assert [n["seq"] for n in body["nodes"]] == [1, 2, 3, 4]
        for node in body["nodes"]:
            assert node["status"] == "succeeded" and node["started_at"] and node["finished_at"], node
        # 狀態在節點之間傳遞：每個節點看得到前面節點寫回的欄位
        assert body["nodes"][0]["state_in"]["question"] == question and body["nodes"][0]["state_in"]["context"] == ""
        assert body["nodes"][1]["state_in"]["context"] == body["nodes"][0]["state_out"]["context"] != ""
        assert body["nodes"][3]["state_in"]["draft"] == body["nodes"][1]["state_out"]["draft"]
        assert body["final_state"]["answer"] == "答覆：" + body["final_state"]["draft"]
        assert "_context_sources" not in body["final_state"]
        reloaded = client.get(f"{base}/workflows/{flow['id']}/runs/{body['id']}", headers=coder).json()
        assert reloaded == body
    runs = client.get(f"{base}/workflows/{flow['id']}/runs", headers=coder).json()
    assert len(runs) == 3 and {r["status"] for r in runs} == {"succeeded"}
    session.expire_all()
    assert len(session.scalars(select(WorkflowNodeRecord)).all()) == 12
    audits = session.scalars(select(AuditLog).where(AuditLog.action == "llm.workflow.run")).all()
    assert [(a.category, a.result, a.detail["nodes_executed"]) for a in audits] == [("inference", "success", 4)] * 3


def test_tc_b08_03_llm_node_record_carries_request_and_response(client, llm, flow, coder, base, session):
    body = client.post(f"{base}/workflows/{flow['id']}/runs", headers=coder,
                       json={"input": {"question": "體內有心律調節器可以做磁振造影嗎"}}).json()
    llm_nodes = [n for n in body["nodes"] if n["type"] == "llm"]
    assert len(llm_nodes) == 1
    node = llm_nodes[0]
    assert node["llm_request"]["messages"][-1] == {"role": "user", "content": "請回答：體內有心律調節器可以做磁振造影嗎"}
    assert "心律調節器" in node["llm_request"]["messages"][0]["content"]
    assert node["llm_response"]["choices"][0]["message"]["content"] == node["state_out"]["draft"]
    assert node["context_source"] == "vector"
    assert all(n["llm_request"] is None for n in body["nodes"] if n["type"] != "llm")
    session.expire_all()
    call = session.get(LlmCallRecord, node["call_id"])
    assert (call.origin, call.origin_ref, call.username) == ("workflow", f"workflow-run:{body['id']}:draft", "ca01")
    assert call.context_refs[0]["filename"] == FILENAMES["docx"]
    assert len(llm.client.chat_calls) == 1


def test_condition_routes_to_the_other_branch(client, llm, flow, kb, coder, base):
    changed = definition(kb["id"])
    changed["nodes"][2]["value"] = "echo"          # 假模型的回答一定含有 echo
    updated = client.put(f"{base}/workflows/{flow['id']}", headers=coder,
                         json={"name": "規範問答流程", "definition": changed})
    assert updated.status_code == 200, updated.text
    body = client.post(f"{base}/workflows/{flow['id']}/runs", headers=coder, json={"input": {"question": "掛號"}}).json()
    assert [n["node"] for n in body["nodes"]] == ["retrieve", "draft", "check", "handoff"]
    assert body["final_state"]["answer"] == "已轉交服務台處理：掛號"


def test_state_carries_over_between_runs_with_continue_from(client, llm, coder, base):
    flow = client.post(f"{base}/workflows", headers=coder, json={"name": "累計", "definition": {
        "state": {"note": "", "log": ""},
        "nodes": [{"id": "append", "type": "template", "template": "{log}[{note}]", "output": "log"},
                  {"id": "echo", "type": "llm", "prompt": "{log}", "output": "reply"},
                  {"id": "done", "type": "template", "template": "{log}", "output": "summary"}],
        "edges": [["append", "echo"], ["echo", "done"]]}}).json()
    first = client.post(f"{base}/workflows/{flow['id']}/runs", headers=coder, json={"input": {"note": "一"}}).json()
    second = client.post(f"{base}/workflows/{flow['id']}/runs", headers=coder,
                         json={"input": {"note": "二"}, "continue_from": first["id"]}).json()
    assert first["final_state"]["log"] == "[一]" and second["final_state"]["log"] == "[一][二]"
    fresh = client.post(f"{base}/workflows/{flow['id']}/runs", headers=coder, json={"input": {"note": "三"}}).json()
    assert fresh["final_state"]["log"] == "[三]"
    assert client.post(f"{base}/workflows/{flow['id']}/runs", headers=coder,
                       json={"continue_from": 9999}).status_code == 404


def test_llm_failure_marks_the_node_and_run_failed_and_keeps_earlier_records(client, llm, flow, coder, base, session):
    original = llm.client.chat

    def down(**kwargs):
        from app.llm.client import LlmUnavailable
        raise LlmUnavailable()
    llm.client.chat = down
    run = client.post(f"{base}/workflows/{flow['id']}/runs", headers=coder, json={"input": {"question": "門診"}})
    llm.client.chat = original
    assert run.status_code == 201
    body = run.json()
    assert body["status"] == "failed" and "draft" in body["error"] and body["final_state"] is None
    assert [(n["node"], n["status"]) for n in body["nodes"]] == [("retrieve", "succeeded"), ("draft", "failed")]
    assert "重試" in body["nodes"][1]["error"] and body["nodes"][1]["call_id"]
    session.expire_all()
    assert session.get(LlmCallRecord, body["nodes"][1]["call_id"]).status == "unavailable"
    audit = session.scalars(select(AuditLog).where(AuditLog.action == "llm.workflow.run")).one()
    assert audit.result == "failed"


def test_endless_loop_is_stopped(client, llm, coder, base):
    flow = client.post(f"{base}/workflows", headers=coder, json={"name": "迴圈", "definition": {
        "state": {"x": "a"},
        "nodes": [{"id": "a", "type": "template", "template": "{x}a", "output": "x"},
                  {"id": "b", "type": "template", "template": "{x}", "output": "y"},
                  {"id": "again", "type": "condition", "key": "x", "operator": "not_empty", "then": "a", "else": "END"}],
        "edges": [["a", "b"], ["b", "again"]]}})
    assert flow.status_code == 201, flow.text
    body = client.post(f"{base}/workflows/{flow.json()['id']}/runs", headers=coder, json={}).json()
    assert body["status"] == "failed" and "步數上限" in body["error"] and len(body["nodes"]) > 10


def good():
    return {"state": {"q": ""},
            "nodes": [{"id": "a", "type": "template", "template": "{q}", "output": "x"},
                      {"id": "b", "type": "llm", "prompt": "{x}", "output": "y"},
                      {"id": "c", "type": "template", "template": "{y}", "output": "z"}],
            "edges": [["a", "b"], ["b", "c"]]}


@pytest.mark.parametrize("mutate,reason", [
    (lambda d: d.update(nodes=[]), "至少"),
    (lambda d: d["nodes"].append({"id": "a", "type": "template", "template": "x", "output": "w"}), "重複"),
    (lambda d: d["nodes"][0].update(type="python"), "種類"),
    (lambda d: d["nodes"][0].update(id="END"), "保留字"),
    (lambda d: d["nodes"][0].update(id="1bad"), "id"),
    (lambda d: d["nodes"][0].update(template="{missing}"), "未定義"),
    (lambda d: d["nodes"][0].update(template="{q.__class__}"), None),       # 不是佔位符，原樣輸出
    (lambda d: d["nodes"][1].pop("prompt"), "prompt"),
    (lambda d: d["nodes"][1].update(context="nowhere"), "未定義"),
    (lambda d: d["nodes"][0].update(output="_hidden"), "output"),
    (lambda d: d["edges"].append(["a", "c"]), "一條以上"),
    (lambda d: d["edges"].append(["c", "ghost"]), "不存在"),
    (lambda d: d.update(entry="ghost"), "entry"),
    (lambda d: d.update(entry="b"), "走不到"),
    (lambda d: d.update(state={"_x": 1}), "底線"),
    (lambda d: d["nodes"].append({"id": "r", "type": "retrieve", "kb_id": 999, "query": "{q}", "output": "k"}), "知識庫"),
    (lambda d: d["nodes"].append({"id": "k", "type": "condition", "key": "x", "operator": "regex", "value": "a",
                                  "then": "END", "else": "END"}), "operator"),
    (lambda d: d["nodes"].append({"id": "w", "type": "wiki", "output": "k"}), "page_id"),
])
def test_invalid_definitions_are_rejected_with_a_reason(client, llm, coder, base, mutate, reason):
    body = good()
    mutate(body)
    response = client.post(f"{base}/workflows", headers=coder, json={"name": "x", "definition": body})
    if reason is None:
        assert response.status_code == 201
        return
    assert response.status_code in (404, 422), response.text
    assert reason in response.text, response.text


def test_render_only_replaces_plain_placeholders():
    assert render("{a}-{b}-{a.__class__}-{0}-{{a}}", {"a": "x"}) == "x--{a.__class__}-{0}-{x}"


def test_workflow_crud_scope_and_permissions(client, llm, flow, coder, viewer, session, member, base):
    assert [w["name"] for w in client.get(f"{base}/workflows", headers=coder).json()] == ["規範問答流程"]
    assert client.post(f"{base}/workflows", headers=coder,
                       json={"name": "規範問答流程", "definition": good()}).status_code == 409
    assert client.post(f"{base}/workflows/{flow['id']}/runs", headers=coder,
                       json={"input": {"unknown": 1}}).status_code == 422
    assert client.get(f"{base}/workflows", headers=viewer).status_code == 403
    assert client.post(f"{base}/workflows/{flow['id']}/runs", headers=viewer, json={}).status_code == 403
    from app.models import Project
    other = Project(name="P-other")
    session.add(other)
    session.commit()
    outsider = member(other, "ca09")
    assert client.get(f"/api/projects/{other.id}/llm/workflows/{flow['id']}", headers=outsider).status_code == 404
    assert client.post(f"/api/projects/{other.id}/llm/workflows/{flow['id']}/runs", headers=outsider,
                       json={}).status_code == 404
    run = client.post(f"{base}/workflows/{flow['id']}/runs", headers=coder, json={"input": {"question": "x"}}).json()
    assert client.delete(f"{base}/workflows/{flow['id']}", headers=coder).status_code == 204
    assert client.get(f"{base}/workflows/{flow['id']}", headers=coder).status_code == 404
    # 定義刪除後，執行紀錄仍在資料庫（稽核用）
    session.expire_all()
    assert len(session.scalars(select(WorkflowNodeRecord).where(WorkflowNodeRecord.run_id == run["id"])).all()) == 4
