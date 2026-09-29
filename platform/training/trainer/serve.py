"""推論服務。只給平台 API 呼叫：不對主機開放連接埠、沒有 Gateway 路由。

平台 API 以 X-Admin-Token 推送模型（PUT /admin/models/{id}）與呼叫預測。模型只放在記憶體與本機暫存，
服務重啟後由平台 API 重新推送（查無模型時回 404 model_not_loaded）。
"""
from __future__ import annotations

import hmac
import json
import os
import tempfile
import threading
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Request, UploadFile

from trainer.predict import ImagePredictor, InputError, TabularPredictor

app = FastAPI(title="Platform inference service")
_models: dict[int, Any] = {}
_lock = threading.Lock()
_dir = Path(tempfile.mkdtemp(prefix="models-"))


def check_token(x_admin_token: str | None = Header(default=None)) -> None:
    expected = os.environ.get("INFERENCE_ADMIN_TOKEN", "")
    if not expected or not hmac.compare_digest(x_admin_token or "", expected):
        raise HTTPException(401, "推論服務憑證無效")


def _model(model_id: int):
    with _lock:
        model = _models.get(model_id)
    if model is None:
        raise HTTPException(404, {"code": "model_not_loaded", "message": f"模型 {model_id} 尚未載入"})
    return model


@app.get("/healthz")
def healthz() -> dict:
    return {"status": "ok", "models": sorted(_models)}


@app.put("/admin/models/{model_id}", dependencies=[Depends(check_token)])
def load(model_id: int, model: UploadFile = File(...), card: str = Form(...), schema: str | None = Form(None),
         preprocess: UploadFile | None = File(None)) -> dict:
    card_data = json.loads(card)
    data = model.file.read()
    try:
        if card_data["format"] == "pkl":
            if preprocess is None:
                raise HTTPException(422, "結構式模型需要 preprocess.pkl")
            predictor = TabularPredictor(data, preprocess.file.read(), card_data,
                                         json.loads(schema) if schema else None)
        else:
            path = _dir / f"{model_id}.h5"
            path.write_bytes(data)
            predictor = ImagePredictor(path, card_data)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(422, f"模型無法載入：{type(exc).__name__}: {exc}") from exc
    with _lock:
        _models[model_id] = predictor
    return {"model_id": model_id, "kind": card_data["kind"]}


@app.delete("/admin/models/{model_id}", dependencies=[Depends(check_token)])
def unload(model_id: int) -> dict:
    with _lock:
        _models.pop(model_id, None)
    return {"model_id": model_id}


@app.post("/models/{model_id}/predict/tabular", dependencies=[Depends(check_token)])
async def predict_tabular(model_id: int, request: Request) -> dict:
    predictor = _model(model_id)
    if not isinstance(predictor, TabularPredictor):
        raise HTTPException(422, "這是影像模型，請改用影像推論")
    try:
        return predictor.predict(await request.body())
    except InputError as exc:
        raise HTTPException(422, str(exc)) from exc


@app.post("/models/{model_id}/predict/images", dependencies=[Depends(check_token)])
def predict_images(model_id: int, files: list[UploadFile] = File(...), formats: str = Form(...)) -> dict:
    predictor = _model(model_id)
    if not isinstance(predictor, ImagePredictor):
        raise HTTPException(422, "這是結構式模型，請改用 CSV 推論")
    kinds = json.loads(formats)
    try:
        return predictor.predict([(f.filename or "upload", f.file.read(), k) for f, k in zip(files, kinds)])
    except InputError as exc:
        raise HTTPException(422, str(exc)) from exc
