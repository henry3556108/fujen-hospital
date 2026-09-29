"""結構式訓練範本共用：讀凍結的 CSV、切分、在訓練資料上擬合前處理、評估、寫出 pkl。

model.pkl 只含 scikit-learn 原生物件，平台外只要有 scikit-learn 就能載入：

    import pickle, pandas as pd
    model = pickle.load(open("model.pkl", "rb"))
    model.predict(pd.DataFrame(rows, columns=model.feature_names_in_))

輸入必須是「前處理後」的特徵欄位（欄位名稱見 model.feature_names_in_ 或 model_card.json）。
平台上的推論會先套用 preprocess.pkl（在訓練資料上擬合的前處理），所以可以直接上傳原始 CSV。
"""
from __future__ import annotations

import io
import pickle
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from tabular.errors import TabularError
from tabular.fitted import FittedPipeline, fit_pipeline
from tabular.schema import Schema
from tabular.validate import load_clean_csv

import runtime

LIBRARIES = ["scikit-learn", "pandas", "numpy"]


def load_frame(data_dir: Path, manifest: dict) -> pd.DataFrame:
    files = manifest["items"][0]["files"]
    schema = Schema.from_dict(runtime.load_config(runtime.blob_path(data_dir, files["schema"])))
    return load_clean_csv(io.BytesIO(runtime.blob_path(data_dir, files["csv"]).read_bytes()), schema)


def feature_matrix(frame: pd.DataFrame, features: list[str]) -> pd.DataFrame:
    missing = [c for c in features if c not in frame.columns]
    if missing:
        raise TabularError(f"前處理後找不到特徵欄位：{'、'.join(missing)}", code="column_not_found")
    x = frame[features]
    bad = [c for c in features if not (pd.api.types.is_numeric_dtype(x[c]) or pd.api.types.is_bool_dtype(x[c]))]
    if bad:
        raise TabularError(f"特徵欄位「{'、'.join(bad)}」不是數值，請先做類別編碼（例如 One-Hot）",
                           code="column_not_numeric")
    return x.astype("float64")


def usable_rows(x: pd.DataFrame, y: pd.Series | None = None) -> pd.Series:
    ok = x.notna().all(axis=1)
    return ok & y.notna() if y is not None else ok


def prepare(config: dict, data_dir: Path) -> dict[str, Any]:
    """回傳各切分前處理後的 (X, y)、擬合好的前處理、切分的列索引。"""
    manifest = runtime.load_manifest(data_dir)
    spec = config["tabular"]
    frame = load_frame(data_dir, manifest)
    rows = runtime.split_rows(len(frame), config["split"], int(config["seed"]))
    fitted, train_out = fit_pipeline(frame.iloc[rows["train"]].reset_index(drop=True), spec.get("steps") or [])
    parts = {"train": train_out}
    for name in ("validation", "test"):
        parts[name] = fitted.transform(frame.iloc[rows[name]].reset_index(drop=True))
    data = {}
    for name, part in parts.items():
        if spec["target"] not in part.columns:
            raise TabularError(f"前處理後找不到目標欄位「{spec['target']}」", code="column_not_found")
        x, y = feature_matrix(part, spec["features"]), part[spec["target"]]
        keep = usable_rows(x, y)
        data[name] = (x[keep].reset_index(drop=True), y[keep].reset_index(drop=True), int((~keep).sum()))
    if len(data["train"][0]) < 2:
        raise TabularError("訓練資料去掉含缺值的列後不足 2 筆", code="not_enough_rows")
    return {"manifest": manifest, "fitted": fitted, "rows": rows, "data": data, "frame_rows": len(frame)}


def save(out_dir: Path, *, config: dict, prepared: dict, model: Any, metrics: dict, card: dict) -> dict:
    out_dir = Path(out_dir)
    with open(out_dir / "model.pkl", "wb") as fh:
        pickle.dump(model, fh, protocol=4)
    spec = config["tabular"]
    with open(out_dir / "preprocess.pkl", "wb") as fh:
        pickle.dump({"pipeline": prepared["fitted"], "target": spec["target"], "features": spec["features"]},
                    fh, protocol=4)
    dropped = {name: part[2] for name, part in prepared["data"].items()}
    return runtime.finish(
        out_dir, config=config, manifest=prepared["manifest"], model_file="model.pkl", model_format="pkl",
        metrics=metrics, splits={"unit": "row", **prepared["rows"]},
        card={"target": spec["target"], "features": spec["features"], "algorithm": spec["algorithm"],
              "rows": {"total": prepared["frame_rows"], "dropped_for_missing": dropped}, **card},
        libraries=LIBRARIES)


def predict_frame(model: Any, preprocess: dict, frame: pd.DataFrame) -> tuple[list, list[str | None]]:
    """推論：套用訓練時擬合的前處理再預測。含缺值而無法預測的列回傳 None 與原因，不會少列。"""
    pipeline: FittedPipeline = preprocess["pipeline"]
    out = pipeline.transform(frame, optional=[preprocess["target"]])
    if len(out) != len(frame):
        raise TabularError("前處理改變了列數，無法對回原始資料", code="row_count_changed")
    x = feature_matrix(out, preprocess["features"])
    ok = usable_rows(x).to_numpy()
    predictions: list = [None] * len(frame)
    notes: list[str | None] = [None if good else "特徵含缺值，無法預測" for good in ok]
    if ok.any():
        values = model.predict(x[ok])
        for position, value in zip(np.flatnonzero(ok), values):
            predictions[position] = value.item() if hasattr(value, "item") else value
    return predictions, notes
