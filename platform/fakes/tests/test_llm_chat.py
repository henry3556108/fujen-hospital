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


def content_of(r):
    return r.json()["choices"][0]["message"]["content"]


def test_sampling_params_are_echoed_including_vllm_extras():
    r = chat(
        temperature=0.2,
        top_p=0.9,
        max_tokens=500,
        frequency_penalty=0.1,
        presence_penalty=0.3,
        top_k=40,
        repetition_penalty=1.1,
        length_penalty=1.0,
    )
    assert r.status_code == 200
    content = content_of(r)
    for fragment in (
        "temperature=0.2",
        "top_p=0.9",
        "max_tokens=500",
        "frequency_penalty=0.1",
        "presence_penalty=0.3",
        "top_k=40",
        "repetition_penalty=1.1",
        "length_penalty=1.0",
    ):
        assert fragment in content


def test_params_not_sent_are_not_echoed():
    content = content_of(chat(temperature=0.7))
    assert "temperature=0.7" in content
    assert "top_k=" not in content


def test_long_user_message_is_echoed_short():
    long = " ".join(f"w{i}" for i in range(500))
    content = content_of(chat(messages=[{"role": "user", "content": long}]))
    assert "w0 w1 w2" in content
    assert "w499" not in content


def test_max_tokens_truncates_words_and_sets_finish_reason_length():
    r = chat(max_tokens=3)
    data = r.json()
    content = data["choices"][0]["message"]["content"]
    assert len(content.split()) == 3
    assert content.startswith("[fake-llm]")
    assert data["choices"][0]["finish_reason"] == "length"
    assert data["usage"]["completion_tokens"] == 3


def test_retrieved_context_in_system_message_reaches_answer():
    context = "Nodules under 6 mm in low-risk patients need no routine follow-up per Fleischner 2017."
    r = chat(messages=[
        {"role": "system", "content": f"Answer using the documents.\nContext: {context}"},
        {"role": "user", "content": "Do small nodules need follow-up?"},
    ], max_tokens=1000)
    assert context[:60] in content_of(r)


def test_retrieved_context_block_in_user_message_reaches_answer():
    context = "Chunk 1: The ground-glass opacity protocol requires a 3 month CT."
    r = chat(messages=[
        {"role": "user", "content": f"Context:\n{context}\n\nQuestion: what is the protocol?"},
    ])
    assert context[:60] in content_of(r)


def test_no_context_line_means_no_context_echo():
    assert "context:" not in content_of(chat()).lower()
