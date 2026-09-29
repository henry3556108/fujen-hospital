"""推論後端。平台 API 不載入模型：模型在推論服務（platform/training 的 trainer.serve）內執行。

- HttpInferenceBackend  呼叫推論服務；服務重啟後查無模型時，由呼叫端重新推送模型再重試
- FakeInferenceBackend  記憶體假實作（單元測試、S0 smoke），結果由輸入內容決定，可重現
"""
from __future__ import annotations

import base64
import csv
import hashlib
import io
import json
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Protocol

import httpx

# 1×1 灰階 PNG，假實作的預覽圖
_PIXEL = ("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABc3UBGAAAAABJRU5ErkJggg==")


class InferenceError(Exception):
    status_code = 502


class InferenceUnavailable(InferenceError):
    status_code = 503


class InferenceRejected(InferenceError):
    """輸入資料無法推論（欄位不符、檔案無法解析）。"""
    status_code = 422


class ModelNotLoaded(InferenceError):
    pass


@dataclass(frozen=True)
class ImageInput:
    name: str
    data: bytes
    format: str          # dicom | nifti | itk | png | npy


class InferenceBackend(Protocol):
    def load(self, model_id: int, *, model: bytes, card: dict[str, Any], preprocess: bytes | None,
             schema: dict[str, Any] | None) -> None: ...
    def predict_tabular(self, model_id: int, data: bytes) -> dict[str, Any]: ...
    def predict_images(self, model_id: int, files: list[ImageInput]) -> dict[str, Any]: ...
    def unload(self, model_id: int) -> None: ...


def _pick(options: list, *parts: Any):
    digest = hashlib.sha256(json.dumps(parts, sort_keys=True, default=str).encode()).digest()
    return options[digest[0] % len(options)], digest[1] / 255


class FakeInferenceBackend:
    def __init__(self):
        self.models: dict[int, dict[str, Any]] = {}
        self.calls: list[tuple[str, int]] = []
        self.available = True

    def _check(self, model_id: int) -> dict[str, Any]:
        if not self.available:
            raise InferenceUnavailable("推論服務目前無法連線，請稍後再試")
        if model_id not in self.models:
            raise ModelNotLoaded(str(model_id))
        return self.models[model_id]

    def load(self, model_id, *, model, card, preprocess, schema):
        if not self.available:
            raise InferenceUnavailable("推論服務目前無法連線，請稍後再試")
        self.models[model_id] = {"card": card, "sha256": hashlib.sha256(model).hexdigest(), "schema": schema}
        self.calls.append(("load", model_id))

    def unload(self, model_id):
        self.models.pop(model_id, None)

    def predict_tabular(self, model_id, data):
        card = self._check(model_id)["card"]
        self.calls.append(("predict_tabular", model_id))
        rows = list(csv.DictReader(io.StringIO(data.decode("utf-8-sig"))))
        missing = [f for f in card.get("features", []) if rows and f not in rows[0]]
        if missing:
            raise InferenceRejected(f"資料缺少特徵欄位：{'、'.join(missing)}")
        predictions, notes = [], []
        for row in rows:
            if any(row.get(f, "") == "" for f in card.get("features", [])):
                predictions.append(None)
                notes.append("特徵含缺值，無法預測")
                continue
            if card["kind"] == "tabular_classification":
                predictions.append(_pick(card.get("classes") or ["0", "1"], row)[0])
            else:
                predictions.append(round(_pick([0], row)[1] * 100, 3))
            notes.append(None)
        return {"predictions": predictions, "notes": notes}

    def predict_images(self, model_id, files):
        card = self._check(model_id)["card"]
        self.calls.append(("predict_images", model_id))
        names = card.get("label_names") or ["class_1"]
        results = []
        for f in files:
            if not f.data:
                raise InferenceRejected(f"檔案「{f.name}」是空的")
            label, score = _pick(names, f.name, hashlib.sha256(f.data).hexdigest())
            result = {"name": f.name, "slice": 0, "preview": f"data:image/png;base64,{_PIXEL}"}
            if card["kind"] == "image_detection" and card.get("output") != "classification":
                result["boxes"] = [{"label": label, "score": round(score, 4), "bbox": [4.0, 4.0, 8.0, 8.0]}]
            elif card["kind"] == "image_segmentation" and card.get("output") != "classification":
                result["mask"] = {"background": round(1 - score / 2, 4), label: round(score / 2, 4)}
            else:
                result |= {"label": label, "scores": {n: round(score if n == label else (1 - score) / max(
                    len(names) - 1, 1), 4) for n in names}}
            results.append(result)
        return {"results": results}


class HttpInferenceBackend:
    def __init__(self, base_url: str, *, token: str, timeout: float = 120.0,
                 transport: httpx.BaseTransport | None = None):
        self._http = httpx.Client(base_url=base_url.rstrip("/"), timeout=timeout, transport=transport,
                                  headers={"X-Admin-Token": token})

    def _call(self, method: str, path: str, **kwargs) -> httpx.Response:
        try:
            response = self._http.request(method, path, **kwargs)
        except httpx.HTTPError as exc:
            raise InferenceUnavailable(f"推論服務目前無法連線（{type(exc).__name__}），請稍後再試") from exc
        if response.status_code < 400:
            return response
        try:
            detail = response.json().get("detail")
        except ValueError:
            detail = response.text[:200]
        if response.status_code == 404 and isinstance(detail, dict) and detail.get("code") == "model_not_loaded":
            raise ModelNotLoaded(path)
        message = detail.get("message") if isinstance(detail, dict) else detail
        if response.status_code in (400, 413, 415, 422):
            raise InferenceRejected(str(message))
        if response.status_code >= 500:
            raise InferenceError(f"推論服務發生錯誤：{message}")
        raise InferenceError(f"推論服務回應 {response.status_code}：{message}")

    def load(self, model_id, *, model, card, preprocess, schema):
        files = {"model": ("model", model, "application/octet-stream")}
        if preprocess is not None:
            files["preprocess"] = ("preprocess.pkl", preprocess, "application/octet-stream")
        data = {"card": json.dumps(card, ensure_ascii=False)}
        if schema is not None:
            data["schema"] = json.dumps(schema, ensure_ascii=False)
        self._call("PUT", f"/admin/models/{model_id}", files=files, data=data)

    def unload(self, model_id):
        self._call("DELETE", f"/admin/models/{model_id}")

    def predict_tabular(self, model_id, data):
        return self._call("POST", f"/models/{model_id}/predict/tabular", content=data,
                          headers={"Content-Type": "text/csv"}).json()

    def predict_images(self, model_id, files):
        parts = [("files", (f.name, f.data, "application/octet-stream")) for f in files]
        return self._call("POST", f"/models/{model_id}/predict/images", files=parts,
                          data={"formats": json.dumps([f.format for f in files])}).json()


def inference_from_env(env: Mapping[str, str]) -> InferenceBackend | None:
    """INFERENCE_URL 未設定時回 None（推論端點回 503）；INFERENCE_BACKEND=fake 供前端開發用。"""
    if env.get("INFERENCE_BACKEND", "").lower() == "fake":
        return FakeInferenceBackend()
    if env.get("INFERENCE_URL"):
        return HttpInferenceBackend(env["INFERENCE_URL"], token=env.get("INFERENCE_ADMIN_TOKEN", ""))
    return None


def decode_preview(value: str) -> bytes:
    return base64.b64decode(value.split(",", 1)[1])
