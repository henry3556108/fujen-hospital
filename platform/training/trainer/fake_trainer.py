"""fake-trainer：不訓練，睡幾秒後寫出隨機初始化的極小模型，讓匯出、部署、推論的流程接得上。

不需要 TensorFlow：H5 直接用 h5py 依 Keras 的檔案配置寫出（Keras 可以載入），pkl 是手動設定係數的
scikit-learn 模型。權重由亂數種子決定，同一份設定產出相同的檔案。

    python -m trainer.fake_trainer --config config.json --data dataset --out out

影像類（分類、分割、偵測）一律寫出「全域平均池化 → Dense(softmax)」的分類形模型，
模型卡以 "output": "classification" 標明；指標是亂數，沒有意義。
"""
from __future__ import annotations

import json
import pickle
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent / "templates"))
import runtime  # noqa: E402

KERAS_VERSION = "3.15.1"
IMAGE_KINDS = ("image_classification", "image_segmentation", "image_detection")
TABULAR_KINDS = ("tabular_classification", "tabular_regression")
_DTYPE = {"module": "keras", "class_name": "DTypePolicy", "config": {"name": "float32"}, "registered_name": None}


def keras_model_config(name: str, size: tuple[int, int], classes: int) -> dict:
    shape = [None, int(size[0]), int(size[1]), 1]
    return {"class_name": "Sequential", "config": {
        "name": name, "trainable": True, "dtype": _DTYPE, "build_input_shape": shape,
        "layers": [
            {"class_name": "InputLayer", "config": {"batch_shape": shape, "dtype": "float32", "sparse": False,
                                                    "ragged": False, "name": "image", "optional": False}},
            {"class_name": "GlobalAveragePooling2D", "config": {
                "name": "pool", "trainable": True, "dtype": _DTYPE, "data_format": "channels_last",
                "keepdims": False}},
            {"class_name": "Dense", "config": {
                "name": "label", "trainable": True, "dtype": _DTYPE, "units": classes, "activation": "softmax",
                "use_bias": True,
                "kernel_initializer": {"module": "keras.initializers", "class_name": "GlorotUniform",
                                       "config": {"seed": None}, "registered_name": None},
                "bias_initializer": {"module": "keras.initializers", "class_name": "Zeros", "config": {},
                                     "registered_name": None},
                "kernel_regularizer": None, "bias_regularizer": None, "kernel_constraint": None,
                "bias_constraint": None}},
        ]}}


def write_h5(path: Path, *, name: str, size: tuple[int, int], classes: int, rng: np.random.RandomState) -> None:
    import h5py

    kernel = rng.uniform(-1, 1, size=(1, classes)).astype("float32")
    bias = np.zeros(classes, dtype="float32")
    text = h5py.string_dtype()
    with h5py.File(path, "w", libver="earliest", track_order=False) as f:
        f.attrs["backend"] = "tensorflow"
        f.attrs["keras_version"] = KERAS_VERSION
        f.attrs["model_config"] = json.dumps(keras_model_config(name, size, classes))
        weights = f.create_group("model_weights")
        weights.attrs["backend"] = "tensorflow"
        weights.attrs["keras_version"] = KERAS_VERSION
        weights.attrs.create("layer_names", np.array(["pool", "label"], dtype=object), dtype=text)
        weights.create_group("pool").attrs.create(
            "weight_names", np.array([], dtype=object), shape=(0,), dtype=text)
        layer = weights.create_group("label")
        layer.attrs.create("weight_names", np.array([f"{name}/label/kernel", f"{name}/label/bias"], dtype=object),
                           dtype=text)
        inner = layer.create_group(f"{name}/label")
        inner.create_dataset("kernel", data=kernel, track_times=False)
        inner.create_dataset("bias", data=bias, track_times=False)
        weights.create_group("top_level_model_weights").attrs.create(
            "weight_names", np.array([], dtype=object), shape=(0,), dtype=text)


