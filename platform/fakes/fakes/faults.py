"""Fault injection shared by the fake services.

Per request (headers win over env defaults):
  X-Fake-Delay-Ms: <int>   sleep this long before answering
  X-Fake-Status:   <int>   answer with this HTTP status and the service's error body
Env defaults (read on every request, so tests can change them):
  <PREFIX>_DELAY_MS        default delay
  <PREFIX>_FAIL_RATE       0..1; request n fails with 503 when floor(n*rate) > floor((n-1)*rate),
                           i.e. deterministic by request counter, exactly `rate` of requests fail.
"""

from __future__ import annotations

import asyncio
import math
import os
import threading
from collections.abc import Callable
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

ErrorBody = Callable[[int, str], dict[str, Any]]

DELAY_HEADER = "x-fake-delay-ms"
STATUS_HEADER = "x-fake-status"


class _Counter:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.value = 0

    def next(self) -> int:
        with self._lock:
            self.value += 1
            return self.value


def reset_counter(app: FastAPI) -> None:
    app.state.fault_counter = _Counter()


def _int_or_none(raw: str | None) -> int | None:
    if raw is None or raw == "":
        return None
    return int(raw)


def install(app: FastAPI, env_prefix: str, error_body: ErrorBody) -> None:
    reset_counter(app)

    def error(status: int, message: str) -> JSONResponse:
        return JSONResponse(error_body(status, message), status_code=status)

    @app.middleware("http")
    async def inject_faults(request: Request, call_next):
        try:
            delay_ms = _int_or_none(request.headers.get(DELAY_HEADER))
            if delay_ms is None:
                delay_ms = _int_or_none(os.environ.get(f"{env_prefix}_DELAY_MS")) or 0
            forced = _int_or_none(request.headers.get(STATUS_HEADER))
        except ValueError:
            return error(400, "X-Fake-Delay-Ms / X-Fake-Status must be integers")
        if forced is not None and not 100 <= forced <= 599:
            return error(400, "X-Fake-Status must be an HTTP status code (100-599)")

        n = app.state.fault_counter.next()
        if delay_ms > 0:
            await asyncio.sleep(delay_ms / 1000)
        if forced is not None:
            return error(forced, f"fault injected via X-Fake-Status: {forced}")

        rate = float(os.environ.get(f"{env_prefix}_FAIL_RATE") or 0)
        if rate > 0 and math.floor(n * rate) > math.floor((n - 1) * rate):
            return error(503, f"fault injected via {env_prefix}_FAIL_RATE={rate} (request #{n})")
        return await call_next(request)
