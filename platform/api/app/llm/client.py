"""模型服務用戶端（OpenAI 相容）。正式環境接 vLLM，Mac 接 Ollama 或 fake-llm，由環境變數決定。

平台所有 LLM 呼叫都經過這個介面，逾時與中斷轉成固定的錯誤型別，讓上層回「可重試」的訊息。
"""
import hashlib
import math
import os
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Protocol

import httpx

DEFAULT_TIMEOUT_SECONDS = 25.0


class LlmError(Exception):
    status_code = 502
    code = "llm_error"
    retry = False

    def detail(self) -> dict:
        return {"code": self.code, "message": str(self), "retry": self.retry}


class LlmTimeout(LlmError):
    status_code, code, retry = 504, "llm_timeout", True

    def __init__(self, message: str = "模型回應逾時，請重試"):
        super().__init__(message)


class LlmUnavailable(LlmError):
    status_code, code, retry = 503, "llm_unavailable", True

    def __init__(self, message: str = "模型服務中斷，請稍後重試"):
        super().__init__(message)


@dataclass(frozen=True)
class ChatResult:
    content: str
    finish_reason: str
    usage: dict
    request: dict      # 實際送給模型服務的內容（寫進呼叫紀錄）
    response: dict     # 模型服務回傳的內容


class LlmClient(Protocol):
    def chat(self, *, model: str, messages: list[dict], params: dict | None = None,
             timeout: float | None = None) -> ChatResult: ...
    def embed(self, *, model: str, texts: list[str]) -> list[list[float]]: ...
    def models(self) -> list[str]: ...


class OpenAICompatClient:
    def __init__(self, base_url: str, *, api_key: str | None = None, timeout: float = DEFAULT_TIMEOUT_SECONDS,
                 http: httpx.Client | None = None):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self._headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
        self._http = http or httpx.Client()

    def _call(self, method: str, path: str, *, json: dict | None = None, timeout: float | None = None) -> dict:
        try:
            response = self._http.request(method, f"{self.base_url}{path}", json=json, headers=self._headers,
                                          timeout=timeout or self.timeout)
        except httpx.TimeoutException:
            raise LlmTimeout()
        except httpx.TransportError:
            raise LlmUnavailable()
        if response.status_code in (502, 503, 504):
            raise LlmUnavailable()
        if response.status_code >= 400:
            try:
                message = response.json()["error"]["message"]
            except Exception:
                message = response.text[:200]
            raise LlmError(f"模型服務回報錯誤（{response.status_code}）：{message}")
        try:
            return response.json()
        except ValueError:
            raise LlmError("模型服務回傳的內容不是 JSON")

    def chat(self, *, model, messages, params=None, timeout=None) -> ChatResult:
        request = {"model": model, "messages": messages, **(params or {})}
        body = self._call("POST", "/chat/completions", json=request, timeout=timeout)
        try:
            choice = body["choices"][0]
            content = choice["message"]["content"] or ""
        except (KeyError, IndexError, TypeError):
            raise LlmError("模型服務回傳的格式不符 OpenAI 相容介面")
        return ChatResult(content=content, finish_reason=choice.get("finish_reason") or "stop",
                          usage=body.get("usage") or {}, request=request, response=body)

    def embed(self, *, model, texts) -> list[list[float]]:
        body = self._call("POST", "/embeddings", json={"model": model, "input": texts})
        try:
            rows = sorted(body["data"], key=lambda r: r["index"])
            vectors = [r["embedding"] for r in rows]
        except (KeyError, TypeError):
            raise LlmError("模型服務回傳的格式不符 OpenAI 相容介面")
        if len(vectors) != len(texts):
            raise LlmError("模型服務回傳的向量數量與輸入不符")
        return vectors

    def models(self) -> list[str]:
        return [m["id"] for m in self._call("GET", "/models").get("data", [])]


_TOKEN = re.compile(r"\w+")


