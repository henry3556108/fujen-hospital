"""真實後端的介面：Hugging Face 來源、背景下載、Ollama 載入與對話、Prompt 與檢索增強的單獨／混合紀錄（B-07、D-01）。
外部服務一律以 httpx.MockTransport 模擬，不連網路。"""
import hashlib
import json
import threading
import time

import httpx
import pytest

from app.llm.client import OllamaClient
from app.llm.runtime import LoadRequest, OllamaModelRuntime, RuntimeLoadError, digests_path, pick_gguf
from app.llm.sources import (HuggingFaceSource, InMemoryModelSource, SourceAuthError, SourceIntegrityError,
                             SourceNotFound, SourceUnreachable, content_hash)

REPO, COMMIT = "org/model-GGUF", "e" * 40
WEIGHTS = {"model-Q4_K_M.gguf": b"q4" * 1000, "model-Q8_0.gguf": b"q8" * 2000}
SMALL = {"README.md": b"# model card", "config.json": b'{"model_type": "llama"}'}


def hub(*, gated=False, tamper=False, down=False, calls=None):
    """模擬 Hugging Face Hub：中繼資料 + resolve 下載（LFS 檔附內容 sha256）。"""
    calls = calls if calls is not None else []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append((request.method, request.url.path, request.headers.get("authorization")))
        if down:
            raise httpx.ConnectError("no route", request=request)
        path = request.url.path
        if path == f"/api/models/{REPO}/revision/{COMMIT}":
            siblings = [{"rfilename": n, "size": len(d)} for n, d in SMALL.items()]
            siblings += [{"rfilename": n, "size": len(d), "lfs": {"sha256": hashlib.sha256(d).hexdigest(),
                                                                    "size": len(d)}} for n, d in WEIGHTS.items()]
            return httpx.Response(200, json={"sha": COMMIT, "gated": "manual" if gated else False,
                                             "siblings": siblings})
        if path == f"/api/models/{REPO}/revision/main":
            return httpx.Response(200, json={"sha": COMMIT, "siblings": []})
        if path.startswith(f"/api/models/{REPO}/revision/"):
            return httpx.Response(404, json={"error": "Revision Not Found"})
        prefix = f"/{REPO}/resolve/{COMMIT}/"
        if path.startswith(prefix):
            if gated and request.headers.get("authorization") != "Bearer hf_good":
                return httpx.Response(401, json={"error": "Access to model is restricted"})
            name = path[len(prefix):]
            data = {**SMALL, **WEIGHTS}[name]
            return httpx.Response(200, content=data + (b"x" if tamper and name in WEIGHTS else b""))
        return httpx.Response(401, json={"error": "Repository Not Found"})
    return HuggingFaceSource("https://hub.test", http=httpx.Client(transport=httpx.MockTransport(handler))), calls


def test_hf_latest_commit_resolves_main_but_inspect_still_needs_a_fixed_commit():
    source, _ = hub()
    assert source.latest_commit(REPO, None) == COMMIT
    with pytest.raises(SourceNotFound):
        source.inspect(REPO, "main", None)


def expected_hash(names):
    return content_hash({n: {**SMALL, **WEIGHTS}[n] for n in names})


def test_hf_inspect_reads_metadata_only_and_matches_downloaded_hash(tmp_path):
    source, calls = hub()
    listing = source.inspect(REPO, COMMIT, None, ["*Q4_K_M.gguf", "*Q8_0.gguf"])
    assert sorted(listing.digests) == sorted(WEIGHTS) and listing.sha256 == expected_hash(WEIGHTS)
    assert not [c for c in calls if "/resolve/" in c[1]], "審核只讀中繼資料，不下載權重"
    progress = []
    downloaded = source.download(REPO, COMMIT, None, tmp_path, ["*Q4_K_M.gguf", "*Q8_0.gguf"],
                                 progress=lambda done, total: progress.append((done, total)))
    assert downloaded.sha256 == listing.sha256
    assert sorted(p.name for p in tmp_path.iterdir()) == sorted(WEIGHTS)
    assert progress[-1] == (sum(map(len, WEIGHTS.values())),) * 2


