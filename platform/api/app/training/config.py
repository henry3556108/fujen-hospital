"""訓練設定的驗證與正規化。

設定存檔前先正規化（補預設值、固定鍵的順序與型別），所以「存檔 → 重新載入」逐欄相同，
交給 Job 的 config.json 也由同一份資料產生。錯誤一律是 ConfigError（422，繁體中文）。
"""
from __future__ import annotations

import copy
from typing import Any

from tabular.errors import TabularError
from tabular.modeling_config import TargetFeatureConfig

CONFIG_VERSION = 1
IMAGE_KINDS = ("image_classification", "image_segmentation", "image_detection")
TABULAR_KINDS = ("tabular_classification", "tabular_regression")
KINDS = IMAGE_KINDS + TABULAR_KINDS
KIND_NAMES = {"image_classification": "影像分類", "image_segmentation": "影像分割", "image_detection": "物件偵測",
              "tabular_classification": "結構式分類", "tabular_regression": "結構式迴歸"}
MODEL_FORMAT = {kind: "h5" for kind in IMAGE_KINDS} | {kind: "pkl" for kind in TABULAR_KINDS}
EXECUTORS = ("template", "fake")

# 資料增強 6 項（位移分長、寬兩個設定值）：(名稱, 型別, 下限, 上限)
AUGMENTATION = {
    "rotation_range": ("旋轉角度範圍（度）", float, 0, 180),
    "width_shift_range": ("寬度位移比例", float, 0, 1),
    "height_shift_range": ("長度位移比例", float, 0, 1),
    "shear_range": ("Shear 角度範圍（度）", float, 0, 89),
    "zoom_range": ("Zoom 比例範圍", float, 0, 0.99),
    "horizontal_flip": ("水平翻轉", bool, None, None),
    "vertical_flip": ("垂直翻轉", bool, None, None),
}

_IMAGE_HYPER = {
    "epochs": ("訓練回合數", int, 1, 1000, 3),
    "batch_size": ("批次大小", int, 1, 1024, 8),
    "learning_rate": ("學習率", float, 1e-7, 1.0, 0.001),
    "filters": ("卷積濾波器數", int, 1, 256, 8),
    "augmentation_copies": ("每張影像的增強份數", int, 0, 10, 1),
}
ALGORITHMS = {
    "tabular_classification": {
        "logistic_regression": {"C": ("正則化強度的倒數", float, 1e-6, 1e6, 1.0),
                                "max_iter": ("最大迭代次數", int, 10, 100000, 1000)},
        "random_forest": {"n_estimators": ("樹的數量", int, 1, 2000, 50),
                          "max_depth": ("最大深度", int, 1, 100, None),
                          "min_samples_leaf": ("葉節點最少樣本數", int, 1, 1000, 1)},
        "gradient_boosting": {"n_estimators": ("樹的數量", int, 1, 2000, 50),
                              "learning_rate": ("學習率", float, 1e-4, 10.0, 0.1),
                              "max_depth": ("最大深度", int, 1, 32, 3)},
    },
    "tabular_regression": {
        "linear_regression": {"fit_intercept": ("包含截距", bool, None, None, True)},
        "random_forest": {"n_estimators": ("樹的數量", int, 1, 2000, 50),
                          "max_depth": ("最大深度", int, 1, 100, None),
                          "min_samples_leaf": ("葉節點最少樣本數", int, 1, 1000, 1)},
        "gradient_boosting": {"n_estimators": ("樹的數量", int, 1, 2000, 50),
                              "learning_rate": ("學習率", float, 1e-4, 10.0, 0.1),
                              "max_depth": ("最大深度", int, 1, 32, 3)},
    },
}
HYPERPARAMETERS = {
    "image_classification": _IMAGE_HYPER,
    "image_segmentation": _IMAGE_HYPER,
    "image_detection": _IMAGE_HYPER | {"max_boxes": ("每張影像最多方框數", int, 1, 20, 2)},
}
_FAKE_HYPER = {"fake_sleep_seconds": ("fake-trainer 等待秒數", float, 0, 600, 0)}
DEFAULT_SPLIT = {"train": 0.6, "validation": 0.2, "test": 0.2}
SOURCE_TYPES = {"image_classification": ("dicom",), "image_detection": ("dicom",),
                "image_segmentation": ("files", "dicom"), "tabular_classification": ("tabular",),
                "tabular_regression": ("tabular",)}


class ConfigError(Exception):
    status_code = 422


def _number(value: Any, kind: type, title: str, low, high) -> Any:
    if kind is bool:
        if not isinstance(value, bool):
            raise ConfigError(f"「{title}」必須是 true 或 false")
        return value
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ConfigError(f"「{title}」必須是數值")
    if kind is int:
        if float(value) != int(value):
            raise ConfigError(f"「{title}」必須是整數")
        value = int(value)
    else:
        value = float(value)
    if (low is not None and value < low) or (high is not None and value > high):
        raise ConfigError(f"「{title}」必須介於 {low} 與 {high} 之間")
    return value


