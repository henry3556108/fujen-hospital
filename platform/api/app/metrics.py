"""平台 API 的 Prometheus 指標（GET /metrics，TC-C02-01）。

叢集內由 Prometheus 依 Pod 註記抓取（platform/deploy/k8s/base/api.yaml）；Gateway 只轉送 /api/*，所以 /metrics 不對外，
網路政策也只讓 monitoring 命名空間連進來。每個 app 一個 registry（測試會建立多個 app）。
路由以樣板標示（/api/projects/{project_id}/…），不含 ID，序列數有上限；沒有對應路由的請求併成「(unmatched)」。
"""
from __future__ import annotations

import time

from fastapi import FastAPI
from prometheus_client import (CONTENT_TYPE_LATEST, CollectorRegistry, Counter, Histogram, generate_latest)
from prometheus_client import gc_collector, platform_collector, process_collector
from starlette.responses import Response

UNMATCHED = "(unmatched)"


class _Instrument:
    """純 ASGI 中介層：記錄每個 HTTP 請求的方法、路由樣板、狀態碼與耗時。"""

    def __init__(self, app, requests: Counter, duration: Histogram):
        self.app, self.requests, self.duration = app, requests, duration

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope.get("path") == "/metrics":
            await self.app(scope, receive, send)
            return
        status = {"code": 500}

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                status["code"] = message["status"]
            await send(message)

        start = time.perf_counter()
        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            route = getattr(scope.get("route"), "path", None) or UNMATCHED
            method = scope.get("method", "")
            self.requests.labels(method, route, str(status["code"])).inc()
            self.duration.labels(method, route).observe(time.perf_counter() - start)


def install(app: FastAPI) -> CollectorRegistry:
    registry = CollectorRegistry()
    process_collector.ProcessCollector(registry=registry)
    platform_collector.PlatformCollector(registry=registry)
    gc_collector.GCCollector(registry=registry)
    requests = Counter("platform_api_http_requests", "平台 API 的 HTTP 請求數", ["method", "route", "status"],
                       registry=registry)
    duration = Histogram("platform_api_http_request_duration_seconds", "平台 API 的 HTTP 請求耗時（秒）",
                         ["method", "route"], registry=registry,
                         buckets=(0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60))
    app.add_middleware(_Instrument, requests=requests, duration=duration)

    @app.get("/metrics", include_in_schema=False)
    def metrics() -> Response:
        return Response(generate_latest(registry), media_type=CONTENT_TYPE_LATEST)

    app.state.metrics_registry = registry
    return registry
