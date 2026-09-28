"""Fake LLM: OpenAI-compatible chat completions (supports TC-B07-03/05/06, TC-B08-03/04)."""

from fastapi.testclient import TestClient

from fakes.llm import app

client = TestClient(app)


def chat(**overrides):
    body = {
        "model": "fake-llm-small",
        "messages": [
            {"role": "system", "content": "You are a helpful radiology assistant."},
            {"role": "user", "content": "What is a lung nodule?"},
        ],
    }
    body.update(overrides)
    return client.post("/v1/chat/completions", json=body)


def test_models_lists_chat_and_embedding_models():
    r = client.get("/v1/models")
    assert r.status_code == 200
    data = r.json()
    assert data["object"] == "list"
    ids = {m["id"] for m in data["data"]}
    assert ids == {"fake-llm-small", "fake-embed-small"}
    for m in data["data"]:
        assert m["object"] == "model"
        assert isinstance(m["created"], int)
        assert m["owned_by"]


def test_chat_response_matches_openai_schema():
    r = chat()
    assert r.status_code == 200
    data = r.json()
    assert data["id"].startswith("chatcmpl-")
    assert data["object"] == "chat.completion"
    assert isinstance(data["created"], int)
    assert data["model"] == "fake-llm-small"
    [choice] = data["choices"]
    assert choice["index"] == 0
    assert choice["message"]["role"] == "assistant"
    assert isinstance(choice["message"]["content"], str)
    assert choice["finish_reason"] == "stop"
    usage = data["usage"]
    assert usage["total_tokens"] == usage["prompt_tokens"] + usage["completion_tokens"]


def test_content_is_deterministic_and_echoes_last_user_message():
    a = chat().json()["choices"][0]["message"]["content"]
    b = chat().json()["choices"][0]["message"]["content"]
    assert a == b
    assert a.startswith("[fake-llm] ")
    assert "What is a lung nodule?" in a


def test_last_user_message_is_the_one_echoed():
    r = chat(messages=[
        {"role": "user", "content": "first question"},
        {"role": "assistant", "content": "first answer"},
        {"role": "user", "content": "second question"},
    ])
    content = r.json()["choices"][0]["message"]["content"]
    assert "second question" in content
    assert "first question" not in content


def test_usage_counts_are_whitespace_word_counts():
    r = chat(messages=[{"role": "user", "content": "one two three"}])
    data = r.json()
    content = data["choices"][0]["message"]["content"]
    assert data["usage"]["prompt_tokens"] == 3
    assert data["usage"]["completion_tokens"] == len(content.split())
