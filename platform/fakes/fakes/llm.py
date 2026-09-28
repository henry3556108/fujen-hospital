"""Fake OpenAI-compatible LLM service (stands in for vLLM / Ollama).

Test double only. Never deploy to a customer production environment.
"""

from __future__ import annotations

import time
import uuid
from typing import Any

from fastapi import FastAPI
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


@app.post("/v1/chat/completions")
def chat_completions(req: ChatRequest) -> dict[str, Any]:
    content, finish_reason = _answer(req)
    prompt_tokens = sum(_words(m.content or "") for m in req.messages)
    completion_tokens = _words(content)
    return {
        "id": f"chatcmpl-{uuid.uuid4().hex}",
        "object": "chat.completion",
        "created": int(time.time()),
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