def test_hf_whole_repo_hashes_small_files_and_detects_remote_code(tmp_path):
    source, _ = hub()
    listing = source.inspect(REPO, COMMIT, None)
    assert listing.sha256 == expected_hash({**SMALL, **WEIGHTS}) and not listing.has_remote_code


def test_hf_gated_model_needs_a_valid_token(tmp_path):
    source, calls = hub(gated=True)
    assert source.inspect(REPO, COMMIT, None, ["*.gguf"]).gated, "gated 模型的中繼資料不用 Token"
    with pytest.raises(SourceAuthError, match="需要 Token"):
        source.download(REPO, COMMIT, None, tmp_path, ["*.gguf"])
    with pytest.raises(SourceAuthError, match="Token 無效"):
        source.download(REPO, COMMIT, "hf_bad", tmp_path, ["*.gguf"])
    assert source.download(REPO, COMMIT, "hf_good", tmp_path / "ok", ["*.gguf"]).sha256 == expected_hash(WEIGHTS)
    assert ("GET", f"/{REPO}/resolve/{COMMIT}/model-Q4_K_M.gguf", "Bearer hf_good") in calls


def test_hf_errors_map_to_clear_types(tmp_path):
    source, _ = hub()
    with pytest.raises(SourceNotFound):
        source.inspect(REPO, "f" * 40, None)
    with pytest.raises(SourceNotFound, match="沒有符合"):
        source.inspect(REPO, COMMIT, None, ["*.safetensors"])
    with pytest.raises(SourceUnreachable):
        hub(down=True)[0].inspect(REPO, COMMIT, None)
    with pytest.raises(SourceIntegrityError):
        hub(tamper=True)[0].download(REPO, COMMIT, None, tmp_path, ["*Q4_K_M.gguf"])
    assert not list(tmp_path.rglob("*.gguf*")), "hash 不符的檔案不留下"


# ---------------------------------------------------------------- 白名單只取部分檔案、背景下載

class SlowSource(InMemoryModelSource):
    """下載要等 release 才完成，模擬大檔。"""
    def __init__(self):
        super().__init__()
        self.release = threading.Event()

    def download(self, repo, revision, token, dest, include=(), progress=None):
        listing = self._get(repo, revision, token).listing(include)
        if progress:
            progress(1, listing.total_bytes)
        assert self.release.wait(10)
        return super().download(repo, revision, token, dest, include, progress)


def test_whitelist_files_limit_what_is_downloaded(client, llm, admin, coder, base, source):
    source.add("org/quantized", "f" * 40, {"m-Q4_K_M.gguf": b"4", "m-Q8_0.gguf": b"8", "m-f16.gguf": b"16"})
    inspected = client.post("/api/admin/llm/whitelist/inspect", headers=admin, json={
        "source": "models.test.invalid", "repo": "org/quantized", "revision": "f" * 40,
        "files": ["*Q4_K_M.gguf", "*Q8_0.gguf"]}).json()
    assert inspected["files"] == ["m-Q4_K_M.gguf", "m-Q8_0.gguf"] and inspected["total_bytes"] == 2
    entry = client.post("/api/admin/llm/whitelist", headers=admin, json={
        "name": "quantized", "source": "models.test.invalid", "repo": "org/quantized", "revision": "f" * 40,
        "sha256": inspected["sha256"], "files": ["*Q4_K_M.gguf", "*Q8_0.gguf"]}).json()
    assert entry["files"] == ["*Q4_K_M.gguf", "*Q8_0.gguf"]
    download_id = client.post(f"{base}/models/downloads", headers=coder, json={"name": "quantized"}).json()["id"]
    client.post(f"/api/admin/llm/downloads/{download_id}/approve", headers=admin)
    done = client.post(f"{base}/models/downloads/{download_id}/execute", headers=coder, json={}).json()
    assert done["status"] == "completed" and done["hash"] == inspected["sha256"]
    assert sorted(p.name for p in (llm.model_dir / "quantized").iterdir()) == ["m-Q4_K_M.gguf", "m-Q8_0.gguf"]
    assert json.loads(digests_path(llm.model_dir / "quantized").read_text())["m-Q8_0.gguf"] == \
        hashlib.sha256(b"8").hexdigest()


