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
# 驗證方式（只限結構式）：固定比例切分或 K 折交叉驗證
FOLDS = ("交叉驗證折數（K）", int, 2, 10, 5)
VALIDATION_METHODS = [
    {"method": "holdout", "name": "固定比例切分",
     "help": "依上面的比例把資料分成訓練、驗證、測試三份，訓練一次。速度快，資料多（數千筆以上）時建議使用。"},
    {"method": "kfold", "name": "K 折交叉驗證",
     "help": "先保留測試集，其餘資料平均分成 K 份，輪流拿一份檢查、其他份訓練，共訓練 K 次再取平均。"
             "結果比較穩定，資料少（幾百筆）時建議使用；K 通常用 5。",
     "folds": {"minimum": FOLDS[2], "maximum": FOLDS[3], "default": FOLDS[4]}},
]

# 每個參數的白話說明與建議值；advanced = 不常調整，網頁收在「進階設定」
PARAM_HELP = {
    "epochs": ("模型把全部訓練影像看過幾遍。太少學不會，太多可能只記住訓練資料；先用預設值試跑，再視結果調整（常見 10～50）。",
               False),
    "batch_size": ("一次交給模型幾張影像。電腦記憶體不足時調小；一般用預設值即可。", True),
    "learning_rate": ("每一步修正模型的幅度。太大學得不穩，太小學得很慢；一般用預設值即可。", True),
    "filters": ("模型的大小（每一層找幾種影像特徵）。越大越能學複雜的影像，但需要更多資料與時間；一般用預設值。", True),
    "augmentation_copies": ("每張原始影像另外產生幾份「資料增強」後的影像。資料少時可設 1～3；設 0 代表不增強。", False),
    "max_boxes": ("每張影像最多找出幾個方框。請設成一張影像中病灶可能出現的最多數量。", False),
    "C": ("數值越小，模型越保守、越不容易只記住訓練資料；一般用預設值 1。", True),
    "max_iter": ("模型最多計算幾輪來找答案。訓練輸出出現「未收斂」時再調大；一般用預設值。", True),
    "n_estimators": ("用幾棵決策樹一起判斷。越多通常越穩定但訓練越久；建議 50～300。", False),
    "max_depth": ("每棵樹最多連續問幾個問題。越深越能抓細節，但容易只記住訓練資料；留白代表不限制，梯度提升建議 2～5。",
                  True),
    "min_samples_leaf": ("每個最後分組至少要有幾筆資料。調大可避免被少數特殊個案帶偏；資料多時可設 5～20。", True),
    "fit_intercept": ("一般保持勾選。只有確定所有特徵都是 0 時結果也應該是 0，才取消。", True),
    "rotation_range": ("隨機旋轉影像的最大角度，模擬擺位不同；建議 0～15 度。", False),
    "width_shift_range": ("隨機左右移動影像的最大比例（0.1 = 寬度的 10%）；建議 0～0.1。", False),
    "height_shift_range": ("隨機上下移動影像的最大比例（0.1 = 高度的 10%）；建議 0～0.1。", False),
    "shear_range": ("隨機把影像斜向拉扯的最大角度；一般用 0，最多 10 度。", False),
    "zoom_range": ("隨機放大縮小的比例（0.1 = 90%～110%）；建議 0～0.2。", False),
    "horizontal_flip": ("隨機左右翻轉。左右對稱、左右不影響判讀的影像才勾選。", False),
    "vertical_flip": ("隨機上下翻轉。多數醫學影像不適合，一般不勾選。", False),
}

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


