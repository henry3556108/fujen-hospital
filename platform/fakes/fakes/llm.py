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


def _words(text: str) -> int:
    return len(text.split())


def _last_user_message(messages: list[ChatMessage]) -> str:
    for m in reversed(messages):
        if m.role == "user" and m.content:
            return m.content
    return ""


def _answer(req: ChatRequest) -> str:
    return "[fake-llm] " + _last_user_message(req.messages)


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
    content = _answer(req)
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
                "finish_reason": "stop",
            }
        ],
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens,
        },
    }