def _dict(value: Any, title: str) -> dict:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ConfigError(f"「{title}」格式錯誤，必須是物件")
    return value


def normalise_augmentation(value: Any) -> dict[str, Any]:
    raw = _dict(value, "資料增強")
    unknown = sorted(set(raw) - set(AUGMENTATION))
    if unknown:
        raise ConfigError(f"不支援的資料增強設定：{'、'.join(unknown)}")
    out = {}
    for key, (title, kind, low, high) in AUGMENTATION.items():
        default = False if kind is bool else 0.0
        out[key] = _number(raw[key], kind, title, low, high) if key in raw else default
    return out


def normalise_split(value: Any) -> dict[str, float]:
    raw = _dict(value, "資料切分") or DEFAULT_SPLIT
    unknown = sorted(set(raw) - set(DEFAULT_SPLIT))
    if unknown:
        raise ConfigError(f"資料切分只能有 train、validation、test，多了：{'、'.join(unknown)}")
    out = {k: _number(raw.get(k, 0), float, f"資料切分 {k}", 0, 1) for k in DEFAULT_SPLIT}
    if out["train"] <= 0:
        raise ConfigError("訓練集比例必須大於 0")
    if abs(sum(out.values()) - 1) > 1e-6:
        raise ConfigError("訓練、驗證、測試的比例總和必須等於 1")
    return out


def normalise_hyperparameters(value: Any, allowed: dict[str, tuple], *, fill: bool) -> dict[str, Any]:
    raw = _dict(value, "超參數")
    allowed = allowed | _FAKE_HYPER
    unknown = sorted(set(raw) - set(allowed))
    if unknown:
        raise ConfigError(f"不支援的超參數：{'、'.join(unknown)}（可用：{'、'.join(allowed)}）")
    out = {}
    for key, (title, kind, low, high, default) in allowed.items():
        if key in raw and raw[key] is not None:
            out[key] = _number(raw[key], kind, title, low, high)
        elif fill and default is not None and key not in _FAKE_HYPER:
            out[key] = default
    return out


def _labels(value: Any) -> list[str] | None:
    if value is None:
        return None
    if not isinstance(value, list) or not all(isinstance(v, str) and v.strip() for v in value):
        raise ConfigError("Label 清單必須是非空字串的清單")
    labels = [v.strip() for v in value]
    if len(set(labels)) != len(labels):
        raise ConfigError("Label 清單有重複的名稱")
    return labels


def normalise_image(value: Any, kind: str) -> dict[str, Any]:
    raw = _dict(value, "影像設定")
    unknown = sorted(set(raw) - {"resize", "labels"})
    if unknown:
        raise ConfigError(f"不支援的影像設定：{'、'.join(unknown)}")
    resize = raw.get("resize", [32, 32])
    if not isinstance(resize, (list, tuple)) or len(resize) != 2:
        raise ConfigError("Resize 必須是 [高, 寬]")
    resize = [_number(v, int, "Resize", 8, 1024) for v in resize]
    if kind == "image_segmentation" and (resize[0] % 2 or resize[1] % 2):
        raise ConfigError("影像分割的 Resize 高與寬必須是偶數")
    labels = _labels(raw.get("labels"))
    if kind == "image_segmentation" and not labels:
        raise ConfigError("影像分割必須指定前景類別名稱（image.labels，順序對應遮罩值 1、2、…）")
    if kind == "image_classification" and labels is not None and len(labels) < 2:
        raise ConfigError("影像分類至少需要 2 種 Label")
    return {"resize": resize, "labels": labels}


def _selection(value: Any, title: str) -> str | list[str]:
    if value in (None, "all"):
        return "all"
    if not isinstance(value, list) or not value or not all(isinstance(v, str) and v for v in value):
        raise ConfigError(f"「{title}」必須是 \"all\" 或非空的清單")
    if len(set(value)) != len(value):
        raise ConfigError(f"「{title}」有重複的項目")
    return sorted(value)


def normalise_source(value: Any, kind: str) -> dict[str, Any]:
    raw = _dict(value, "資料來源")
    kind_of_source = raw.get("type")
    if kind_of_source not in SOURCE_TYPES[kind]:
        raise ConfigError(f"{KIND_NAMES[kind]}的資料來源 type 必須是：{'、'.join(SOURCE_TYPES[kind])}")
    if kind_of_source == "tabular":
        if isinstance(raw.get("dataset_id"), bool) or not isinstance(raw.get("dataset_id"), int):
            raise ConfigError("請指定結構式資料集（source.dataset_id）")
        return {"type": "tabular", "dataset_id": raw["dataset_id"]}
    if kind_of_source == "files":
        if raw.get("format") not in ("nifti", "itk"):
            raise ConfigError("資料來源 format 必須是 nifti 或 itk")
        return {"type": "files", "format": raw["format"], "cases": _selection(raw.get("cases"), "病例清單")}
    labels = _dict(raw.get("label_source"), "標註來源") or {"provider": "makesense"}
    provider = labels.get("provider")
    if not isinstance(provider, str) or not provider:
        raise ConfigError("請指定標註來源（label_source.provider）")
    label_source: dict[str, Any] = {"provider": provider}
    if provider == "inline":
        if labels.get("by") not in ("study", "accession", "sop"):
            raise ConfigError("inline 標註的 by 必須是 study、accession 或 sop")
        values = labels.get("values")
        if not isinstance(values, dict) or not values or not all(
                isinstance(k, str) and isinstance(v, str) and v for k, v in values.items()):
            raise ConfigError("inline 標註的 values 必須是「識別碼 → Label」的對照")
        label_source |= {"by": labels["by"], "values": dict(sorted(values.items()))}
    return {"type": "dicom", "studies": _selection(raw.get("studies"), "研究清單"), "label_source": label_source}


