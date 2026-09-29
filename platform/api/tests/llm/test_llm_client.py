import sys
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.llm.client import (InMemoryLlmClient, LlmError, LlmTimeout, LlmUnavailable, OpenAICompatClient,
                            client_from_env, hashed_embedding)
from app.llm.params import PARAM_NAMES, GenerationParams, to_openai

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "fakes"))
from fakes.llm import app as fake_llm  # noqa: E402


class _NoTimeoutTestClient(TestClient):
    """正式程式把 timeout 交給 httpx；Starlette 的 TestClient 不接受 timeout（視為棄用警告），測試裡略過即可。"""

    def request(self, *args, timeout=None, **kwargs):
        return super().request(*args, **kwargs)


@pytest.fixture
def client():
    return OpenAICompatClient("http://testserver/v1", http=_NoTimeoutTestClient(fake_llm))


def test_chat_sends_sampling_params_and_messages_to_model(client):
    params = to_openai(GenerationParams(temperature=0.2, max_new_tokens=64, repetition_penalty=1.1,
                                        length_penalty=0.8, top_k=40, top_p=0.5))
    result = client.chat(model="fake-llm-small", params=params,
                         messages=[{"role": "system", "content": "你是助理"}, {"role": "user", "content": "門診時間？"}])
    for fragment in ("temperature=0.2", "max_tokens=64", "repetition_penalty=1.1", "length_penalty=0.8",
                     "top_k=40", "top_p=0.5", "echo: 門診時間？"):
        assert fragment in result.content
    assert result.request["messages"][0] == {"role": "system", "content": "你是助理"}
    assert result.response["choices"][0]["message"]["content"] == result.content
    assert result.usage["total_tokens"] > 0


def test_embed_returns_one_vector_per_text_in_order(client):
    vectors = client.embed(model="fake-embed-small", texts=["門診 時間", "掛號 流程", "門診 時間"])
    assert len(vectors) == 3 and vectors[0] == vectors[2] != vectors[1]


def test_models_lists_served_models(client):
    assert {"fake-llm-small", "fake-embed-small"} <= set(client.models())


def _failing(exc):
    def handler(request):
        raise exc
    return OpenAICompatClient("http://llm/v1", http=httpx.Client(transport=httpx.MockTransport(handler)))


def test_timeout_becomes_retryable_504():
    with pytest.raises(LlmTimeout) as err:
        _failing(httpx.ReadTimeout("slow")).chat(model="m", messages=[{"role": "user", "content": "hi"}])
    assert (err.value.status_code, err.value.detail()["code"], err.value.detail()["retry"]) == (504, "llm_timeout", True)
    assert "重試" in str(err.value)


def test_connection_refused_becomes_retryable_503():
    with pytest.raises(LlmUnavailable) as err:
        _failing(httpx.ConnectError("refused")).embed(model="m", texts=["a"])
    assert (err.value.status_code, err.value.detail()["retry"]) == (503, True)


@pytest.mark.parametrize("status", [502, 503, 504])
def test_upstream_gateway_errors_are_unavailable(status):
    http = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(status, text="down")))
    with pytest.raises(LlmUnavailable):
        OpenAICompatClient("http://llm/v1", http=http).models()


def test_upstream_rejection_is_not_retryable_and_keeps_message():
    body = {"error": {"message": "model not found", "type": "not_found_error"}}
    http = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(404, json=body)))
    with pytest.raises(LlmError) as err:
        OpenAICompatClient("http://llm/v1", http=http).chat(model="x", messages=[])
    assert "model not found" in str(err.value) and err.value.retry is False


def test_malformed_response_is_an_error():
    http = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200, json={"choices": []})))
    with pytest.raises(LlmError):
        OpenAICompatClient("http://llm/v1", http=http).chat(model="x", messages=[])


def test_api_key_is_sent_as_bearer():
    seen = {}

    def handler(request):
        seen["auth"] = request.headers.get("authorization")
        return httpx.Response(200, json={"data": []})
    OpenAICompatClient("http://llm/v1", api_key="k-1", http=httpx.Client(transport=httpx.MockTransport(handler))).models()
    assert seen["auth"] == "Bearer k-1"


def test_client_from_env_requires_base_url():
    assert client_from_env({}) is None
    c = client_from_env({"LLM_BASE_URL": "http://vllm:8000/v1/", "LLM_TIMEOUT_SECONDS": "12"})
    assert (c.base_url, c.timeout) == ("http://vllm:8000/v1", 12.0)


def test_in_memory_client_matches_fake_llm_format_and_can_fail():
    c = InMemoryLlmClient()
    result = c.chat(model="fake-llm-small", params={"temperature": 0.1},
                    messages=[{"role": "system", "content": "Context: 門診時間為週一至週五"},
                              {"role": "user", "content": "門診時間？"}])
    assert result.content.startswith("[fake-llm] params{temperature=0.1}")
    assert "context: 門診時間為週一至週五 |" in result.content and result.content.endswith("echo: 門診時間？")
    c.fail = "timeout"
    with pytest.raises(LlmTimeout):
        c.chat(model="m", messages=[])
    c.fail = "down"
    with pytest.raises(LlmUnavailable):
        c.embed(model="m", texts=["a"])


def test_hashed_embedding_is_stable_and_handles_chinese():
    a, b, c = (hashed_embedding(t) for t in ("門診時間為週一至週五", "門診時間", "放射科設備保養"))
    dot = lambda x, y: sum(i * j for i, j in zip(x, y))  # noqa: E731
    assert a == hashed_embedding("門診時間為週一至週五") and dot(a, b) > dot(a, c)


def test_seven_generation_params_with_bounds():
    assert PARAM_NAMES == ("temperature", "max_new_tokens", "repetition_penalty", "length_penalty",
                           "top_k", "top_p", "system_prompt")
    for bad in ({"temperature": 2.5}, {"max_new_tokens": 0}, {"top_p": 0}, {"top_k": 0}, {"unknown": 1}):
        with pytest.raises(ValidationError):
            GenerationParams(**bad)
    assert "system_prompt" not in to_openai(GenerationParams(system_prompt="x"))
