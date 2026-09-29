"""發布為內部服務 API：TC-B07-07。"""
import pytest
from sqlalchemy import select

from app.llm.models import LlmCallRecord
from app.models import AuditLog

from docs_support import FILENAMES, FILES


@pytest.fixture
def kb(client, llm, coder, base):
    kb = client.post(f"{base}/knowledge-bases", headers=coder, json={"name": "規範"}).json()
    files = [("files", (name, data, "application/octet-stream")) for name, data in FILES.items()]
    client.post(f"{base}/knowledge-bases/{kb['id']}/documents", headers=coder, files=files)
    return kb


@pytest.fixture
def caller(add_user):
    """外部系統用的帳號：不屬於任何專案，只在服務的授權名單內。"""
    return add_user("his-gateway")[1]


@pytest.fixture
def service(client, llm, kb, coder, caller, base):
    client.put(f"{base}/generation-params", headers=coder, json={
        "temperature": 0.1, "max_new_tokens": 128, "repetition_penalty": 1.0, "length_penalty": 1.0, "top_k": 20,
        "top_p": 0.9, "system_prompt": "你是院內規範問答服務。"})
    response = client.post(f"{base}/services", headers=coder, json={
        "slug": "sop-qa", "name": "院內規範問答", "kb_id": kb["id"], "grants": ["his-gateway"]})
    assert response.status_code == 201, response.text
    return response.json()


def test_tc_b07_07_granted_caller_succeeds_three_times(client, llm, service, caller, session):
    assert service["endpoint"] == "/api/llm-services/sop-qa/invoke"
    assert service["params"]["temperature"] == 0.1 and service["grants"] == ["his-gateway"]
    questions = ["夜間門診是星期幾", "體內有心律調節器可以做磁振造影嗎", "資訊室分機幾號"]
    expected = [FILENAMES["pdf"], FILENAMES["docx"], FILENAMES["csv"]]
    for question, filename in zip(questions, expected):
        response = client.post(service["endpoint"], headers=caller, json={"question": question})
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["answer"] and body["sources"][0]["filename"] == filename and body["service"] == "sop-qa"
    sent = llm.client.chat_calls[-1]
    assert sent["temperature"] == 0.1 and sent["max_tokens"] == 128
    assert sent["messages"][0]["content"].startswith("你是院內規範問答服務。")
    session.expire_all()
    audits = session.scalars(select(AuditLog).where(AuditLog.action == "llm.service.invoke")).all()
    assert [(a.category, a.actor, a.result) for a in audits] == [("inference", "his-gateway", "success")] * 3
    calls = session.scalars(select(LlmCallRecord).where(LlmCallRecord.origin == "service")).all()
    assert len(calls) == 3 and {c.origin_ref for c in calls} == {"sop-qa"} and {c.context_source for c in calls} == {"vector"}


def test_tc_b07_07_unauthorised_calls_never_succeed(client, llm, service, coder, viewer, add_user, session):
    stranger = add_user("user01")[1]
    before = len(llm.client.chat_calls)
    attempts = [
        ({}, 401),                                          # 沒有 token
        ({"Authorization": "Bearer not-a-token"}, 401),
        (stranger, 403),                                    # 已登入但不在授權名單
        (viewer, 403),                                      # 專案成員但不在授權名單
        (coder, 403),                                       # 發布者本人也要列入名單才可呼叫
    ]
    for headers, status in attempts:
        response = client.post(service["endpoint"], headers=headers, json={"question": "門診時間"})
        assert response.status_code == status, (headers, response.text)
    # 不存在的服務與未授權回一樣的結果
    assert client.post("/api/llm-services/no-such/invoke", headers=stranger, json={"question": "x"}).status_code == 403
    assert len(llm.client.chat_calls) == before
    session.expire_all()
    denied = session.scalars(select(AuditLog).where(AuditLog.action == "llm.service.invoke",
                                                    AuditLog.result == "denied")).all()
    assert sorted(a.actor for a in denied) == ["ca01", "user01", "user01", "vw01"]


