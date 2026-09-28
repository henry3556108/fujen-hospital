"""Fake LLM: SSE streaming in OpenAI chunk format (supports TC-B07-03 Playground)."""

import json

from fastapi.testclient import TestClient

from fakes.llm import app

client = TestClient(app)

BODY = {
    "model": "fake-llm-small",
    "messages": [{"role": "user", "content": "Summarise the CT report please"}],
    "temperature": 0.5,
}


def stream_events(body):
    with client.stream("POST", "/v1/chat/completions", json=body) as r:
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("text/event-stream")
        lines = [line for line in r.iter_lines() if line]
    assert all(line.startswith("data: ") for line in lines)
    return [line[len("data: "):] for line in lines]


def test_stream_ends_with_done_and_chunks_have_openai_shape():
    events = stream_events({**BODY, "stream": True})
    assert events[-1] == "[DONE]"
    chunks = [json.loads(e) for e in events[:-1]]
    assert len(chunks) >= 2
    ids = {c["id"] for c in chunks}
    assert len(ids) == 1 and ids.pop().startswith("chatcmpl-")
    for c in chunks:
        assert c["object"] == "chat.completion.chunk"
        assert isinstance(c["created"], int)
        assert c["model"] == "fake-llm-small"
        [choice] = c["choices"]
        assert choice["index"] == 0
        assert "delta" in choice
    assert chunks[0]["choices"][0]["delta"]["role"] == "assistant"
    assert chunks[-1]["choices"][0]["finish_reason"] == "stop"
    assert all(c["choices"][0]["finish_reason"] is None for c in chunks[:-1])


def test_stream_text_equals_non_stream_text():
    events = stream_events({**BODY, "stream": True})
    streamed = "".join(
        json.loads(e)["choices"][0]["delta"].get("content", "") for e in events[:-1]
    )
    plain = client.post("/v1/chat/completions", json=BODY).json()
    assert streamed == plain["choices"][0]["message"]["content"]


def test_stream_honours_max_tokens():
    events = stream_events({**BODY, "stream": True, "max_tokens": 2})
    chunks = [json.loads(e) for e in events[:-1]]
    text = "".join(c["choices"][0]["delta"].get("content", "") for c in chunks)
    assert len(text.split()) == 2
    assert chunks[-1]["choices"][0]["finish_reason"] == "length"
