"""Fake LLM: deterministic embeddings (supports TC-B07-06 RAG vector store)."""

import math

from fastapi.testclient import TestClient

from fakes.llm import app

client = TestClient(app)


def embed(inp):
    r = client.post("/v1/embeddings", json={"model": "fake-embed-small", "input": inp})
    assert r.status_code == 200, r.text
    return r.json()


def vec(text):
    return embed(text)["data"][0]["embedding"]


def cosine(a, b):
    return sum(x * y for x, y in zip(a, b))  # vectors are unit length


def test_response_matches_openai_schema():
    data = embed("lung nodule")
    assert data["object"] == "list"
    assert data["model"] == "fake-embed-small"
    [item] = data["data"]
    assert item["object"] == "embedding"
    assert item["index"] == 0
    assert data["usage"]["prompt_tokens"] == 2
    assert data["usage"]["total_tokens"] == 2


def test_dimension_is_384_and_vector_is_l2_normalised():
    v = vec("ground glass opacity in the right upper lobe")
    assert len(v) == 384
    assert math.isclose(math.sqrt(sum(x * x for x in v)), 1.0, rel_tol=1e-6)


def test_embeddings_are_deterministic():
    assert vec("pulmonary embolism") == vec("pulmonary embolism")


def test_list_input_returns_one_embedding_per_item_in_order():
    data = embed(["alpha beta", "gamma", "alpha beta"])
    assert [d["index"] for d in data["data"]] == [0, 1, 2]
    assert data["data"][0]["embedding"] == data["data"][2]["embedding"]
    assert data["data"][0]["embedding"] != data["data"][1]["embedding"]
    assert data["usage"]["prompt_tokens"] == 5


def test_texts_sharing_words_are_more_similar_than_unrelated_texts():
    query = vec("solid lung nodule follow-up interval")
    related = vec("follow-up interval for a solid lung nodule on CT")
    unrelated = vec("invoice payment terms and quarterly budget review")
    assert cosine(query, related) > cosine(query, unrelated) + 0.2


def test_empty_string_still_gives_unit_vector():
    v = vec("")
    assert len(v) == 384
    assert math.isclose(math.sqrt(sum(x * x for x in v)), 1.0, rel_tol=1e-6)
