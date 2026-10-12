"""模型執行環境：載入、卸載。

- OllamaModelRuntime：把下載好的 GGUF 檔推進 Ollama 建立模型並常駐（LLM_RUNTIME=ollama）。
  量化：4bit 用 Q4 檔、8bit 用 Q8 檔；repo 只有 f16／bf16 時由 Ollama 載入時量化。
  CPU 對應 num_thread；GPU 類型 cpu 時 num_gpu=0（全部在 CPU），其他類型全部層數放 GPU。
  記憶體與 GPU 張數由 Ollama 服務本身的容器資源決定（部署設定），這裡只記錄。
- RecordingModelRuntime：只記錄設定，不載入任何權重（單元測試、未接模型服務的開發環境）。
"""
import json
import os
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

import httpx

from app.llm.sources import file_sha256

DIGESTS_SUFFIX = ".digests.json"   # 安裝時在模型資料夾旁寫入：檔名 → sha256，載入時不必重算
QUANT_PATTERNS = {
    "4bit": re.compile(r"(^|[-_.])I?Q4(_|\.|$)", re.I),
    "8bit": re.compile(r"(^|[-_.])Q8(_|\.|$)", re.I),
    "none": re.compile(r"(^|[-_.])(f16|bf16|f32)(\.|$)", re.I),
}
OLLAMA_QUANTIZE = {"4bit": "q4_K_M", "8bit": "q8_0"}


class RuntimeLoadError(Exception):
    """載入失敗。invalid=True 代表設定或模型內容不符（422），否則是服務問題（503）。"""

    def __init__(self, message: str, *, invalid: bool = False):
        super().__init__(message)
        self.invalid = invalid


@dataclass(frozen=True)
class LoadRequest:
    name: str
    location: str
    quantization: str
    cpu: int
    memory_gb: int
    gpu_type: str
    gpu_count: int
    trust_remote_code: bool


class ModelRuntime(Protocol):
    def load(self, request: LoadRequest) -> None: ...
    def unload(self, name: str) -> None: ...
    def loaded(self) -> list[LoadRequest]: ...
    def describe(self, name: str) -> dict | None: ...


@dataclass
class RecordingModelRuntime:
    _loaded: dict[str, LoadRequest] = field(default_factory=dict)

    def load(self, request: LoadRequest) -> None:
        self._loaded[request.name] = request

    def unload(self, name: str) -> None:
        self._loaded.pop(name, None)

    def loaded(self) -> list[LoadRequest]:
        return list(self._loaded.values())

    def describe(self, name: str) -> dict | None:
        request = self._loaded.get(name)
        if request is None:
            return None
        return {"name": name, "running": True, "quantization": request.quantization, "num_thread": request.cpu,
                "processor": "cpu" if request.gpu_type == "cpu" else "gpu", "runtime": "recording"}


def digests_path(folder: Path) -> Path:
    return folder.with_name(folder.name + DIGESTS_SUFFIX)


def write_digests(folder: Path, digests: Mapping[str, str]) -> None:
    digests_path(folder).write_text(json.dumps(dict(digests), indent=1, sort_keys=True))


def _digest(folder: Path, name: str) -> str:
    try:
        known = json.loads(digests_path(folder).read_text())
    except (OSError, ValueError):
        known = {}
    return known.get(name) or file_sha256(folder / name)


def pick_gguf(folder: Path, quantization: str) -> tuple[Path, str | None]:
    """回傳（要載入的 GGUF 檔、交給 Ollama 載入時量化的方式）。視覺模型的投影檔（mmproj）不算。"""
    ggufs = sorted(p for p in folder.rglob("*.gguf") if not p.name.lower().startswith("mmproj"))
    if not ggufs:
        raise RuntimeLoadError("這個模型沒有 GGUF 檔，無法以 Ollama 載入", invalid=True)
    matches = [p for p in ggufs if QUANT_PATTERNS[quantization].search(p.stem)]
    if matches:
        return matches[0], None
    full = [p for p in ggufs if QUANT_PATTERNS["none"].search(p.stem)]
    if full and quantization in OLLAMA_QUANTIZE:
        return full[0], OLLAMA_QUANTIZE[quantization]
    if len(ggufs) == 1 and quantization == "none":
        return ggufs[0], None
    available = "、".join(p.name for p in ggufs)
    label = {"4bit": "4-bit", "8bit": "8-bit", "none": "不量化"}[quantization]
    raise RuntimeLoadError(f"這個模型沒有 {label} 的版本（現有：{available}）", invalid=True)


