"""Fake OpenAI-compatible LLM service (stands in for vLLM / Ollama).

Test double only. Never deploy to a customer production environment.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import time
import uuid
from collections.abc import Iterator
from typing import Any

from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict

CHAT_MODEL = "fake-llm-small"
EMBED_MODEL = "fake-embed-small"
_CREATED = 1_700_000_000

app = FastAPI(title="fake-llm", description="Fake OpenAI-compatible LLM. Test use only.")


class ChatMessage(BaseModel):
    model_config = ConfigDict(extra="allow")
    role: str
    content: str | None = None


class ChatRequest(BaseModel):
    # vLLM accepts extra sampling fields (top_k, repetition_penalty, ...), so do we.
    model_config = ConfigDict(extra="allow")
    model: str
    messages: list[ChatMessage]
    temperature: float | None = None
    top_p: float | None = None
    max_tokens: int | None = None
    frequency_penalty: float | None = None
    presence_penalty: float | None = None
    stream: bool = False


# Request fields that are not sampling parameters and so are not echoed.
_NOT_ECHOED = {"model", "messages", "stream", "stream_options", "user", "tools", "tool_choice", "response_format"}
_ECHO_WORDS = 30
_CONTEXT_CHARS = 60


def _words(text: str) -> int:
    return len(text.split())


def _last_user_message(messages: list[ChatMessage]) -> str:
    for m in reversed(messages):
        if m.role == "user" and m.content:
            return m.content
    return ""


def _params_echo(req: ChatRequest) -> str:
    sent = req.model_dump(exclude_unset=True)
    items = sorted(
        (k, v) for k, v in sent.items()
        if k not in _NOT_ECHOED and isinstance(v, (int, float, str, bool)) and v is not None
    )
    return "params{" + ",".join(f"{k}={v}" for k, v in items) + "}"


def _retrieved_context(messages: list[ChatMessage]) -> str | None:
    """Text following the first line starting with 'Context:' in a system/user message."""
    for m in messages:
        if m.role not in ("system", "user") or not m.content:
            continue
        lines = m.content.splitlines()
        for i, line in enumerate(lines):
            if line.lstrip().startswith("Context:"):
                rest = [line.lstrip()[len("Context:"):]] + lines[i + 1:]
                text = " ".join(" ".join(rest).split())
                return text[:_CONTEXT_CHARS]
    return None


def _answer(req: ChatRequest) -> tuple[str, str]:
    """Return (content, finish_reason)."""
    parts = ["[fake-llm]", _params_echo(req)]
    context = _retrieved_context(req.messages)
    if context is not None:
        parts.append(f"context: {context} |")
    echo = _last_user_message(req.messages).split()[:_ECHO_WORDS]
    parts.append("echo: " + " ".join(echo))
    words = " ".join(parts).split()
    if req.max_tokens is not None and len(words) > req.max_tokens:
        return " ".join(words[: req.max_tokens]), "length"
    return " ".join(words), "stop"


@app.get("/v1/models")
def list_models() -> dict[str, Any]:
    return {
        "object": "list",
        "data": [
            {"id": m, "object": "model", "created": _CREATED, "owned_by": "fakes"}
            for m in (CHAT_MODEL, EMBED_MODEL)
        ],
    }


def _sse_chunks(
    completion_id: str, created: int, model: str, content: str, finish_reason: str
) -> Iterator[str]:
    def chunk(delta: dict[str, str], finish: str | None) -> str:
        body = {
            "id": completion_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model,
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
        }
        return f"data: {json.dumps(body)}\n\n"

    yield chunk({"role": "assistant", "content": ""}, None)
    for i, word in enumerate(content.split()):
        yield chunk({"content": word if i == 0 else " " + word}, None)
    yield chunk({}, finish_reason)
    yield "data: [DONE]\n\n"


EMBED_DIM = 384
_TOKEN_RE = re.compile(r"\w+")


class EmbeddingRequest(BaseModel):
    model_config = ConfigDict(extra="allow")
    model: str
    input: str | list[str]


def _embed(text: str) -> list[float]:
    """Feature-hashed bag of unigrams + bigrams, L2-normalised.

    Texts sharing words share hashed buckets, so their cosine similarity is higher.
    """
    tokens = _TOKEN_RE.findall(text.lower())
    features = [(t, 1.0) for t in tokens]
    features += [(f"{a} {b}", 0.5) for a, b in zip(tokens, tokens[1:])]
    if not features:
        features = [("<empty>", 1.0)]
    vec = [0.0] * EMBED_DIM
    for feature, weight in features:
        digest = hashlib.sha256(feature.encode()).digest()
        index = int.from_bytes(digest[:4], "big") % EMBED_DIM
        sign = 1.0 if digest[4] & 1 else -1.0
        vec[index] += sign * weight
    norm = math.sqrt(sum(x * x for x in vec)) or 1.0
    return [x / norm for x in vec]


@app.post("/v1/embeddings")
def embeddings(req: EmbeddingRequest) -> dict[str, Any]:
    inputs = [req.input] if isinstance(req.input, str) else req.input
    tokens = sum(_words(t) for t in inputs)
    return {
        "object": "list",
        "model": req.model,
        "data": [
            {"object": "embedding", "index": i, "embedding": _embed(t)}
            for i, t in enumerate(inputs)
        ],
        "usage": {"prompt_tokens": tokens, "total_tokens": tokens},
    }


@app.post("/v1/chat/completions")
def chat_completions(req: ChatRequest) -> Any:
    content, finish_reason = _answer(req)
    completion_id = f"chatcmpl-{uuid.uuid4().hex}"
    created = int(time.time())
    if req.stream:
        return StreamingResponse(
            _sse_chunks(completion_id, created, req.model, content, finish_reason),
            media_type="text/event-stream",
        )
    prompt_tokens = sum(_words(m.content or "") for m in req.messages)
    completion_tokens = _words(content)
    return {
        "id": completion_id,
        "object": "chat.completion",
        "created": created,
        "model": req.model,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": content},
                "finish_reason": finish_reason,
            }
        ],
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens,
        },
    }