def test_large_download_continues_in_background(app, client, llm, admin, coder, base):
    slow = SlowSource()
    slow.add("org/big", "9" * 40, {"big-Q4_0.gguf": b"weights"})
    llm.sources["models.test.invalid"] = slow
    llm.session_factory, llm.download_wait = app.state.sessionmaker, 0.2
    client.post("/api/admin/llm/whitelist", headers=admin, json={
        "name": "big", "source": "models.test.invalid", "repo": "org/big", "revision": "9" * 40,
        "sha256": slow.repos["org/big"].sha256})
    download_id = client.post(f"{base}/models/downloads", headers=coder, json={"name": "big"}).json()["id"]
    client.post(f"/api/admin/llm/downloads/{download_id}/approve", headers=admin)
    started = client.post(f"{base}/models/downloads/{download_id}/execute", headers=coder, json={})
    assert started.status_code == 200 and started.json()["status"] == "downloading"
    again = client.post(f"{base}/models/downloads/{download_id}/execute", headers=coder, json={})
    assert again.status_code == 409 and "下載中" in again.text
    slow.release.set()
    for _ in range(100):
        rows = {d["id"]: d for d in client.get(f"{base}/models/downloads", headers=coder).json()}
        if rows[download_id]["status"] == "completed":
            break
        time.sleep(0.05)
    assert rows[download_id]["status"] == "completed" and rows[download_id]["mode"] == "online"
    assert (llm.model_dir / "big" / "big-Q4_0.gguf").read_bytes() == b"weights"
    catalog = {m["name"]: m for m in client.get(f"{base}/models/catalog", headers=coder).json()}
    assert catalog["big"]["installed"]


# ---------------------------------------------------------------- Ollama 載入

def test_pick_gguf_by_quantization(tmp_path):
    for name in ("m-Q4_K_M.gguf", "m-Q8_0.gguf", "mmproj-model-f16.gguf"):
        (tmp_path / name).write_bytes(b"x")
    assert pick_gguf(tmp_path, "4bit") == (tmp_path / "m-Q4_K_M.gguf", None)
    assert pick_gguf(tmp_path, "8bit") == (tmp_path / "m-Q8_0.gguf", None)
    with pytest.raises(RuntimeLoadError, match="不量化"):
        pick_gguf(tmp_path, "none")
    (tmp_path / "m-f16.gguf").write_bytes(b"x")
    assert pick_gguf(tmp_path, "none") == (tmp_path / "m-f16.gguf", None)
    (tmp_path / "m-Q4_K_M.gguf").unlink()
    assert pick_gguf(tmp_path, "4bit") == (tmp_path / "m-f16.gguf", "q4_K_M"), "沒有 Q4 檔時由 Ollama 載入時量化"


