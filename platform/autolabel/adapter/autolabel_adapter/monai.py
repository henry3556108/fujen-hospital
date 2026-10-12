"""MONAI Label HTTP API（0.8）：GET /info/、POST /infer/{model}（上傳影像檔，回傳標籤檔）。"""
from __future__ import annotations

import httpx


class MonaiUnavailable(Exception):
    """連不到 MONAI Label、逾時或回錯誤（對平台回 503）。"""


class MonaiLabel:
    def __init__(self, base_url: str, *, timeout: float = 60.0, client: httpx.Client | None = None):
        self._client = client or httpx.Client(base_url=base_url.rstrip("/"), timeout=timeout)

    def _request(self, method: str, path: str, **kwargs) -> httpx.Response:
        try:
            response = self._client.request(method, path, **kwargs)
        except httpx.HTTPError as exc:
            raise MonaiUnavailable(f"MONAI Label 無法連線：{type(exc).__name__}") from exc
        if response.status_code >= 400:
            raise MonaiUnavailable(f"MONAI Label 回應 HTTP {response.status_code}：{response.text[:200]}")
        return response

    def info(self) -> dict:
        try:
            return self._request("GET", "/info/").json()
        except ValueError as exc:
            raise MonaiUnavailable("MONAI Label 的 /info/ 不是 JSON") from exc

    def infer_volume(self, model: str, nifti: bytes) -> bytes:
        """上傳未壓縮 NIfTI，取回原影像空間的標籤 NIfTI（output=image）。"""
        response = self._request(
            "POST", f"/infer/{model}", params={"output": "image"},
            files={"file": ("image.nii", nifti, "application/octet-stream")},
            data={"params": "{}"})
        return response.content