def hashed_embedding(text: str, dim: int = 64) -> list[float]:
    """字詞雜湊向量：共用字詞的文字相似度較高，同一文字結果相同。只供測試與記憶體版使用。
    中文沒有空白分詞，所以連續的 CJK 字另外拆成單字與雙字。"""
    tokens: list[str] = []
    for word in _TOKEN.findall(text.lower()):
        if any("一" <= ch <= "鿿" for ch in word):
            tokens += list(word) + [a + b for a, b in zip(word, word[1:])]
        else:
            tokens.append(word)
    vec = [0.0] * dim
    for token in tokens or ["<empty>"]:
        digest = hashlib.sha256(token.encode()).digest()
        vec[int.from_bytes(digest[:4], "big") % dim] += 1.0 if digest[4] & 1 else -1.0
    norm = math.sqrt(sum(x * x for x in vec)) or 1.0
    return [x / norm for x in vec]


@dataclass
class InMemoryLlmClient:
    """單元測試用：回覆格式與 platform/fakes 的 fake-llm 相同，可注入逾時與中斷。"""
    fail: str | None = None            # None | "timeout" | "down"
    chat_calls: list[dict] = field(default_factory=list)
    embed_calls: list[list[str]] = field(default_factory=list)
    chat_model: str = "fake-llm-small"
    embed_model: str = "fake-embed-small"

    def _check(self) -> None:
        if self.fail == "timeout":
            raise LlmTimeout()
        if self.fail == "down":
            raise LlmUnavailable()

    def chat(self, *, model, messages, params=None, timeout=None) -> ChatResult:
        self._check()
        request = {"model": model, "messages": messages, **(params or {})}
        self.chat_calls.append(request)
        parts = ["[fake-llm]", "params{" + ",".join(f"{k}={v}" for k, v in sorted((params or {}).items())) + "}"]
        for m in messages:
            if m["role"] in ("system", "user") and "Context:" in (m.get("content") or ""):
                context = " ".join(m["content"].split("Context:", 1)[1].split())
                parts.append(f"context: {context[:60]} |")
                break
        last_user = next((m["content"] for m in reversed(messages) if m["role"] == "user"), "")
        parts.append("echo: " + last_user)
        content = " ".join(parts)
        usage = {"prompt_tokens": sum(len((m.get("content") or "").split()) for m in messages),
                 "completion_tokens": len(content.split())}
        usage["total_tokens"] = usage["prompt_tokens"] + usage["completion_tokens"]
        response = {"model": model, "choices": [{"index": 0, "finish_reason": "stop",
                                                   "message": {"role": "assistant", "content": content}}],
                    "usage": usage}
        return ChatResult(content=content, finish_reason="stop", usage=usage, request=request, response=response)

    def embed(self, *, model, texts) -> list[list[float]]:
        self._check()
        self.embed_calls.append(list(texts))
        return [hashed_embedding(t) for t in texts]

    def models(self) -> list[str]:
        self._check()
        return [self.chat_model, self.embed_model]


@dataclass(frozen=True)
class LlmSettings:
    chat_model: str
    embed_model: str


def settings_from_env(env: Mapping[str, str] = os.environ) -> LlmSettings:
    return LlmSettings(chat_model=env.get("LLM_CHAT_MODEL", "fake-llm-small"),
                       embed_model=env.get("LLM_EMBED_MODEL", "fake-embed-small"))


def client_from_env(env: Mapping[str, str] = os.environ) -> LlmClient | None:
    """LLM_BASE_URL（例：http://vllm:8000/v1、http://fake-llm:8101/v1）未設定時回 None，端點回 503。"""
    base_url = env.get("LLM_BASE_URL", "").strip()
    if not base_url:
        return None
    return OpenAICompatClient(base_url, api_key=env.get("LLM_API_KEY") or None,
                              timeout=float(env.get("LLM_TIMEOUT_SECONDS", DEFAULT_TIMEOUT_SECONDS)))