def ollama(state):
    def handler(request: httpx.Request) -> httpx.Response:
        path, body = request.url.path, json.loads(request.content or b"{}") if request.method != "POST" or \
            not request.url.path.startswith("/api/blobs") else {}
        state.setdefault("calls", []).append((request.method, path, body))
        if path.startswith("/api/blobs/"):
            if request.method == "HEAD":
                return httpx.Response(200 if path in state.get("blobs", set()) else 404)
            state.setdefault("blobs", set()).add(path)
            return httpx.Response(201)
        if path == "/api/create":
            state["models"] = {**state.get("models", {}), body["model"]: body}
            return httpx.Response(200, json={"status": "success"})
        if path == "/api/show":
            created = state.get("models", {}).get(body["model"])
            if created is None:
                return httpx.Response(404, json={"error": "model not found"})
            params = "\n".join(f"{k}                    {v}" for k, v in created["parameters"].items())
            quant = "Q8_0" if "Q8" in next(iter(created["files"])) else "Q4_K_M"
            return httpx.Response(200, json={"parameters": params, "capabilities": ["completion"],
                                             "details": {"quantization_level": quant, "family": "gemma3"}})
        if path in ("/api/generate", "/api/embed"):
            if body.get("keep_alive") == -1:
                state["running"] = body["model"]
            elif body.get("keep_alive") == 0:
                state.pop("running", None)
            return httpx.Response(200, json={"done": True})
        if path == "/api/ps":
            running = state.get("running")
            return httpx.Response(200, json={"models": [{"name": f"{running}:latest", "size_vram": 123}]
                                              if running else []})
        if path == "/api/delete":
            state.get("models", {}).pop(body["model"], None)
            return httpx.Response(200)
        return httpx.Response(404)
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_ollama_runtime_loads_the_chosen_quantization_and_reports_it(tmp_path):
    for name in ("m-Q4_K_M.gguf", "m-Q8_0.gguf"):
        (tmp_path / name).write_bytes(name.encode())
    state = {}
    runtime = OllamaModelRuntime("http://ollama.test", http=ollama(state))
    request = LoadRequest(name="gemma", location=str(tmp_path), quantization="8bit", cpu=6, memory_gb=16,
                          gpu_type="gpu-exclusive", gpu_count=1, trust_remote_code=False)
    runtime.load(request)
    created = state["models"]["gemma"]
    assert list(created["files"]) == ["m-Q8_0.gguf"] and created["parameters"] == {"num_thread": 6, "num_gpu": 999}
    assert created["files"]["m-Q8_0.gguf"] == "sha256:" + hashlib.sha256(b"m-Q8_0.gguf").hexdigest()
    described = runtime.describe("gemma")
    assert (described["quantization_level"], described["num_thread"], described["processor"]) == ("Q8_0", 6, "gpu")
    blob_posts = [c for c in state["calls"] if c[0] == "POST" and c[1].startswith("/api/blobs")]
    runtime.load(request)
    assert len([c for c in state["calls"] if c[0] == "POST" and c[1].startswith("/api/blobs")]) == len(blob_posts), \
        "同一個檔案不重複上傳"
    runtime.unload("gemma")
    assert "running" not in state and "gemma" not in state["models"]

    cpu = LoadRequest(name="gemma", location=str(tmp_path), quantization="4bit", cpu=2, memory_gb=8,
                      gpu_type="cpu", gpu_count=0, trust_remote_code=False)
    runtime.load(cpu)
    assert state["models"]["gemma"]["parameters"] == {"num_thread": 2, "num_gpu": 0}


def test_ollama_runtime_down_is_unavailable(tmp_path):
    (tmp_path / "m-Q4_K_M.gguf").write_bytes(b"x")

    def handler(request):
        raise httpx.ConnectError("down", request=request)
    runtime = OllamaModelRuntime("http://ollama.test", http=httpx.Client(transport=httpx.MockTransport(handler)))
    with pytest.raises(RuntimeLoadError) as exc:
        runtime.load(LoadRequest(name="m", location=str(tmp_path), quantization="4bit", cpu=1, memory_gb=1,
                                 gpu_type="cpu", gpu_count=0, trust_remote_code=False))
    assert not exc.value.invalid


def test_ollama_client_maps_generation_params_to_options():
    sent = []

    def handler(request):
        body = json.loads(request.content)
        sent.append((request.url.path, body))
        if request.url.path == "/api/embed":
            return httpx.Response(200, json={"embeddings": [[0.1, 0.2]] * len(body["input"])})
        return httpx.Response(200, json={"message": {"role": "assistant", "content": "好"}, "done_reason": "stop",
                                         "prompt_eval_count": 7, "eval_count": 3})
    client = OllamaClient("http://ollama.test", http=httpx.Client(transport=httpx.MockTransport(handler)))
    result = client.chat(model="gemma", messages=[{"role": "user", "content": "hi"}],
                         params={"temperature": 0.3, "max_tokens": 64, "repetition_penalty": 1.2,
                                 "length_penalty": 0.8, "top_k": 40, "top_p": 0.9})
    assert sent[0][0] == "/api/chat" and sent[0][1]["options"] == {
        "temperature": 0.3, "num_predict": 64, "repeat_penalty": 1.2, "top_k": 40, "top_p": 0.9}
    assert result.content == "好" and result.usage == {"prompt_tokens": 7, "completion_tokens": 3, "total_tokens": 10}
    assert result.request["options"]["repeat_penalty"] == 1.2
    assert client.embed(model="nomic", texts=["a", "b"]) == [[0.1, 0.2], [0.1, 0.2]]


