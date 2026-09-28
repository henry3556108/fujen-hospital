"""Fake LLM: OpenAI-style errors and fault injection (supports TC-B07-03/08 timeout and outage)."""

import time

import pytest
from fastapi.testclient import TestClient

from fakes import faults
from fakes.llm import app

client = TestClient(app)

BODY = {"model": "fake-llm-small", "messages": [{"role": "user", "content": "hi"}]}


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    monkeypatch.delenv("FAKE_LLM_DELAY_MS", raising=False)
    monkeypatch.delenv("FAKE_LLM_FAIL_RATE", raising=False)
    faults.reset_counter(app)


def assert_openai_error(r, status):
    assert r.status_code == status
    err = r.json()["error"]
    assert isinstance(err["message"], str) and err["message"]
    assert isinstance(err["type"], str)
    assert "param" in err and "code" in err


def test_missing_messages_is_openai_style_400_not_422():
    r = client.post("/v1/chat/completions", json={"model": "fake-llm-small"})
    assert_openai_error(r, 400)
    assert r.json()["error"]["type"] == "invalid_request_error"
    assert "messages" in r.json()["error"]["message"]


def test_wrong_param_type_is_400():
    r = client.post("/v1/chat/completions", json={**BODY, "temperature": "hot"})
    assert_openai_error(r, 400)


def test_invalid_embedding_input_is_400():
    r = client.post("/v1/embeddings", json={"model": "fake-embed-small", "input": 42})
    assert_openai_error(r, 400)


def test_unknown_route_is_openai_style_404():
    assert_openai_error(client.get("/v1/nope"), 404)


def test_status_header_returns_that_status_with_openai_error_body():
    r = client.post("/v1/chat/completions", json=BODY, headers={"X-Fake-Status": "503"})
    assert_openai_error(r, 503)
    r = client.post("/v1/embeddings", json={"model": "fake-embed-small", "input": "x"},
                    headers={"X-Fake-Status": "429"})
    assert_openai_error(r, 429)


def test_invalid_status_header_is_rejected_with_400():
    r = client.post("/v1/chat/completions", json=BODY, headers={"X-Fake-Status": "abc"})
    assert_openai_error(r, 400)


def test_delay_header_sleeps_before_answering():
    start = time.perf_counter()
    r = client.post("/v1/chat/completions", json=BODY, headers={"X-Fake-Delay-Ms": "200"})
    elapsed = time.perf_counter() - start
    assert r.status_code == 200
    assert elapsed >= 0.2


def test_delay_env_var_is_default(monkeypatch):
    monkeypatch.setenv("FAKE_LLM_DELAY_MS", "150")
    start = time.perf_counter()
    assert client.get("/v1/models").status_code == 200
    assert time.perf_counter() - start >= 0.15


def test_delay_header_overrides_env(monkeypatch):
    monkeypatch.setenv("FAKE_LLM_DELAY_MS", "5000")
    start = time.perf_counter()
    r = client.get("/v1/models", headers={"X-Fake-Delay-Ms": "0"})
    assert r.status_code == 200
    assert time.perf_counter() - start < 1.0


def test_fail_rate_env_is_deterministic_by_request_counter(monkeypatch):
    monkeypatch.setenv("FAKE_LLM_FAIL_RATE", "0.5")
    statuses = [client.post("/v1/chat/completions", json=BODY).status_code for _ in range(10)]
    assert statuses.count(503) == 5
    assert statuses.count(200) == 5
    faults.reset_counter(app)
    again = [client.post("/v1/chat/completions", json=BODY).status_code for _ in range(10)]
    assert again == statuses


def test_fail_rate_one_fails_everything_and_zero_nothing(monkeypatch):
    monkeypatch.setenv("FAKE_LLM_FAIL_RATE", "1")
    assert_openai_error(client.post("/v1/chat/completions", json=BODY), 503)
    monkeypatch.setenv("FAKE_LLM_FAIL_RATE", "0")
    assert client.post("/v1/chat/completions", json=BODY).status_code == 200


def test_status_header_applies_to_streaming_requests():
    r = client.post("/v1/chat/completions", json={**BODY, "stream": True},
                    headers={"X-Fake-Status": "500"})
    assert_openai_error(r, 500)
