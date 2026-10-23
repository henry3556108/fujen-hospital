"""訓練紀錄（MLflow）。平台 API 在送出時記參數、結束時記指標；Job 容器不直接連 MLflow。

MLFLOW_TRACKING_URI 未設定時不記錄。MLflow 連不上不會讓訓練失敗，只在訓練訊息留下說明。
"""
from __future__ import annotations

import re
import time
from collections.abc import Mapping
from typing import Any, Protocol

import httpx


class TrackingError(RuntimeError):
    pass


class Tracker(Protocol):
    def start_run(self, *, experiment: str, name: str, params: dict[str, str], tags: dict[str, str]) -> str: ...
    def finish_run(self, run_id: str, *, status: str, metrics: dict[str, float], tags: dict[str, str]) -> None: ...


def flatten(data: Any, prefix: str = "") -> dict[str, Any]:
    out: dict[str, Any] = {}
    if isinstance(data, Mapping):
        for key, value in data.items():
            out |= flatten(value, f"{prefix}{key}.")
    else:
        out[prefix[:-1]] = data
    return out


def params_of(config: dict[str, Any]) -> dict[str, str]:
    return {k: str(v)[:500] for k, v in sorted(flatten(config).items()) if v is not None}


_METRIC_KEY = re.compile(r"^[\w\-. /]+$", re.ASCII)


def metrics_of(metrics: dict[str, Any]) -> dict[str, float]:
    """MLflow 只收英數等字元的指標名稱；各類別召回率的 key 含類別名（可能是中文），不合的略過，免得整批被拒。"""
    return {k: float(v) for k, v in sorted(flatten(metrics).items())
            if isinstance(v, (int, float)) and not isinstance(v, bool) and _METRIC_KEY.match(k)}


class InMemoryTracker:
    def __init__(self):
        self.runs: dict[str, dict[str, Any]] = {}

    def start_run(self, *, experiment, name, params, tags):
        run_id = f"mem-{len(self.runs) + 1}"
        self.runs[run_id] = {"experiment": experiment, "name": name, "params": dict(params), "tags": dict(tags),
                             "status": "RUNNING", "metrics": {}}
        return run_id

    def finish_run(self, run_id, *, status, metrics, tags):
        run = self.runs[run_id]
        run["status"], run["metrics"] = status, dict(metrics)
        run["tags"] |= tags


class MlflowTracker:
    """MLflow REST API（/api/2.0/mlflow）。"""

    def __init__(self, base_url: str, *, timeout: float = 10.0, transport: httpx.BaseTransport | None = None):
        self._http = httpx.Client(base_url=base_url.rstrip("/") + "/api/2.0/mlflow", timeout=timeout,
                                  transport=transport)
        self._experiments: dict[str, str] = {}

    def _call(self, method: str, path: str, **kwargs) -> dict:
        try:
            response = self._http.request(method, path, **kwargs)
        except httpx.HTTPError as exc:
            raise TrackingError(f"無法連線 MLflow：{type(exc).__name__}") from exc
        if response.status_code >= 400:
            raise TrackingError(f"MLflow 回應 {response.status_code}：{response.text[:200]}")
        return response.json() if response.content else {}

    def _experiment(self, name: str) -> str:
        if name not in self._experiments:
            try:
                found = self._call("GET", "/experiments/get-by-name", params={"experiment_name": name})
                self._experiments[name] = found["experiment"]["experiment_id"]
            except TrackingError:
                self._experiments[name] = self._call("POST", "/experiments/create",
                                                     json={"name": name})["experiment_id"]
        return self._experiments[name]

    def start_run(self, *, experiment, name, params, tags):
        run = self._call("POST", "/runs/create", json={
            "experiment_id": self._experiment(experiment), "run_name": name, "start_time": int(time.time() * 1000),
            "tags": [{"key": k, "value": v} for k, v in tags.items()]})
        run_id = run["run"]["info"]["run_id"]
        items = [{"key": k, "value": v} for k, v in params.items()]
        for start in range(0, len(items), 100):
            self._call("POST", "/runs/log-batch", json={"run_id": run_id, "params": items[start:start + 100]})
        return run_id

    def finish_run(self, run_id, *, status, metrics, tags):
        now = int(time.time() * 1000)
        self._call("POST", "/runs/log-batch", json={
            "run_id": run_id,
            "metrics": [{"key": k, "value": v, "timestamp": now, "step": 0} for k, v in metrics.items()],
            "tags": [{"key": k, "value": v} for k, v in tags.items()]})
        self._call("POST", "/runs/update", json={"run_id": run_id, "status": status, "end_time": now})


def tracker_from_env(env: Mapping[str, str]) -> Tracker | None:
    uri = env.get("MLFLOW_TRACKING_URI")
    return MlflowTracker(uri) if uri else None