def test_runtime_status_endpoint_compares_saved_config_with_runtime(client, llm, whitelist, install, coder, base):
    install("small")
    client.put(f"{base}/models/small/load-config", headers=coder,
               json={"quantization": "4bit", "cpu": 8, "memory_gb": 32, "gpu_type": "gpu-shared", "gpu_count": 1})
    loaded = client.post(f"{base}/models/small/load", headers=coder).json()
    assert loaded["runtime"]["quantization"] == "4bit" and loaded["runtime"]["num_thread"] == 8
    status = client.get(f"{base}/models/small/runtime", headers=coder).json()
    assert status["loaded"] and status["config"]["quantization"] == status["runtime"]["quantization"] == "4bit"


def test_runtime_load_error_is_reported_and_audited(client, llm, whitelist, install, coder, base, session):
    class Broken:
        def load(self, request):
            raise RuntimeLoadError("這個模型沒有 GGUF 檔，無法以 Ollama 載入", invalid=True)

        def describe(self, name):
            return None
    llm.runtime = Broken()
    install("small")
    response = client.post(f"{base}/models/small/load", headers=coder)
    assert response.status_code == 422 and "GGUF" in response.text
    from app.models import AuditLog
    from sqlalchemy import select
    session.expire_all()
    assert session.scalars(select(AuditLog.result).where(AuditLog.action == "llm.model.load")).all() == ["failed"]


# ---------------------------------------------------------------- 提示詞工程與檢索增強：單獨與混合

def test_prompt_and_retrieval_alone_and_combined_are_recorded(client, llm, coder, base):
    from docs_support import FILES
    kb = client.post(f"{base}/knowledge-bases", headers=coder, json={"name": "門診"}).json()
    files = [("files", (name, data, "application/octet-stream")) for name, data in FILES.items()]
    client.post(f"{base}/knowledge-bases/{kb['id']}/documents", headers=coder, files=files)
    public = client.post(f"{base}/prompts", headers=coder, json={
        "title": "白話說明", "content": "請用白話回答：{input}", "visibility": "public"}).json()
    personal = client.post(f"{base}/prompts", headers=coder, json={
        "title": "條列", "content": "請條列重點：{input}", "visibility": "personal"}).json()
    cases = {"prompt": {"mode": "free", "prompt_id": public["id"]},
             "rag": {"mode": "kb", "kb_id": kb["id"]},
             "both": {"mode": "kb", "kb_id": kb["id"], "prompt_id": personal["id"]}}
    for label, body in cases.items():
        for i in range(3):
            answer = client.post(f"{base}/chat", headers=coder, json={**body, "message": f"門診時間？{label}{i}"})
            assert answer.status_code == 200, answer.text
            call = client.get(f"{base}/calls/{answer.json()['call_id']}", headers=coder).json()
            assert call["prompt_id"] == body.get("prompt_id")
            assert call["context_source"] == ("vector" if "kb_id" in body else "none")
            assert bool(call["context_refs"]) == ("kb_id" in body)


def test_nomic_embed_gets_task_prefixes():
    from app.llm.knowledge import _prefixed
    assert _prefixed("nomic-embed-text-v1.5", ["門診"], query=True) == ["search_query: 門診"]
    assert _prefixed("nomic-embed-text-v1.5", ["門診"], query=False) == ["search_document: 門診"]
    assert _prefixed("embeddinggemma-300m", ["門診"], query=True) == ["task: search result | query: 門診"]
    assert _prefixed("fake-embed-small", ["門診"], query=True) == ["門診"]
