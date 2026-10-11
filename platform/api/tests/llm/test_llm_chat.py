"""Playground：TC-B07-03、TC-B07-05、TC-B07-08。"""
import pytest
from sqlalchemy import select

from app.llm.models import ChatMessage, ChatSession, LlmCallRecord
from app.models import AuditLog

from docs_support import FILES


@pytest.fixture
def kb(client, llm, coder, base):
    kb = client.post(f"{base}/knowledge-bases", headers=coder, json={"name": "規範"}).json()
    files = [("files", (name, data, "application/octet-stream")) for name, data in FILES.items()]
    assert client.post(f"{base}/knowledge-bases/{kb['id']}/documents", headers=coder,
                       files=files).json()["counts"]["failed"] == 0
    return kb


def test_tc_b07_03_twenty_messages_free_chat_and_knowledge_base(client, llm, kb, coder, base, session):
    free = kbs = None
    for i in range(10):
        body = {"mode": "free", "message": f"第 {i + 1} 個問題", "session_id": free}
        answer = client.post(f"{base}/chat", headers=coder, json=body)
        assert answer.status_code == 200, answer.text
        free = answer.json()["session_id"]
        assert f"echo: 第 {i + 1} 個問題" in answer.json()["message"]["content"]
        assert answer.json()["message"]["sources"] == []
    for i in range(10):
        body = {"mode": "kb", "kb_id": kb["id"], "message": f"夜間門診是星期幾（第 {i + 1} 次）", "session_id": kbs}
        answer = client.post(f"{base}/chat", headers=coder, json=body)
        assert answer.status_code == 200, answer.text
        kbs = answer.json()["session_id"]
        assert answer.json()["message"]["sources"], "知識庫對話必須帶出處"
    assert free != kbs
    for session_id in (free, kbs):
        conversation = client.get(f"{base}/chat/sessions/{session_id}", headers=coder).json()
        assert [m["role"] for m in conversation["messages"]] == ["user", "assistant"] * 10
    session.expire_all()
    assert len(session.scalars(select(LlmCallRecord).where(LlmCallRecord.status == "success")).all()) == 20
    audits = session.scalars(select(AuditLog).where(AuditLog.action == "llm.chat")).all()
    assert len(audits) == 20 and {a.category for a in audits} == {"inference"}
    # 第 10 則送出時帶著前 9 輪的對話
    assert len([m for m in llm.client.chat_calls[9]["messages"] if m["role"] == "assistant"]) == 9


def test_tc_b07_03_timeout_returns_retry_hint_and_no_half_conversation(client, llm, coder, base, session):
    llm.client.fail = "timeout"
    answer = client.post(f"{base}/chat", headers=coder, json={"mode": "free", "message": "hi"})
    assert answer.status_code == 504
    assert answer.json()["detail"] == {"code": "llm_timeout", "message": "模型回應逾時，請重試", "retry": True}
    session.expire_all()
    assert session.scalars(select(ChatSession)).all() == [] and session.scalars(select(ChatMessage)).all() == []
    assert [c.status for c in session.scalars(select(LlmCallRecord))] == ["timeout"]
    assert [a.result for a in session.scalars(select(AuditLog).where(AuditLog.action == "llm.chat"))] == ["failed"]
    # 重試成功
    llm.client.fail = None
    assert client.post(f"{base}/chat", headers=coder, json={"mode": "free", "message": "hi"}).status_code == 200


def test_tc_b07_08_model_service_down_returns_retry_hint(client, llm, kb, coder, base, session):
    started = client.post(f"{base}/chat", headers=coder, json={"mode": "free", "message": "先問一題"}).json()
    llm.client.fail = "down"
    for body in ({"mode": "free", "message": "hi", "session_id": started["session_id"]},
                 {"mode": "kb", "kb_id": kb["id"], "message": "門診時間"}):
        answer = client.post(f"{base}/chat", headers=coder, json=body)
        assert answer.status_code == 503
        assert answer.json()["detail"]["code"] == "llm_unavailable" and answer.json()["detail"]["retry"] is True
    # 已有的對話不受影響，沒有多出半則訊息
    conversation = client.get(f"{base}/chat/sessions/{started['session_id']}", headers=coder).json()
    assert len(conversation["messages"]) == 2
    llm.client.fail = None
    again = client.post(f"{base}/chat", headers=coder,
                        json={"mode": "free", "message": "恢復了嗎", "session_id": started["session_id"]})
    assert again.status_code == 200