def test_grant_changes_take_effect_immediately(client, llm, service, coder, caller, add_user, base):
    other = add_user("lis-gateway")[1]
    url = f"{base}/services/{service['id']}/grants"
    assert client.post(service["endpoint"], headers=other, json={"question": "x"}).status_code == 403
    assert client.put(url, headers=coder, json={"grants": ["lis-gateway"]}).json()["grants"] == ["lis-gateway"]
    assert client.post(service["endpoint"], headers=other, json={"question": "x"}).status_code == 200
    assert client.post(service["endpoint"], headers=caller, json={"question": "x"}).status_code == 403
    assert client.put(url, headers=coder, json={"grants": ["nobody"]}).status_code == 422


def test_disable_unpublish_and_outage(client, llm, service, coder, caller, admin, kb, base):
    url = f"{base}/services/{service['id']}"
    # 知識庫被服務使用時不能刪
    assert client.delete(f"{base}/knowledge-bases/{kb['id']}", headers=coder).status_code == 409
    llm.client.fail = "down"
    down = client.post(service["endpoint"], headers=caller, json={"question": "x"})
    assert down.status_code == 503 and down.json()["detail"]["retry"] is True
    llm.client.fail = None
    assert client.patch(url, headers=coder, json={"enabled": False}).json()["enabled"] is False
    assert client.post(service["endpoint"], headers=caller, json={"question": "x"}).status_code == 409
    client.patch(url, headers=coder, json={"enabled": True})
    assert client.post(service["endpoint"], headers=admin, json={"question": "x"}).status_code == 200
    assert client.delete(url, headers=coder).status_code == 204
    assert client.post(service["endpoint"], headers=caller, json={"question": "x"}).status_code == 403
    assert client.post(service["endpoint"], headers=admin, json={"question": "x"}).status_code == 404
    assert client.delete(f"{base}/knowledge-bases/{kb['id']}", headers=coder).status_code == 204


def test_service_without_knowledge_base_and_with_messages(client, llm, coder, caller, base):
    service = client.post(f"{base}/services", headers=coder,
                          json={"slug": "free-chat", "name": "一般問答", "grants": ["his-gateway"],
                                "params": {"temperature": 0.9, "system_prompt": ""}}).json()
    body = client.post(service["endpoint"], headers=caller, json={"messages": [
        {"role": "user", "content": "你好"}, {"role": "assistant", "content": "你好"},
        {"role": "user", "content": "今天星期幾"}]}).json()
    assert body["sources"] == [] and "echo: 今天星期幾" in body["answer"]
    assert [m["role"] for m in llm.client.chat_calls[-1]["messages"]] == ["user", "assistant", "user"]
    for bad in ({}, {"messages": [{"role": "assistant", "content": "x"}]},
                {"messages": [{"role": "system", "content": "越權"}, {"role": "user", "content": "x"}]}):
        assert client.post(service["endpoint"], headers=caller, json=bad).status_code == 422, bad


def test_publish_validation_and_permissions(client, llm, service, coder, viewer, session, member, base):
    ok = {"slug": "another", "name": "x"}
    for change in ({"slug": "sop-qa"}, ):
        assert client.post(f"{base}/services", headers=coder, json={**ok, **change}).status_code == 409
    for change in ({"slug": "Bad Slug"}, {"slug": "ab"}, {"kb_id": None, "model": "not-loaded"},
                   {"grants": ["ghost"]}, {"params": {"temperature": 9}}):
        assert client.post(f"{base}/services", headers=coder, json={**ok, **change}).status_code == 422, change
    assert client.post(f"{base}/services", headers=coder, json={**ok, "kb_id": 999}).status_code == 404
    assert client.post(f"{base}/services", headers=viewer, json=ok).status_code == 403
    from app.models import Project
    other = Project(name="P-other")
    session.add(other)
    session.commit()
    outsider = member(other, "ca09")
    assert client.get(f"/api/projects/{other.id}/llm/services/{service['id']}", headers=outsider).status_code == 404
    assert client.get(f"/api/projects/{other.id}/llm/services", headers=outsider).json() == []
