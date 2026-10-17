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


# 推論服務只載入這些套件的類別（平台範本產生的 model.pkl、preprocess.pkl 都只用到這些）。
# 使用者修改過的訓練程式可以寫出任意 pkl；直接 pickle.loads 等於在推論服務內執行它的程式，所以限制類別。
SAFE_MODULES = ("numpy", "pandas", "scipy", "sklearn", "tabular")
# 標準函式庫只放行重建資料結構需要的
SAFE_GLOBALS = {("copyreg", "_reconstructor"), ("copyreg", "__newobj__"), ("collections", "OrderedDict"),
                ("collections", "defaultdict"), ("_codecs", "encode"), ("datetime", "datetime"),
                ("datetime", "date"), ("datetime", "timedelta"), ("datetime", "timezone"), ("functools", "partial")}
SAFE_BUILTINS = {"object", "set", "frozenset", "slice", "complex", "range", "bytearray", "dict", "list", "tuple",
                 "int", "float", "str", "bool", "bytes", "type"}
# 允許的套件內，可以讀寫檔案、連網路、執行程式或再反序列化的部分一律不放行
_UNSAFE_PARTS = {"io", "testing", "f2py", "distutils", "ctypeslib", "_pytesttester", "conftest", "_config",
                 "externals", "parallel", "joblib"}
_UNSAFE_NAMES = ("read", "load", "save", "open", "eval", "exec", "system", "popen", "compile", "import", "to_pickle",
                 "from_file", "fromfile", "tofile", "getattr", "setattr", "__import__")


class UnsafeModel(pickle.UnpicklingError):
    """模型檔引用了平台不允許的類別：不能在平台推論或部署。"""


def allowed_global(module: str, name: str) -> bool:
    if (module, name) in SAFE_GLOBALS:
        return True
    if module == "builtins":
        return name in SAFE_BUILTINS
    parts = module.split(".")
    if parts[0] not in SAFE_MODULES or _UNSAFE_PARTS & set(parts):
        return False
    lowered = name.lower()
    return not any(lowered.startswith(word) or f"_{word}" in lowered for word in _UNSAFE_NAMES)


class SafeUnpickler(pickle.Unpickler):
    def find_class(self, module: str, name: str):
        if not allowed_global(module, name):
            raise UnsafeModel(f"模型檔引用了平台不允許的類別「{module}.{name}」：使用自訂程式的模型不能在平台推論或部署，"
                              "請下載後在平台外使用")
        return super().find_class(module, name)


def safe_loads(data: bytes) -> Any:
    """限制類別的 pickle.loads：只允許 numpy、pandas、scipy、scikit-learn、tabular 的類別。"""
    return SafeUnpickler(io.BytesIO(data)).load()


def h5_reason(path: Path) -> str | None:
    """H5 模型能不能在平台載入：含 Lambda 層或非 Keras 內建的層（自訂程式）時回傳原因。
    只讀 model_config（JSON），不建立模型，不會執行檔案內的程式。"""
    import json

    import h5py

    try:
        with h5py.File(path, "r") as fh:
            raw = fh.attrs.get("model_config")
    except Exception as exc:  # noqa: BLE001
        return f"不是可讀取的 H5：{type(exc).__name__}"
    if raw is None:
        return "H5 內沒有 model_config"
    text = raw.decode("utf-8") if isinstance(raw, bytes) else str(raw)
    found: list[str] = []

    def walk(node):
        if isinstance(node, dict):
            if node.get("class_name") == "Lambda":
                found.append("Lambda 層")
            module = node.get("module")
            if isinstance(module, str) and module.split(".")[0] not in ("keras", "builtins", "numpy"):
                found.append(f"自訂類別（{module}）")
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    walk(json.loads(text))
    return f"模型含有{'、'.join(sorted(set(found)))}" if found else None


def model_check(out_dir: Path) -> dict[str, Any]:
    """訓練結束時（runner 內）檢查模型能不能在平台推論或部署，結果寫進模型卡的 deployable。
    pkl 用限制類別的 Unpickler 實際載入（被擋下的類別不會被建立）；H5 只讀模型結構。"""
    out_dir = Path(out_dir)
    reasons = []
    for name in ("model.pkl", "preprocess.pkl"):
        if (out_dir / name).is_file():
            try:
                safe_loads((out_dir / name).read_bytes())
            except UnsafeModel as exc:
                reasons.append(f"{name}：{str(exc).split('：')[0]}")
            except Exception as exc:  # noqa: BLE001
                reasons.append(f"{name}：無法載入（{type(exc).__name__}）")
    if (out_dir / "model.h5").is_file():
        reason = h5_reason(out_dir / "model.h5")
        if reason:
            reasons.append(f"model.h5：{reason}")
    if not reasons:
        return {"deployable": True}
    return {"deployable": False,
            "deploy_blocked": "自訂程式產生的模型，不能在平台推論或部署，可以下載在平台外使用（" + "；".join(reasons) + "）"}


class TabularPredictor:
    def __init__(self, model: bytes, preprocess: bytes, card: dict, schema: dict | None):
        self.model, self.preprocess, self.card = safe_loads(model), safe_loads(preprocess), card
        self.schema = Schema.from_dict(schema) if schema else None

    def _frame(self, data: bytes) -> pd.DataFrame:
        if self.schema is None:
            return pd.read_csv(io.BytesIO(data))
        # 推論資料只需要模型用到的欄位：其餘欄位（目標欄、病歷號…）驗證時視為非必填
        needed = set(tabularkit.needed_columns(self.preprocess))
        # 補值的模型：特徵可以空白（以訓練資料的中位數或最常見的值補上）
        fills = self.preprocess.get("missing") == "impute"
        columns = [c.__dict__ if c.name in needed and not fills else
                   {**c.__dict__, "required": False, "unique": c.unique and c.name in needed}
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

        reason = h5_reason(Path(model_path))
        if reason:
            raise UnsafeModel(f"{reason}：使用自訂程式的模型不能在平台推論或部署，請下載後在平台外使用")
        self.model = keras.models.load_model(model_path, compile=False, safe_mode=True)
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
