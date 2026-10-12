"""TC-B07、TC-B08、TC-D01-02～04 經 Gateway 驗收的共用 fixture。

前提：本機整合環境以 compose.llm.yaml 疊加檔啟動，執行過種子與 Wiki 首次設定：
    cd platform/deploy/local
    docker compose -f compose.yaml -f compose.llm.yaml up -d --build --wait
    docker compose -f compose.yaml -f compose.llm.yaml exec -T api /app/.venv/bin/python -m app.seed
    docker compose -f compose.yaml -f compose.llm.yaml exec -T api /app/.venv/bin/python -m app.llm.wiki_setup
執行：cd platform/acceptance && COMPOSE_PROJECT=ai-platform uv run pytest -q test_tc_b07.py test_tc_b08.py test_tc_d01_models.py

測試暫時把 ca01（coder_assistant）與 vw01（viewer）加入 P3-llm；建立的白名單、模型、知識庫、服務、工作流、
Wiki 頁面在結束時移除，可重複執行。沒有 LLM 疊加檔的環境（/models/available 回 503 或未設定）整組略過。

真模型：再疊 compose.ollama.yaml 並執行 app.llm.model_setup（見該檔開頭）。同一組測試兩種環境都能跑：
依賴假模型回覆內容的檢查只在假模型時做，真模型改查呼叫紀錄（實際送出的參數、脈絡來源）。
真的從 Hugging Face 下載的案例需要開發機能連外；需要授權的模型另需環境變數 HF_TOKEN（沒有就略過那一段）。
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
HF_HOST = "huggingface.co"


def sent_params(request: dict) -> dict:
    """呼叫紀錄 request 裡實際送給模型服務的生成參數，換成平台的名稱（OpenAI 相容直接放、Ollama 放在 options）。"""
    if "options" in request:
        names = {"num_predict": "max_tokens", "repeat_penalty": "repetition_penalty"}
        return {names.get(k, k): v for k, v in request["options"].items()}
    return {k: v for k, v in request.items() if k not in ("model", "messages", "stream")}


def reply_text(response: dict) -> str:
    """呼叫紀錄 response 裡模型回覆的文字（OpenAI 相容或 Ollama）。"""
    if "choices" in response:
        return response["choices"][0]["message"]["content"]
    return response["message"]["content"]


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
        return self.wait_download(headers, done.json())

    def wait_download(self, headers: dict, download: dict, timeout: float = 900) -> dict:
        """大檔在背景下載（execute 先回 downloading），輪詢到完成或失敗。"""
        deadline = time.monotonic() + timeout
        while download["status"] == "downloading" and time.monotonic() < deadline:
            time.sleep(3)
            listed = self.api.get(f"{self.base}/models/downloads", headers=headers)
            assert listed.status_code == 200, listed.text
            download = next(d for d in listed.json() if d["id"] == download["id"])
        return download

    def whitelist_from_hf(self, name: str, repo: str, revision: str, files: list[str], token: str | None = None,
                          **extra) -> dict:
        seen = self.api.post("/api/admin/llm/whitelist/inspect", headers=self.admin, timeout=120,
                             json={"source": HF_HOST, "repo": repo, "revision": revision, "token": token,
                                   "files": files})
        assert seen.status_code == 200, seen.text
        return self.whitelist(name, source=HF_HOST, repo=repo, revision=seen.json()["commit"],
                              sha256=seen.json()["sha256"], files=files, **extra)

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
    env.info = available.json()
    env.real = env.info.get("api") == "ollama"          # 真模型（Ollama）；否則是假模型服務
    env.service = "ollama" if env.real else "fake-llm"  # 「模型服務停止」案例要停的 compose 服務
    env.chat_model = env.info.get("default")
    try:
        yield env
    finally:
        for undo in reversed(env.cleanup):
            undo()