class OllamaModelRuntime:
    def __init__(self, base_url: str, *, http: httpx.Client | None = None, timeout: float = 600.0):
        self.base_url = base_url.rstrip("/")
        self._http = http or httpx.Client(timeout=httpx.Timeout(timeout, connect=10.0))
        self._requests: dict[str, LoadRequest] = {}

    def _post(self, path: str, body: dict, *, what: str) -> dict:
        try:
            response = self._http.post(f"{self.base_url}{path}", json=body)
        except httpx.TransportError:
            raise RuntimeLoadError("連不上模型服務（Ollama）")
        if response.status_code >= 400:
            try:
                message = response.json().get("error") or response.text
            except ValueError:
                message = response.text
            raise RuntimeLoadError(f"{what}失敗：{str(message)[:200]}", invalid=response.status_code < 500)
        return response.json() if response.content else {}

    def _push_blob(self, path: Path, digest: str) -> None:
        url = f"{self.base_url}/api/blobs/sha256:{digest}"
        try:
            if self._http.head(url).status_code == 200:
                return
            with path.open("rb") as f:
                response = self._http.post(url, content=iter(lambda: f.read(8 * 1024 * 1024), b""))
        except httpx.TransportError:
            raise RuntimeLoadError("上傳模型檔到 Ollama 時連線中斷")
        if response.status_code >= 400:
            raise RuntimeLoadError(f"上傳模型檔到 Ollama 失敗（{response.status_code}）")

    def capabilities(self, name: str) -> list[str]:
        try:
            response = self._http.post(f"{self.base_url}/api/show", json={"model": name})
        except httpx.TransportError:
            return []
        return response.json().get("capabilities", []) if response.status_code == 200 else []

    def load(self, request: LoadRequest) -> None:
        folder = Path(request.location)
        gguf, quantize = pick_gguf(folder, request.quantization)
        digest = _digest(folder, gguf.relative_to(folder).as_posix())
        self._push_blob(gguf, digest)
        gpu = request.gpu_type != "cpu"
        body = {"model": request.name, "files": {gguf.name: f"sha256:{digest}"}, "stream": False,
                "parameters": {"num_thread": request.cpu, "num_gpu": 999 if gpu else 0}}
        if quantize:
            body["quantize"] = quantize
        self._post("/api/create", body, what="建立模型")
        # 預先載入並常駐（keep_alive=-1），第一則對話不必等載入
        if "embedding" in self.capabilities(request.name):
            self._post("/api/embed", {"model": request.name, "input": ["warm-up"], "keep_alive": -1}, what="載入模型")
        else:
            self._post("/api/generate", {"model": request.name, "keep_alive": -1}, what="載入模型")
        self._requests[request.name] = request

    def unload(self, name: str) -> None:
        caps = self.capabilities(name)
        if not caps:
            self._requests.pop(name, None)
            return
        if "embedding" in caps:
            self._post("/api/embed", {"model": name, "input": [], "keep_alive": 0}, what="卸載模型")
        else:
            self._post("/api/generate", {"model": name, "keep_alive": 0}, what="卸載模型")
        try:
            self._http.request("DELETE", f"{self.base_url}/api/delete", json={"model": name})
        except httpx.TransportError:
            pass
        self._requests.pop(name, None)

    def loaded(self) -> list[LoadRequest]:
        running = {m["name"].removesuffix(":latest") for m in self._ps()}
        return [r for n, r in self._requests.items() if n in running]

    def _ps(self) -> list[dict]:
        try:
            response = self._http.get(f"{self.base_url}/api/ps")
        except httpx.TransportError:
            return []
        return response.json().get("models", []) if response.status_code == 200 else []

    def describe(self, name: str) -> dict | None:
        """Ollama 實際的載入狀態：量化等級、執行緒數、GPU 層數、在 GPU 或 CPU、佔用的顯示記憶體。"""
        try:
            response = self._http.post(f"{self.base_url}/api/show", json={"model": name})
        except httpx.TransportError:
            raise RuntimeLoadError("連不上模型服務（Ollama）")
        if response.status_code != 200:
            return None
        show = response.json()
        params = {}
        for line in (show.get("parameters") or "").splitlines():
            key, _, value = line.strip().partition(" ")
            params[key] = value.strip()
        running = next((m for m in self._ps() if m["name"].removesuffix(":latest") == name), None)
        details = show.get("details") or {}
        return {"name": name, "running": running is not None,
                "quantization_level": details.get("quantization_level"),
                "parameter_size": details.get("parameter_size"), "family": details.get("family"),
                "capabilities": show.get("capabilities", []),
                "num_thread": int(params["num_thread"]) if params.get("num_thread", "").isdigit() else None,
                "num_gpu": int(params["num_gpu"]) if params.get("num_gpu", "").isdigit() else None,
                "processor": ("gpu" if running.get("size_vram") else "cpu") if running else None,
                "vram_bytes": running.get("size_vram") if running else None, "runtime": "ollama"}


def runtime_from_env(env: Mapping[str, str] = os.environ) -> ModelRuntime:
    """LLM_RUNTIME=ollama 時以 OLLAMA_URL（預設取 LLM_BASE_URL）載入真模型；其他情況只記錄設定。"""
    if env.get("LLM_RUNTIME", "").strip().lower() == "ollama":
        url = env.get("OLLAMA_URL") or env.get("LLM_BASE_URL", "")
        return OllamaModelRuntime(re.sub(r"/v1/?$", "", url.strip()))
    return RecordingModelRuntime()