def test_model_service_not_configured_is_503(client, llm, coder, base):
    llm.client = None
    answer = client.post(f"{base}/chat", headers=coder, json={"mode": "free", "message": "hi"})
    assert answer.status_code == 503 and "LLM_BASE_URL" in answer.text


def test_tc_b07_05_saved_generation_params_reach_the_model(client, llm, coder, base):
    wanted = {"temperature": 0.35, "max_new_tokens": 256, "repetition_penalty": 1.15, "length_penalty": 0.8,
              "top_k": 40, "top_p": 0.85, "system_prompt": "你是輔大醫院的院內助理。"}
    client.put(f"{base}/generation-params", headers=coder, json=wanted)
    body = client.post(f"{base}/chat", headers=coder, json={"mode": "free", "message": "hi"}).json()
    sent = llm.client.chat_calls[-1]
    assert {k: sent[k] for k in ("temperature", "repetition_penalty", "length_penalty", "top_k", "top_p")} == {
        k: wanted[k] for k in ("temperature", "repetition_penalty", "length_penalty", "top_k", "top_p")}
    assert sent["max_tokens"] == 256
    assert sent["messages"][0] == {"role": "system", "content": "你是輔大醫院的院內助理。"}
    request = client.get(f"{base}/calls/{body['call_id']}", headers=coder).json()["request"]
    assert request["top_k"] == 40 and request["messages"][-1] == {"role": "user", "content": "hi"}


def test_prompt_template_is_applied_and_personal_ones_stay_private(client, llm, coder, project, member, base):
    mine = client.post(f"{base}/prompts", headers=coder,
                       json={"title": "摘要", "content": "請摘要以下內容：{input}", "visibility": "personal"}).json()
    client.post(f"{base}/chat", headers=coder, json={"mode": "free", "message": "病人主訴胸痛", "prompt_id": mine["id"]})
    assert llm.client.chat_calls[-1]["messages"][-1]["content"] == "請摘要以下內容：病人主訴胸痛"
    other = member(project, "ca02")
    denied = client.post(f"{base}/chat", headers=other,
                         json={"mode": "free", "message": "x", "prompt_id": mine["id"]})
    assert denied.status_code == 404


def test_chat_sessions_are_private_to_their_owner(client, llm, coder, admin, project, member, base):
    mine = client.post(f"{base}/chat", headers=coder, json={"mode": "free", "message": "hi"}).json()["session_id"]
    other = member(project, "ca02")
    assert client.get(f"{base}/chat/sessions/{mine}", headers=other).status_code == 404
    assert client.get(f"{base}/chat/sessions", headers=other).json() == []
    assert client.post(f"{base}/chat", headers=other,
                       json={"mode": "free", "message": "x", "session_id": mine}).status_code == 404
    assert [s["id"] for s in client.get(f"{base}/chat/sessions", headers=coder).json()] == [mine]


def test_chat_validation_and_permissions(client, llm, kb, coder, viewer, base):
    for body in ({"mode": "kb", "message": "x"}, {"mode": "free", "kb_id": kb["id"], "message": "x"},
                 {"mode": "voice", "message": "x"}, {"mode": "free", "message": ""},
                 {"mode": "free", "message": "x", "model": "not-loaded"}):
        assert client.post(f"{base}/chat", headers=coder, json=body).status_code == 422, body
    started = client.post(f"{base}/chat", headers=coder, json={"mode": "free", "message": "x"}).json()["session_id"]
    switched = client.post(f"{base}/chat", headers=coder,
                           json={"mode": "kb", "kb_id": kb["id"], "message": "x", "session_id": started})
    assert switched.status_code == 422
    assert client.post(f"{base}/chat", headers=coder, json={"mode": "kb", "kb_id": 999, "message": "x"}).status_code == 404
    assert client.post(f"{base}/chat", headers=viewer, json={"mode": "free", "message": "x"}).status_code == 403
    assert client.post(f"{base}/chat", json={"mode": "free", "message": "x"}).status_code == 401


def test_loaded_whitelist_model_can_be_chosen(client, llm, whitelist, install, coder, base):
    assert client.get(f"{base}/models/available", headers=coder).json() == {
        "default": "fake-llm-small", "models": ["fake-llm-small"], "configured": True, "api": "openai",
        "embed_model": "fake-embed-small"}
    install("small")
    client.post(f"{base}/models/small/load", headers=coder)
    assert client.get(f"{base}/models/available", headers=coder).json()["models"] == ["fake-llm-small", "small"]
    answer = client.post(f"{base}/chat", headers=coder, json={"mode": "free", "message": "x", "model": "small"})
    assert answer.status_code == 200 and llm.client.chat_calls[-1]["model"] == "small"