def write_pkl(out_dir: Path, *, kind: str, features: list[str], target: str, rng: np.random.RandomState) -> dict:
    from sklearn.linear_model import LinearRegression, LogisticRegression
    from tabular.fitted import FittedPipeline

    names = np.array(features, dtype=object)
    if kind == "tabular_classification":
        model = LogisticRegression()
        model.classes_ = np.array(["0", "1"], dtype=object)
        model.coef_ = rng.uniform(-1, 1, size=(1, len(features)))
        model.intercept_ = np.zeros(1)
        extra = {"classes": ["0", "1"]}
    else:
        model = LinearRegression()
        model.coef_ = rng.uniform(-1, 1, size=len(features))
        model.intercept_ = 0.0
        extra = {}
    model.n_features_in_, model.feature_names_in_ = len(features), names
    with open(out_dir / "model.pkl", "wb") as fh:
        pickle.dump(model, fh, protocol=4)
    with open(out_dir / "preprocess.pkl", "wb") as fh:
        pickle.dump({"pipeline": FittedPipeline(input_columns=list(features), output_columns=list(features)),
                     "target": target, "features": list(features)}, fh, protocol=4)
    return extra


def _splits(config: dict, manifest: dict, data_dir: Path | None) -> dict:
    seed = int(config["seed"])
    if config["kind"] in TABULAR_KINDS:
        rows = 0
        if data_dir is not None and manifest.get("items"):
            csv = runtime.blob_path(data_dir, manifest["items"][0]["files"]["csv"])
            rows = max(sum(1 for _ in open(csv, "rb")) - 1, 0)
        rows = rows or int(manifest.get("rows") or 10)
        return {"unit": "row", **runtime.split_rows(rows, config["split"], seed)}
    items = manifest.get("items") or []
    groups = runtime.split_groups([i.get("group") or i["id"] for i in items], config["split"], seed)
    where = {g: name for name, members in groups.items() for g in members}
    return {"unit": "sample", "groups": groups,
            **{name: [i["id"] for i in items if where[i.get("group") or i["id"]] == name] for name in runtime.SPLITS}}


def fake_train(config: dict, manifest: dict, out_dir: Path, *, data_dir: Path | None = None,
               sleep_seconds: float = 0.0) -> dict:
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    runtime.seed_everything(int(config["seed"]))
    rng = np.random.RandomState(int(config["seed"]))
    if sleep_seconds:
        time.sleep(sleep_seconds)
    kind = config["kind"]
    if kind in IMAGE_KINDS:
        image = config.get("image") or {}
        labels = list(image.get("labels") or manifest.get("label_names") or ["class_1"])
        size = tuple(int(v) for v in image.get("resize", (32, 32)))
        classes = max(len(labels), 2) if kind == "image_classification" else len(labels) + 1
        names = labels if kind == "image_classification" and len(labels) >= 2 else ["background", *labels]
        write_h5(out_dir / "model.h5", name=f"fake_{kind}", size=size, classes=classes, rng=rng)
        model_file, fmt, libraries = "model.h5", "h5", ["h5py", "numpy"]
        card = {"label_names": names[:classes], "output": "classification",
                "input": {"resize": list(size), "normalise": "minmax"}}
    elif kind in TABULAR_KINDS:
        spec = config["tabular"]
        card = write_pkl(out_dir, kind=kind, features=spec["features"], target=spec["target"], rng=rng)
        card |= {"target": spec["target"], "features": spec["features"], "algorithm": "fake"}
        model_file, fmt, libraries = "model.pkl", "pkl", ["scikit-learn", "numpy"]
    else:
        raise ValueError(f"不支援的訓練種類：{kind}")
    metrics = {"fake": True, "test": {"score": round(float(rng.uniform(0.5, 0.9)), 6)}}
    (out_dir / "train.log").write_text("fake-trainer：未進行訓練，模型為隨機初始化\n", encoding="utf-8")
    return runtime.finish(out_dir, config=config, manifest=manifest, model_file=model_file, model_format=fmt,
                          metrics=metrics, splits=_splits(config, manifest, data_dir),
                          card={"fake": True, **card}, libraries=libraries)


def train(config: dict, data_dir: Path, out_dir: Path) -> dict:
    sleep = float((config.get("hyperparameters") or {}).get("fake_sleep_seconds", 0))
    return fake_train(config, runtime.load_manifest(data_dir), out_dir, data_dir=Path(data_dir), sleep_seconds=sleep)


if __name__ == "__main__":
    raise SystemExit(runtime.main(train))