def normalise_tabular(value: Any, kind: str) -> tuple[dict[str, Any], dict[str, tuple]]:
    raw = _dict(value, "結構式設定")
    unknown = sorted(set(raw) - {"target", "features", "steps", "algorithm"})
    if unknown:
        raise ConfigError(f"不支援的結構式設定：{'、'.join(unknown)}")
    algorithms = ALGORITHMS[kind]
    algorithm = raw.get("algorithm") or next(iter(algorithms))
    if algorithm not in algorithms:
        raise ConfigError(f"{KIND_NAMES[kind]}可用的演算法：{'、'.join(algorithms)}")
    try:
        parsed = TargetFeatureConfig.from_dict({k: raw[k] for k in ("target", "features", "steps") if k in raw})
    except TabularError as exc:
        raise ConfigError(str(exc)) from exc
    return ({"target": parsed.target, "features": parsed.features, "steps": parsed.to_dict()["steps"],
             "algorithm": algorithm}, algorithms[algorithm])


def normalise(data: Any) -> dict[str, Any]:
    """回傳正規化後的設定。normalise(normalise(x)) == normalise(x)。"""
    if not isinstance(data, dict):
        raise ConfigError("訓練設定必須是物件")
    known = {"version", "kind", "source", "split", "seed", "image", "tabular", "augmentation", "hyperparameters"}
    unknown = sorted(set(data) - known)
    if unknown:
        raise ConfigError(f"不支援的設定欄位：{'、'.join(unknown)}")
    if data.get("version", CONFIG_VERSION) != CONFIG_VERSION:
        raise ConfigError(f"不支援的設定版本：{data.get('version')}")
    kind = data.get("kind")
    if kind not in KINDS:
        raise ConfigError(f"訓練種類必須是：{'、'.join(KINDS)}")
    out: dict[str, Any] = {
        "version": CONFIG_VERSION, "kind": kind, "source": normalise_source(data.get("source"), kind),
        "split": normalise_split(data.get("split")),
        "seed": _number(data.get("seed", 42), int, "亂數種子", 0, 2**31 - 1),
    }
    if kind in IMAGE_KINDS:
        if data.get("tabular"):
            raise ConfigError("影像訓練不可帶結構式設定（tabular）")
        out["image"] = normalise_image(data.get("image"), kind)
        out["augmentation"] = normalise_augmentation(data.get("augmentation"))
        out["hyperparameters"] = normalise_hyperparameters(data.get("hyperparameters"), HYPERPARAMETERS[kind],
                                                           fill=True)
    else:
        if data.get("image") or data.get("augmentation"):
            raise ConfigError("結構式訓練不可帶影像設定或資料增強")
        out["tabular"], allowed = normalise_tabular(data.get("tabular"), kind)
        out["hyperparameters"] = normalise_hyperparameters(data.get("hyperparameters"), allowed, fill=True)
    return out


def job_config(setting: dict[str, Any], *, executor: str, label_names: list[str] | None = None) -> dict[str, Any]:
    """交給 Job 的 config.json：設定去掉資料來源（資料已凍結在資料包內），加上執行方式。"""
    config = copy.deepcopy({k: v for k, v in setting.items() if k != "source"})
    config["executor"] = executor
    if "image" in config and not config["image"].get("labels") and label_names:
        config["image"]["labels"] = list(label_names)
    return config


def _describe(params: dict[str, tuple]) -> list[dict]:
    return [{"name": k, "title": v[0], "type": v[1].__name__, "minimum": v[2], "maximum": v[3],
             "default": v[4] if len(v) > 4 else (False if v[1] is bool else 0)} for k, v in params.items()]


def catalogue() -> dict[str, Any]:
    kinds = []
    for kind in KINDS:
        entry = {"kind": kind, "name": KIND_NAMES[kind], "model_format": MODEL_FORMAT[kind],
                 "source_types": list(SOURCE_TYPES[kind])}
        if kind in IMAGE_KINDS:
            entry["hyperparameters"] = _describe(HYPERPARAMETERS[kind])
        else:
            entry["algorithms"] = [{"name": name, "hyperparameters": _describe(params)}
                                   for name, params in ALGORITHMS[kind].items()]
        kinds.append(entry)
    return {"kinds": kinds, "augmentation": _describe(AUGMENTATION), "default_split": DEFAULT_SPLIT,
            "executors": list(EXECUTORS)}
