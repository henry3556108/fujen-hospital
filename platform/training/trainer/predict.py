"""載入 H5／pkl 並預測。推論服務與平台外的載入腳本共用。"""
from __future__ import annotations

import base64
import io
import pickle
import sys
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent / "templates"))
import imagekit  # noqa: E402
import tabularkit  # noqa: E402
from tabular.schema import Schema  # noqa: E402
from tabular.validate import validate_and_load  # noqa: E402


class InputError(ValueError):
    """輸入資料無法推論（422）。"""


class TabularPredictor:
    def __init__(self, model: bytes, preprocess: bytes, card: dict, schema: dict | None):
        self.model, self.preprocess, self.card = pickle.loads(model), pickle.loads(preprocess), card
        self.schema = Schema.from_dict(schema) if schema else None

    def _frame(self, data: bytes) -> pd.DataFrame:
        if self.schema is None:
            return pd.read_csv(io.BytesIO(data))
        # 推論資料只需要模型用到的欄位：其餘欄位（目標欄、病歷號…）驗證時視為非必填
        needed = set(tabularkit.needed_columns(self.preprocess))
        columns = [c.__dict__ if c.name in needed else {**c.__dict__, "required": False, "unique": False}
                   for c in self.schema.columns]
        schema = Schema.from_dict({"columns": columns})
        report, frame = validate_and_load(io.BytesIO(data), schema)
        if report["errors"]:
            raise InputError(report["errors"][0]["message"])
        if report["rejected_row_count"]:
            first = report["rejected"][0]
            raise InputError(f"第 {first['row'] + 1} 筆資料不符合欄位規格：{first['errors'][0]['message']}")
        return frame

    def predict(self, data: bytes) -> dict[str, Any]:
        frame = self._frame(data)
        missing = [c for c in tabularkit.needed_columns(self.preprocess) if c not in frame.columns]
        if missing:
            raise InputError(f"資料缺少特徵欄位：{'、'.join(missing)}")
        predictions, notes, probabilities = tabularkit.predict_frame(self.model, self.preprocess, frame,
                                                                     with_probability=True)
        answer = {"predictions": predictions, "notes": notes}
        if any(p is not None for p in probabilities):
            answer["probabilities"] = probabilities     # 分類：預測類別的機率
        return answer


def _png(image: np.ndarray) -> str:
    from PIL import Image

    pixels = (np.clip(image, 0, 1) * 255).astype("uint8")
    buffer = io.BytesIO()
    Image.fromarray(pixels, mode="L").save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode()


class ImagePredictor:
    def __init__(self, model_path: Path, card: dict):
        imagekit.keras_setup(0)
        import keras

        self.model = keras.models.load_model(model_path, compile=False)
        self.card = card
        self.size = tuple(card.get("input", {}).get("resize", (32, 32)))
        self.names = card.get("label_names") or []

    def predict(self, files: list[tuple[str, bytes, str]]) -> dict[str, Any]:
        samples = []
        for name, data, fmt in files:
            try:
                slices = imagekit.read_slices(data, fmt)
            except Exception as exc:  # noqa: BLE001
                raise InputError(f"檔案「{name}」無法解析為 {fmt}：{type(exc).__name__}") from exc
            for index, image in enumerate(slices):
                samples.append((name, index, imagekit.prepare_image(image, self.size)))
        if not samples:
            raise InputError("沒有可推論的影像")
        batch = np.stack([s[2] for s in samples])[..., None].astype("float32")
        out = self.model.predict(batch, verbose=0)
        results = []
        for i, (name, index, image) in enumerate(samples):
            result = {"name": name, "slice": index, "preview": _png(image)}
            kind, output = self.card["kind"], self.card.get("output")
            if isinstance(out, dict):                                  # 物件偵測
                result["boxes"] = self._boxes(out["box"][i], out["label"][i])
            elif out.ndim == 4:                                        # 分割：每類像素比例
                mask = out[i].argmax(axis=-1)
                names = ["background", *self.names]
                result["mask"] = {names[c]: round(float((mask == c).mean()), 4) for c in range(out.shape[-1])}
            else:
                names = self.names if len(self.names) == out.shape[1] else [f"class_{k}" for k in range(out.shape[1])]
                scores = {n: round(float(v), 4) for n, v in zip(names, out[i])}
                result |= {"label": max(scores, key=scores.get), "scores": scores}
            if kind != "image_classification" and output == "classification":
                result["note"] = "fake-trainer 模型，僅輸出分類分數"
            results.append(result)
        return {"results": results}

    def _boxes(self, boxes: np.ndarray, labels: np.ndarray) -> list[dict]:
        h, w = self.size
        out = []
        for box, probs in zip(boxes, labels):
            k = int(probs.argmax())
            if k == 0:
                continue
            x, y, bw, bh = (float(v) for v in box)
            out.append({"label": self.names[k - 1], "score": round(float(probs[k]), 4),
                        "bbox": [x * w, y * h, bw * w, bh * h]})
        return out
