"""自動標註服務的介面。平台只經由 AutolabelClient 呼叫第三方工具。

- HttpAutolabel：MONAI Label HTTP API 子集（開發機接 platform/fakes 的 fake-autolabel）。
- InMemoryAutolabel：單元測試用，可模擬離線與不合規格的回應。
"""
import hashlib
from collections.abc import Mapping
from typing import Protocol

import httpx

from app.labeling import formats


class AutolabelUnavailable(Exception):
    """無法連線、逾時或服務回 5xx。"""


class AutolabelRejected(Exception):
    """服務拒絕這次請求（4xx）。"""


class AutolabelClient(Protocol):
    def info(self) -> dict: ...
    def infer(self, model: str, image_id: str) -> dict: ...


class HttpAutolabel:
    def __init__(self, base_url: str, *, timeout: float = 25.0, client: httpx.Client | None = None):
        self._client = client or httpx.Client(base_url=base_url.rstrip("/"), timeout=timeout)

    def _call(self, method: str, path: str, **kwargs) -> dict:
        try:
            response = self._client.request(method, path, **kwargs)
        except httpx.HTTPError as exc:      # 連線失敗、逾時、DNS…
            raise AutolabelUnavailable(type(exc).__name__) from exc
        if response.status_code >= 500:
            raise AutolabelUnavailable(f"HTTP {response.status_code}")
        if response.status_code >= 400:
            raise AutolabelRejected(f"HTTP {response.status_code}")
        try:
            return response.json()
        except ValueError as exc:
            raise formats.FormatError("自動標註服務的回應不是 JSON") from exc

    def info(self) -> dict:
        return self._call("GET", formats.INFO_PATH)

    def infer(self, model: str, image_id: str) -> dict:
        return self._call("POST", formats.INFER_PATH.format(model=model), params={formats.IMAGE_PARAM: image_id})


class InMemoryAutolabel:
    """結果只由（模型, 影像 ID）決定，可重現。"""
    MODELS = {
        "mem_segmentation": {"type": "segmentation", "labels": ["lung", "nodule"], "dimension": 2,
                             "description": "記憶體版分割"},
        "mem_detection": {"type": "detection", "labels": ["lung", "nodule"], "dimension": 2,
                          "description": "記憶體版偵測"},
    }

    def __init__(self, *, size: int = 8):
        self.size = size
        self.offline = False
        self.corrupt = False        # 回傳不合規格的結果
        self.empty_detection = False
        self.calls: list[tuple[str, str]] = []

    def info(self) -> dict:
        if self.offline:
            raise AutolabelUnavailable("offline")
        return {"name": "in-memory-autolabel", "version": "0", "labels": ["lung", "nodule"],
                "models": {k: dict(v) for k, v in self.MODELS.items()}}

    def infer(self, model: str, image_id: str) -> dict:
        self.calls.append((model, image_id))
        if self.offline:
            raise AutolabelUnavailable("offline")
        if model not in self.MODELS:
            raise AutolabelRejected("HTTP 404")
        seed = hashlib.sha256(f"{model}\x00{image_id}".encode()).digest()
        n = self.size
        base = {"model": model, "image": image_id, "shape": [n, n]}
        if self.MODELS[model]["type"] == "segmentation":
            lung = 1 + seed[0] % (n * n - 2)
            rle = [[0, n * n - lung - 1], [1, lung], [2, 1]]
            if self.corrupt:
                rle = rle[:-1]      # 長度總和不對
            return {**base, "encoding": "rle", "rle": rle, "label_names": {"background": 0, "lung": 1, "nodule": 2}}
        x = seed[1] % (n - 2)
        boxes = [] if self.empty_detection else [{"label": "nodule", "box": [x, 1, x + 2, 4], "score": 0.8}]
        if self.corrupt:
            boxes = [{"label": "nodule", "box": [x, 1, n + 5, 4]}]
        return {**base, "box_format": "xyxy", "boxes": boxes}


def autolabel_from_env(env: Mapping[str, str]) -> AutolabelClient | None:
    """AUTOLABEL_URL 未設定時回 None（自動標註端點回 503）。"""
    url = env.get("AUTOLABEL_URL", "").strip()
    if not url:
        return None
    return HttpAutolabel(url, timeout=float(env.get("AUTOLABEL_TIMEOUT_SECONDS") or 25))