def normalise_validation(value: Any) -> dict[str, Any]:
    """結構式的驗證方式；沒有指定就是固定比例切分（舊設定也是）。"""
    if value is not None and not isinstance(value, dict):
        raise ConfigError("「驗證方式」格式錯誤，必須是物件")
    raw = value or {"method": "holdout"}
    unknown = sorted(set(raw) - {"method", "folds"})
    if unknown:
        raise ConfigError(f"不支援的驗證方式設定：{'、'.join(unknown)}")
    method = raw.get("method", "holdout")
    if method == "holdout":
        if "folds" in raw:
            raise ConfigError("固定比例切分不需要折數（folds），要用 K 折請把 method 設為 kfold")
        return {"method": "holdout"}
    if method == "kfold":
        title, kind, low, high, default = FOLDS
        return {"method": "kfold", "folds": _number(raw.get("folds", default), kind, title, low, high)}
    raise ConfigError("驗證方式 method 必須是 holdout（固定比例切分）或 kfold（K 折交叉驗證）")


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
    out = {"type": "dicom", "studies": _selection(raw.get("studies"), "研究清單"), "label_source": label_source}
    # 標註資料集：送出訓練時系統自動建版，只用該版本快照內、已確認的標註
    dataset_id = raw.get("label_dataset_id")
    if dataset_id is not None:
        if isinstance(dataset_id, bool) or not isinstance(dataset_id, int):
            raise ConfigError("標註資料集（label_dataset_id）必須是編號")
        out["label_source"] = {"provider": "annotations"}
        out["label_dataset_id"] = dataset_id
    return out


def normalise_tabular(value: Any, kind: str) -> tuple[dict[str, Any], dict[str, tuple]]:
    raw = _dict(value, "結構式設定")
    unknown = sorted(set(raw) - {"target", "features", "steps", "algorithm", "missing"})
    if unknown:
        raise ConfigError(f"不支援的結構式設定：{'、'.join(unknown)}")
    algorithms = ALGORITHMS[kind]
    algorithm = raw.get("algorithm") or next(iter(algorithms))
    if algorithm not in algorithms:
        raise ConfigError(f"{KIND_NAMES[kind]}可用的演算法：{'、'.join(algorithms)}")
    try:
        parsed = TargetFeatureConfig.from_dict({k: raw[k] for k in ("target", "features", "steps", "missing")
                                                if k in raw})
    except TabularError as exc:
        raise ConfigError(str(exc)) from exc
    out = {"target": parsed.target, "features": parsed.features, "steps": parsed.to_dict()["steps"],
           "algorithm": algorithm}
    if parsed.missing is not None:      # 缺值處理：impute 補值、drop 不使用；沒有＝drop（舊設定不變）
        out["missing"] = parsed.missing
    return out, algorithms[algorithm]


def normalise(data: Any) -> dict[str, Any]:
    """回傳正規化後的設定。normalise(normalise(x)) == normalise(x)。"""
    if not isinstance(data, dict):
        raise ConfigError("訓練設定必須是物件")
    known = {"version", "kind", "source", "split", "seed", "validation", "image", "tabular", "augmentation",
             "hyperparameters", "label_dataset_id"}
    unknown = sorted(set(data) - known)
    if unknown:
        raise ConfigError(f"不支援的設定欄位：{'、'.join(unknown)}")
    if data.get("label_dataset_id") is not None:     # 頂層的 label_dataset_id 併入 source（影像 DICOM 來源）
        source = data.get("source") if isinstance(data.get("source"), dict) else {"type": "dicom"}
        data = {**{k: v for k, v in data.items() if k != "label_dataset_id"},
                "source": {**source, "label_dataset_id": data["label_dataset_id"]}}
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
        if data.get("validation") is not None:
            raise ConfigError("影像訓練目前只支援固定比例切分，不可設定驗證方式（validation）")
        out["image"] = normalise_image(data.get("image"), kind)
        out["augmentation"] = normalise_augmentation(data.get("augmentation"))
        out["hyperparameters"] = normalise_hyperparameters(data.get("hyperparameters"), HYPERPARAMETERS[kind],
                                                           fill=True)
    else:
        if data.get("image") or data.get("augmentation"):
            raise ConfigError("結構式訓練不可帶影像設定或資料增強")
        out["validation"] = normalise_validation(data.get("validation"))
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
             "default": v[4] if len(v) > 4 else (False if v[1] is bool else 0),
             "help": PARAM_HELP[k][0], "advanced": PARAM_HELP[k][1]} for k, v in params.items()]


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
            entry["validation_methods"] = copy.deepcopy(VALIDATION_METHODS)
        kinds.append(entry)
    return {"kinds": kinds, "augmentation": _describe(AUGMENTATION), "default_split": DEFAULT_SPLIT,
            "executors": list(EXECUTORS)}
