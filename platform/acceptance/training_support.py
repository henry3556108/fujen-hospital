"""WP5b 經 Gateway 驗收的共用工具：資料準備、送訓練、等結果、查稽核。

需要：compose 堆疊加上 compose.kind.yaml 與 compose.training.yaml、kind 叢集已載入 platform-trainer 映像、seed 基線。
COMPOSE_PROJECT 用來查資料庫中的稽核（資料庫不對主機開放）。
"""
import json
import os
import subprocess
import time
from pathlib import Path

import httpx
import pytest

from labeling_support import ROOT, SYNTH, gateway, headers, p1_id  # noqa: F401

PROJECT = os.environ.get("COMPOSE_PROJECT")
TERMINAL = {"succeeded", "failed", "cancelled"}
SPLIT = {"train": 0.6, "validation": 0.2, "test": 0.2}


def synth(out: Path, kind: str) -> Path:
    target = out / kind
    if not (target / "manifest.json").exists():
        subprocess.run(["uv", "run", "-q", "python", "-m", "synth", kind, "--out", str(target)], cwd=SYNTH,
                       check=True, capture_output=True)
    return target


def ok(response: httpx.Response, status: int = 200):
    assert response.status_code == status, f"{response.request.method} {response.request.url} → {response.status_code} {response.text[:400]}"
    return response.json() if response.content else None


def require_training(c: httpx.Client, pid: int) -> None:
    r = c.get(f"/api/projects/{pid}/training/catalogue", headers=headers("pi01"))
    if r.status_code == 404:
        pytest.skip("這個堆疊沒有訓練 API（需要 WP5b 的平台 API 映像）")
    jobs = c.get(f"/api/projects/{pid}/jobs", headers=headers("pi01"))
    if jobs.status_code == 503:
        pytest.skip("平台 API 沒有接上 kind 叢集（compose.kind.yaml）")


def submit(c: httpx.Client, pid: int, who: str, name: str, config: dict, executor: str = "template") -> dict:
    h = headers(who)
    setting = ok(c.post(f"/api/projects/{pid}/training/settings", headers=h,
                        json={"name": f"{name} {time.time_ns()}", "config": config}), 201)
    return ok(c.post(f"/api/projects/{pid}/training/settings/{setting['id']}/runs", headers=h,
                     json={"executor": executor}), 201)


def wait(c: httpx.Client, run: dict, who: str = "pi01", timeout: float = 900) -> tuple[dict, list[str]]:
    """輪詢到結束，回傳最終狀態與看到的狀態序列（去重）。"""
    seen: list[str] = []
    deadline = time.monotonic() + timeout
    while True:
        now = ok(c.get(f"/api/projects/{run['project_id']}/training/runs/{run['id']}", headers=headers(who)))
        if not seen or seen[-1] != now["status"]:
            seen.append(now["status"])
        if now["status"] in TERMINAL:
            return now, seen
        assert time.monotonic() < deadline, f"訓練 {run['id']} 超過 {timeout} 秒仍是 {now['status']}"
        time.sleep(2)


def wait_all(c: httpx.Client, runs: list[dict], who: str = "pi01", timeout: float = 1200) -> tuple[list[dict], list[list[str]], int]:
    """同時輪詢多件訓練到全部結束。回傳（最終狀態、各自看到的狀態序列、同一時間最多幾件在執行）。"""
    seen: list[list[str]] = [[r["status"]] for r in runs]
    final: list[dict] = list(runs)
    most = 0
    deadline = time.monotonic() + timeout
    while True:
        for i, run in enumerate(runs):
            if final[i]["status"] in TERMINAL:
                continue
            final[i] = ok(c.get(f"/api/projects/{run['project_id']}/training/runs/{run['id']}", headers=headers(who)))
            if seen[i][-1] != final[i]["status"]:
                seen[i].append(final[i]["status"])
        most = max(most, sum(f["status"] == "running" for f in final))
        if all(f["status"] in TERMINAL for f in final):
            return final, seen, most
        assert time.monotonic() < deadline, f"訓練超過 {timeout} 秒仍未結束：{[f['status'] for f in final]}"
        time.sleep(1)


def psql(query: str) -> str:
    if not PROJECT:
        pytest.skip("設定 COMPOSE_PROJECT 才能查資料庫中的稽核")
    out = subprocess.run(["docker", "compose", "-p", PROJECT, "exec", "-T", "postgres", "psql", "-U", "platform",
                          "-d", "platform", "-tAc", query], capture_output=True, text=True, check=True)
    return out.stdout.strip()


def audit(category: str, action: str, since_id: int = 0) -> list[dict]:
    rows = psql("select coalesce(json_agg(a), '[]') from (select id, actor, category, action, target, result, detail "
                f"from audit_log where category = '{category}' and action = '{action}' and id > {since_id} "
                "order by id) a")
    return json.loads(rows or "[]")


def last_audit_id() -> int:
    return int(psql("select coalesce(max(id), 0) from audit_log") or 0)
