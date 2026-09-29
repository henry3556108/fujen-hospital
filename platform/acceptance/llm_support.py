"""TC-B07、TC-B08、TC-D01-02～04 經 Gateway 驗收的共用 fixture。

前提：本機整合環境以 compose.llm.yaml 疊加檔啟動，執行過種子與 Wiki 首次設定：
    cd platform/deploy/local
    docker compose -f compose.yaml -f compose.llm.yaml up -d --build --wait
    docker compose -f compose.yaml -f compose.llm.yaml exec -T api /app/.venv/bin/python -m app.seed
    docker compose -f compose.yaml -f compose.llm.yaml exec -T api /app/.venv/bin/python -m app.llm.wiki_setup
執行：cd platform/acceptance && COMPOSE_PROJECT=ai-platform uv run pytest -q test_tc_b07.py test_tc_b08.py test_tc_d01_models.py

測試暫時把 ca01（coder_assistant）與 vw01（viewer）加入 P3-llm；建立的白名單、模型、知識庫、服務、工作流、
Wiki 頁面在結束時移除，可重複執行。沒有 LLM 疊加檔的環境（/models/available 回 503 或未設定）整組略過。
"""
import hashlib
import json
import subprocess
import time
from pathlib import Path

import pytest

PLATFORM = Path(__file__).resolve().parents[1]
SYNTH_DIR = PLATFORM / "tools" / "synth"
PRELOAD = PLATFORM / "deploy" / "local" / "llm" / "preload"
PROJECT = "P3-llm"
FAKE_HOST = "models.test.invalid"
FAKE_TOKEN = "hf_test_valid_token"     # 假模型來源接受的測試值，不是真的 Token


def unique(prefix: str) -> str:
    return f"{prefix}-{time.time_ns() % 10_000_000_000}"


def content_hash(files: dict[str, bytes]) -> str:
    """與平台相同的算法：依檔名排序，檔名與內容一起算。"""
    digest = hashlib.sha256()
    for name in sorted(files):
        digest.update(name.encode() + b"\0" + hashlib.sha256(files[name]).digest())
    return digest.hexdigest()


@pytest.fixture(scope="session")
def documents(tmp_path_factory) -> dict:
    """6 種格式文件各 1 份：{格式: (檔名, 內容, 只出現在這份的字句)}。"""
    out = tmp_path_factory.mktemp("synth-documents")
    subprocess.run(["uv", "run", "python", "-m", "synth", "documents", "--out", str(out)],
                   cwd=SYNTH_DIR, check=True, capture_output=True)
    manifest = json.loads((out / "manifest.json").read_text())
    return {f["format"]: (f["file"], (out / f["file"]).read_bytes(), f["unique_text"]) for f in manifest["files"]}


class Llm:
    def __init__(self, api, auth):
        self.api, self.auth = api, auth
        self.admin = auth("admin01")
        self.pid = next(p["id"] for p in api.get("/api/admin/projects", headers=self.admin).json()
                        if p["name"] == PROJECT)
        self.base = f"/api/projects/{self.pid}/llm"
        self.users = {u["username"]: u["id"] for u in api.get("/api/admin/users", headers=self.admin).json()}
        self.cleanup: list = []

    def join(self, username: str, role: str) -> dict:
        r = self.api.put(f"/api/admin/projects/{self.pid}/members/{self.users[username]}", headers=self.admin,
                         json={"role": role})
        assert r.status_code == 200, r.text
        self.cleanup.append(lambda: self.api.delete(
            f"/api/admin/projects/{self.pid}/members/{self.users[username]}", headers=self.admin))
        return self.auth(username)

    def later(self, method: str, url: str, headers: dict) -> None:
        self.cleanup.append(lambda: self.api.request(method, url, headers=headers))

    # ---- 模型
    def whitelist_from_source(self, name: str, repo: str, revision: str, **extra) -> dict:
        seen = self.api.post("/api/admin/llm/whitelist/inspect", headers=self.admin,
                             json={"source": FAKE_HOST, "repo": repo, "revision": revision, "token": FAKE_TOKEN})
        assert seen.status_code == 200, seen.text
        return self.whitelist(name, source=FAKE_HOST, repo=repo, revision=seen.json()["commit"],
                              sha256=seen.json()["sha256"], **extra)

    def whitelist(self, name: str, **body) -> dict:
        r = self.api.post("/api/admin/llm/whitelist", headers=self.admin, json={"name": name, **body})
        assert r.status_code == 201, r.text
        self.later("DELETE", f"/api/admin/llm/whitelist/{name}", self.admin)
        return r.json()

    def install(self, headers: dict, name: str, token: str | None = None) -> dict:
        requested = self.api.post(f"{self.base}/models/downloads", headers=headers, json={"name": name})
        assert requested.status_code == 201, requested.text
        download_id = requested.json()["id"]
        approved = self.api.post(f"/api/admin/llm/downloads/{download_id}/approve", headers=self.admin)
        assert approved.status_code == 200, approved.text
        done = self.api.post(f"{self.base}/models/downloads/{download_id}/execute", headers=headers,
                             json={"token": token})
        assert done.status_code == 200, done.text
        # 清理順序與建立相反：先刪模型，才能移出白名單
        self.later("DELETE", f"{self.base}/models/{name}", self.admin)
        return done.json()

    # ---- 知識庫
    def knowledge_base(self, headers: dict, documents: dict) -> dict:
        kb = self.api.post(f"{self.base}/knowledge-bases", headers=headers, json={"name": unique("驗收知識庫")})
        assert kb.status_code == 201, kb.text
        self.later("DELETE", f"{self.base}/knowledge-bases/{kb.json()['id']}", headers)
        files = [("files", (name, data, "application/octet-stream")) for name, data, _ in documents.values()]
        built = self.api.post(f"{self.base}/knowledge-bases/{kb.json()['id']}/documents", headers=headers,
                              files=files, timeout=120)
        assert built.status_code == 201, built.text
        return {**kb.json(), "build": built.json()}


@pytest.fixture
def llm(api, auth):
    env = Llm(api, auth)
    env.ca = env.join("ca01", "coder_assistant")
    env.vw = env.join("vw01", "viewer")
    available = api.get(f"{env.base}/models/available", headers=env.ca)
    if available.status_code != 200 or not available.json().get("configured"):
        for undo in reversed(env.cleanup):
            undo()
        pytest.skip("這個環境沒有啟用 LLM（需以 compose.llm.yaml 疊加檔啟動）")
    try:
        yield env
    finally:
        for undo in reversed(env.cleanup):
            undo()
