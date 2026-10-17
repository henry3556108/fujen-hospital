"""結構式訓練範本共用：讀凍結的 CSV、切分（固定比例或 K 折交叉驗證）、在訓練資料上擬合前處理、評估、
寫出 pkl 與結果圖表資料（charts.json：混淆矩陣、ROC、特徵重要性、迴歸散佈與殘差；不進模型檔）。

model.pkl 只含 scikit-learn 原生物件，平台外只要有 scikit-learn 就能載入：

    import pickle, pandas as pd
    model = pickle.load(open("model.pkl", "rb"))
    model.predict(pd.DataFrame(rows, columns=model.feature_names_in_))

輸入必須是「前處理後」的特徵欄位（欄位名稱見 model.feature_names_in_ 或 model_card.json）。
平台上的推論會先套用 preprocess.pkl（在訓練資料上擬合的前處理），所以可以直接上傳原始 CSV。

缺值（設定的 tabular.missing）：
  impute  數字特徵補訓練資料的中位數、文字特徵補最常見的值（scikit-learn SimpleImputer，在 model.pkl 內），
          含缺值的病人照樣訓練與預測。
  drop    不使用特徵含缺值的病人（沒有 missing 的舊設定也是這樣），預測時這些列不預測。
目標欄位有缺值的病人一律不使用。
"""
from __future__ import annotations

import io
import pickle
from pathlib import Path
from typing import Any, Callable

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
    """特徵矩陣：數值與是否欄位轉成小數；文字／類別欄位保留文字（缺值仍是缺值），
    由 build_model() 在 scikit-learn Pipeline 內做 One-Hot，使用者不必先自己編碼。"""
    missing = [c for c in features if c not in frame.columns]
    if missing:
        raise TabularError(f"前處理後找不到特徵欄位：{'、'.join(missing)}", code="column_not_found")
    dates = [c for c in features if pd.api.types.is_datetime64_any_dtype(frame[c])]
    if dates:
        raise TabularError(f"特徵欄位「{'、'.join(dates)}」是日期，不能直接當特徵；請先用前處理轉成天數或年齡等數字",
                           code="column_not_numeric")
    out = {}
    for c in features:
        col = frame[c]
        if pd.api.types.is_numeric_dtype(col) or pd.api.types.is_bool_dtype(col):
            out[c] = col.astype("float64")
        else:   # 缺值一律是 np.nan（SimpleImputer 認得），其餘轉成文字
            out[c] = pd.Series([np.nan if pd.isna(v) else str(v) for v in col], index=col.index, dtype=object)
    return pd.DataFrame(out, index=frame.index)


def categorical_columns(x: pd.DataFrame) -> list[str]:
    return [c for c in x.columns if x[c].dtype == object]


MISSING_STRATEGIES = ("impute", "drop")


def missing_of(config: dict) -> str:
    """缺值處理方式；沒有 missing 的舊設定是 drop（不使用含缺值的病人）。"""
    value = (config.get("tabular") or {}).get("missing") or "drop"
    return value if value in MISSING_STRATEGIES else "drop"


def build_model(estimator: Any, x: pd.DataFrame, missing: str = "drop") -> Any:
    """有文字／類別特徵時，把估計器包成 Pipeline（OneHotEncoder → 估計器）。只用 scikit-learn 的類別，
    所以 model.pkl 在平台外只要 scikit-learn 就能載入；沒看過的類別編成全 0（handle_unknown="ignore"）。
    missing="impute" 時先補值：數字補中位數、文字補最常見的值（SimpleImputer，以訓練資料擬合）。
    不補值又沒有文字特徵時維持原本的估計器，與先前產出的模型檔相同。"""
    cats = categorical_columns(x)
    if missing != "impute" and not cats:
        return estimator
    from sklearn.compose import ColumnTransformer
    from sklearn.impute import SimpleImputer
    from sklearn.pipeline import Pipeline
    from sklearn.preprocessing import OneHotEncoder

    def onehot():
        return OneHotEncoder(handle_unknown="ignore", sparse_output=False)

    if missing != "impute":
        encode = ColumnTransformer([("onehot", onehot(), cats)], remainder="passthrough",
                                   verbose_feature_names_out=False)
        return Pipeline([("encode", encode), ("model", estimator)])
    numbers = [c for c in x.columns if c not in cats]
    parts = []
    if numbers:
        parts.append(("number", SimpleImputer(strategy="median", keep_empty_features=True), numbers))
    if cats:
        parts.append(("category", Pipeline([("fill", SimpleImputer(strategy="most_frequent", keep_empty_features=True)),
                                            ("onehot", onehot())]), cats))
    prepare = ColumnTransformer(parts, remainder="drop", verbose_feature_names_out=False)
    return Pipeline([("prepare", prepare), ("model", estimator)])


def fill_values(model: Any) -> dict[str, Any]:
    """補值模型在訓練資料上學到的補值（欄位 → 中位數或最常見的值）；不是補值模型時為空。"""
    prepare = getattr(model, "named_steps", {}).get("prepare")
    if prepare is None:
        return {}
    out: dict[str, Any] = {}
    for name, part, columns in prepare.transformers_:
        imputer = part if name == "number" else getattr(part, "named_steps", {}).get("fill") if name == "category" else None
        if imputer is None:
            continue
        for column, value in zip(columns, imputer.statistics_):
            out[column] = value.item() if hasattr(value, "item") else value
    return out


def usable_rows(x: pd.DataFrame, y: pd.Series | None = None, missing: str = "drop") -> pd.Series:
    """可用的列：目標欄位不能缺；不補值時特徵也不能缺。"""
    ok = pd.Series(True, index=x.index) if missing == "impute" else x.notna().all(axis=1)
    return ok & y.notna() if y is not None else ok


def validation_of(config: dict) -> dict:
    """驗證方式：沒有 validation 的舊設定一律是固定比例切分。"""
    value = config.get("validation") or {"method": "holdout"}
    if value.get("method") == "kfold":
        return {"method": "kfold", "folds": int(value.get("folds", 5))}
    return {"method": "holdout"}


def make_folds(frame: pd.DataFrame, pool: list[int], target: str, folds: int, seed: int,
               classify: bool) -> tuple[list[list[int]], bool]:
    """把交叉驗證用的列（原始列號）分成 K 折，回傳每折的驗證列與是否分層。
    分類且每一類至少 K 筆時用分層 K 折（每折的類別比例接近全體），否則用一般 K 折。"""
    from sklearn.model_selection import KFold, StratifiedKFold

    if len(pool) < folds:
        raise TabularError(f"可用於交叉驗證的資料只有 {len(pool)} 筆，無法做 {folds} 折交叉驗證",
                           code="not_enough_rows")
    positions = np.zeros(len(pool))
    stratified = False
    parts = None
    if classify and target in frame.columns:
        y = frame[target].iloc[pool].astype(str).to_numpy()
        counts = pd.Series(y).value_counts()
        if len(counts) >= 2 and counts.min() >= folds:
            parts = StratifiedKFold(folds, shuffle=True, random_state=seed).split(positions, y)
            stratified = True
    if parts is None:
        parts = KFold(folds, shuffle=True, random_state=seed).split(positions)
    return [sorted(int(pool[i]) for i in validation) for _, validation in parts], stratified


def _xy(part: pd.DataFrame, spec: dict) -> tuple[tuple[pd.DataFrame, pd.Series, int], dict]:
    """回傳 ((X, y, 未使用的列數), 這個切分的缺值統計)。"""
    if spec["target"] not in part.columns:
        raise TabularError(f"前處理後找不到目標欄位「{spec['target']}」", code="column_not_found")
    missing = spec.get("missing") or "drop"
    x, y = feature_matrix(part, spec["features"]), part[spec["target"]]
    keep = usable_rows(x, y, missing)
    has_target = y.notna()
    gaps = x.isna().any(axis=1)
    counts = {"missing_target": int((~has_target).sum()),
              "missing_feature": int((has_target & gaps & ~keep).sum()),
              "filled": int((keep & gaps).sum()),
              "columns": {c: int(n) for c, n in x[has_target].isna().sum().items() if n}}
    return (x[keep].reset_index(drop=True), y[keep].reset_index(drop=True), int((~keep).sum())), counts


EMPTY_COUNTS = {"missing_target": 0, "missing_feature": 0, "filled": 0, "columns": {}}


def apply_labels(frame: pd.DataFrame, config: dict) -> pd.DataFrame:
    """匯入控制的「標註」環節（labels.py 的 build_labels）。沒有 labels.py 時原樣傳回。
    這個環節只能新增或修改目標欄位、刪除列；其他欄位推論時沒有這段程式，所以不能改。"""
    module = runtime.stage_module("labels")
    if module is None:
        return frame
    spec = config["tabular"]
    target = spec["target"]
    out = module.build_labels(frame.copy(), {"target": target, "features": list(spec["features"])})
    if not isinstance(out, pd.DataFrame):
        raise TypeError(f"labels.py 的 build_labels 必須回傳 DataFrame，實際是 {type(out).__name__}")
    if target not in out.columns:
        raise ValueError(f"labels.py 執行後找不到目標欄位「{target}」")
    added = [str(c) for c in out.columns if c not in frame.columns and c != target]
    if added:
        raise ValueError(f"labels.py 新增了欄位「{'、'.join(added)}」，這個環節只能改 Target 與刪除列")
    if out.index.has_duplicates or not out.index.isin(frame.index).all():
        raise ValueError("labels.py 新增了資料列，這個環節只能改 Target 與刪除列")
    for column in frame.columns:
        if column != target and (column not in out.columns or not out[column].equals(frame.loc[out.index, column])):
            raise ValueError(f"labels.py 改動了特徵欄位「{column}」，這個環節只能改 Target 與刪除列")
    return out.reset_index(drop=True)


def fit_preprocess(train: pd.DataFrame, spec: dict) -> tuple[Any, pd.DataFrame]:
    """在訓練資料上擬合前處理。匯入控制的「前處理」環節（preprocess.py 的 fit_transform）有就用它，
    否則用平台的步驟（tabular.fitted.fit_pipeline）。"""
    module = runtime.stage_module("preprocess")
    if module is None:
        return fit_pipeline(train, spec.get("steps") or [])
    result = module.fit_transform(train, {"steps": spec.get("steps") or [], "missing": spec.get("missing")})
    if not isinstance(result, tuple) or len(result) != 2 or not isinstance(result[1], pd.DataFrame) \
            or not callable(getattr(result[0], "transform", None)):
        raise TypeError("preprocess.py 的 fit_transform 必須回傳 (轉換器, DataFrame)，轉換器要有 transform(frame)")
    return result


def is_custom_preprocess(fitted: Any) -> bool:
    """前處理不是平台的步驟（匯入的 preprocess.py 自己寫的轉換器）：模型只能下載，不能在平台推論或部署。"""
    return not isinstance(fitted, FittedPipeline)


def _fit_transform(frame: pd.DataFrame, rows: dict[str, list[int]], spec: dict):
    fitted, train_out = fit_preprocess(frame.iloc[rows["train"]].reset_index(drop=True), spec)
    data, counts = {}, {}
    data["train"], counts["train"] = _xy(train_out, spec)
    for name in rows:
        if name == "train":
            continue
        if rows[name]:
            data[name], counts[name] = _xy(fitted.transform(frame.iloc[rows[name]].reset_index(drop=True)), spec)
        else:   # 比例為 0 的切分（K 折時的驗證集）：前處理不能套用在 0 列上，直接給空的資料
            data[name] = (pd.DataFrame({c: pd.Series(dtype="float64") for c in spec["features"]}),
                          pd.Series(dtype="float64"), 0)
            counts[name] = EMPTY_COUNTS
    return fitted, data, counts


def data_summary(prepared: dict) -> dict:
    """metrics.json 的 data：用了幾位病人、因為什麼沒用、補值幾位、各特徵的缺值數（訓練＋驗證＋測試）。"""
    counts = prepared["counts"]
    columns: dict[str, int] = {}
    for part in counts.values():
        for c, n in part["columns"].items():
            columns[c] = columns.get(c, 0) + n
    return {"missing": prepared["missing"], "total": prepared["frame_rows"],
            "used": {name: len(part[0]) for name, part in prepared["data"].items()},
            "left_out": {name: {"missing_target": c["missing_target"], "missing_feature": c["missing_feature"]}
                         for name, c in counts.items()},
            "filled": {name: c["filled"] for name, c in counts.items()},
            "missing_columns": dict(sorted(columns.items()))}


def prepare(config: dict, data_dir: Path) -> dict[str, Any]:
    """回傳各切分前處理後的 (X, y)、擬合好的前處理、切分的列索引。
    K 折交叉驗證時，訓練與驗證的列合併成交叉驗證用的資料（最後的模型也用它訓練），測試列照樣保留。"""
    manifest = runtime.load_manifest(data_dir)
    spec = {**config["tabular"], "missing": missing_of(config)}
    frame = apply_labels(load_frame(data_dir, manifest), config)
    seed = int(config["seed"])
    rows = runtime.split_rows(len(frame), config["split"], seed)
    validation = validation_of(config)
    folds, stratified = None, False
    if validation["method"] == "kfold":
        pool = sorted(rows["train"] + rows["validation"])
        rows = {"train": pool, "validation": [], "test": rows["test"]}
        folds, stratified = make_folds(frame, pool, spec["target"], validation["folds"], seed,
                                       classify=config["kind"] == "tabular_classification")
    fitted, data, counts = _fit_transform(frame, rows, spec)
    if len(data["train"][0]) < 2:
        raise TabularError("訓練資料去掉含缺值的列後不足 2 筆", code="not_enough_rows")
    return {"manifest": manifest, "fitted": fitted, "rows": rows, "data": data, "frame_rows": len(frame),
            "frame": frame, "folds": folds, "stratified": stratified, "counts": counts, "missing": spec["missing"]}


def fold_data(config: dict, prepared: dict):
    """逐折產生資料：前處理只在該折的訓練列上擬合，再套用到該折的驗證列（不洩漏）。"""
    spec, frame, pool = {**config["tabular"], "missing": missing_of(config)}, prepared["frame"], prepared["rows"]["train"]
    for validation_rows in prepared["folds"] or []:
        held = set(validation_rows)
        train_rows = [r for r in pool if r not in held]
        fitted, data, _ = _fit_transform(frame, {"train": train_rows, "validation": validation_rows}, spec)
        yield {"fitted": fitted, "train_rows": train_rows, "validation_rows": validation_rows, **data}


def cross_validate(config: dict, prepared: dict, score: Callable[..., dict]) -> dict:
    """K 折交叉驗證：score(x_train, y_train, x_validation, y_validation) 回傳該折的指標；
    結果是每個指標的平均、標準差（母體標準差）與各折數值。某一折算不出來的指標（例如只有一類時的 AUC）不列。"""
    per_fold = []
    for fold in fold_data(config, prepared):
        (xt, yt, _), (xv, yv, _) = fold["train"], fold["validation"]
        if len(xt) < 2 or len(xv) == 0:
            raise TabularError("交叉驗證的某一折去掉含缺值的列後資料不足，請減少折數或增加資料",
                               code="not_enough_rows")
        per_fold.append(score(xt, yt, xv, yv))
    out: dict[str, Any] = {"method": "kfold", "folds": len(per_fold), "stratified": prepared["stratified"],
                           "rows": len(prepared["rows"]["train"])}
    for name in per_fold[0]:
        values = [fold.get(name) for fold in per_fold]
        if all(v is not None for v in values):
            out[name] = {"mean": float(np.mean(values)), "std": float(np.std(values)),
                         "values": [float(v) for v in values]}
    return out


# ---------------------------------------------------------------- 指標

def binary_auc(model: Any, x: pd.DataFrame, y: pd.Series) -> float | None:
    """二元分類的 AUC；不是二元或資料只有一類時回傳 None。"""
    from sklearn.metrics import roc_auc_score

    classes = [str(c) for c in model.classes_]
    truth = y.astype(str)
    if len(classes) != 2 or truth.nunique() != 2 or not set(truth) <= set(classes):
        return None
    return float(roc_auc_score(truth == classes[1], model.predict_proba(x)[:, 1]))


def majority_label(y: pd.Series) -> str:
    """最常見的類別（同數時取排序在前者）：「全部都猜這一類」是分類的比較基準。"""
    counts = y.astype(str).value_counts()
    return str(sorted(counts[counts == counts.max()].index)[0])


def classification_metrics(model: Any, x: pd.DataFrame, y: pd.Series, *, majority: str | None = None) -> dict:
    """準確率、F1；二元分類另有 AUC、敏感度、特異度（陽性＝排序後的第二類，例如 0／1 的 1）；
    給了 majority 時另算「全部都猜最常見類別」的準確率（baseline_accuracy）。"""
    from sklearn.metrics import accuracy_score, f1_score

    truth, predicted = y.astype(str), pd.Series(model.predict(x)).astype(str).to_numpy()
    out = {"accuracy": float(accuracy_score(truth, predicted)),
           "f1_macro": float(f1_score(truth, predicted, average="macro", zero_division=0))}
    auc = binary_auc(model, x, y)
    if auc is not None:
        out["auc"] = auc
    classes = [str(c) for c in model.classes_]
    if len(classes) == 2:
        positive = truth.to_numpy() == classes[1]
        hit = predicted == classes[1]
        if positive.any():
            out["sensitivity"] = float((hit & positive).sum() / positive.sum())
        if (~positive).any():
            out["specificity"] = float((~hit & ~positive).sum() / (~positive).sum())
    if majority is not None:
        out["baseline_accuracy"] = float((truth == majority).mean())
    return out


def regression_metrics(model: Any, x: pd.DataFrame, y: pd.Series, *, mean: float | None = None) -> dict:
    """R²、MAE、RMSE；給了訓練資料的平均值時另算「每次都猜平均值」的 RMSE（baseline_rmse）。"""
    from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score

    predicted, truth = model.predict(x), y.astype("float64")
    out = {"r2": float(r2_score(truth, predicted)) if len(x) > 1 else None,
           "mae": float(mean_absolute_error(truth, predicted)),
           "rmse": float(np.sqrt(mean_squared_error(truth, predicted)))}
    if mean is not None:
        out["baseline_rmse"] = float(np.sqrt(np.mean((truth - mean) ** 2)))
    return out


def input_spec(prepared: dict, spec: dict) -> list[dict]:
    """推論時要提供的原始欄位與可填的值（模型卡用，網頁的「試用預測」依此產生表單）。"""
    frame = prepared["frame"]
    out = []
    if is_custom_preprocess(prepared["fitted"]):     # 自訂前處理：不知道它讀哪些欄位，只列原始資料裡有的特徵
        names = [c for c in spec["features"] if c in frame.columns]
    else:
        names = needed_columns({"pipeline": prepared["fitted"], "features": spec["features"],
                                "target": spec["target"]})
    for name in names:
        col = frame[name]
        if pd.api.types.is_bool_dtype(col):
            out.append({"name": name, "type": "category", "values": ["false", "true"]})
        elif pd.api.types.is_numeric_dtype(col):
            values = col.dropna()
            out.append({"name": name, "type": "number",
                        "min": _r(values.min()) if len(values) else None,
                        "max": _r(values.max()) if len(values) else None})
        else:
            values = sorted({str(v) for v in col.dropna()})
            out.append({"name": name, "type": "category", "values": values[:50]})
    return out


# ---------------------------------------------------------------- 結果圖表（charts.json；不進模型檔）

MAX_POINTS = 500
MAX_ROC_POINTS = 200
IMPORTANCE_REPEATS = 5


def _r(value: Any) -> float | None:
    value = float(value)
    return round(value, 6) if np.isfinite(value) else None


def _evenly(n: int, limit: int) -> list[int]:
    """n 個點超過 limit 時以固定間隔取樣（含頭尾），結果只跟 n 有關。"""
    if n <= limit:
        return list(range(n))
    return sorted({int(i) for i in np.linspace(0, n - 1, limit).round()})


def chart_subset(prepared: dict) -> str:
    """圖表用的資料：測試集有資料用測試集，否則驗證集，再否則訓練集。"""
    for name in ("test", "validation", "train"):
        if len(prepared["data"][name][0]):
            return name
    return "train"


def _importance(model: Any, x: pd.DataFrame, y: pd.Series, scoring: str, seed: int) -> dict | None:
    """permutation importance：把一個特徵的值打亂後分數掉多少；與演算法無關。"""
    from sklearn.inspection import permutation_importance

    if len(x) < 2:
        return None
    result = permutation_importance(model, x, y, scoring=scoring, n_repeats=IMPORTANCE_REPEATS,
                                    random_state=seed, n_jobs=1)
    items = [{"feature": str(name), "mean": _r(mean) if _r(mean) is not None else 0.0,
              "std": _r(std) if _r(std) is not None else 0.0}
             for name, mean, std in zip(x.columns, result.importances_mean, result.importances_std)]
    items.sort(key=lambda item: (-item["mean"], item["feature"]))
    return {"method": "permutation", "metric": scoring, "repeats": IMPORTANCE_REPEATS, "items": items}


def charts(config: dict, prepared: dict, model: Any) -> dict:
    from sklearn.metrics import confusion_matrix, roc_curve

    subset = chart_subset(prepared)
    x, y, _ = prepared["data"][subset]
    seed = int(config["seed"])
    out: dict[str, Any] = {"version": 1, "kind": config["kind"], "subset": subset, "rows": len(x),
                           "confusion_matrix": None, "roc": None, "feature_importance": None, "regression": None}
    if not len(x):
        return out
    if config["kind"] == "tabular_classification":
        truth = y.astype(str)
        classes = [str(c) for c in model.classes_]
        labels = classes + sorted(set(truth) - set(classes))
        matrix = confusion_matrix(truth, model.predict(x), labels=labels)
        out["confusion_matrix"] = {"labels": labels, "matrix": [[int(v) for v in row] for row in matrix]}
        auc = binary_auc(model, x, truth)
        if auc is not None:
            fpr, tpr, _ = roc_curve(truth == classes[1], model.predict_proba(x)[:, 1])
            keep = _evenly(len(fpr), MAX_ROC_POINTS)
            out["roc"] = {"positive": classes[1], "auc": _r(auc), "points": [[_r(fpr[i]), _r(tpr[i])] for i in keep]}
        out["feature_importance"] = _importance(model, x, truth, "accuracy", seed)
    else:
        truth = y.astype("float64").to_numpy()
        predicted = np.asarray(model.predict(x), dtype="float64")
        keep = _evenly(len(truth), MAX_POINTS)
        residuals = truth - predicted
        bins = min(20, max(5, int(np.ceil(np.sqrt(len(residuals))))))
        counts, edges = np.histogram(residuals, bins=bins)
        out["regression"] = {
            "points": [[_r(truth[i]), _r(predicted[i])] for i in keep], "total": len(truth),
            "sampled": len(keep) < len(truth),
            "residuals": [{"start": _r(edges[i]), "end": _r(edges[i + 1]), "count": int(counts[i])}
                          for i in range(len(counts))]}
        out["feature_importance"] = _importance(model, x, y.astype("float64"), "r2", seed)
    return out


def save(out_dir: Path, *, config: dict, prepared: dict, model: Any, metrics: dict, card: dict,
         charts: dict | None = None) -> dict:
    out_dir = Path(out_dir)
    with open(out_dir / "model.pkl", "wb") as fh:
        pickle.dump(model, fh, protocol=4)
    spec = config["tabular"]
    preprocess = {"pipeline": prepared["fitted"], "target": spec["target"], "features": spec["features"]}
    if prepared["missing"] == "impute":     # 不補值時與先前的 preprocess.pkl 相同
        preprocess["missing"] = "impute"
    with open(out_dir / "preprocess.pkl", "wb") as fh:
        pickle.dump(preprocess, fh, protocol=4)
    if charts is not None:
        runtime.write_json(out_dir / "charts.json", charts)
    dropped = {name: part[2] for name, part in prepared["data"].items()}
    splits = {"unit": "row", **prepared["rows"]}
    if prepared.get("folds"):
        splits["folds"] = prepared["folds"]
    return runtime.finish(
        out_dir, config=config, manifest=prepared["manifest"], model_file="model.pkl", model_format="pkl",
        metrics=metrics, splits=splits,
        card={"target": spec["target"], "features": spec["features"], "algorithm": spec["algorithm"],
              "validation": validation_of(config), "missing": prepared["missing"],
              "inputs": input_spec(prepared, spec),
              "encoded_features": categorical_columns(prepared["data"]["train"][0]),
              "rows": {"total": prepared["frame_rows"], "dropped_for_missing": dropped},
              **({"custom_preprocess": True} if is_custom_preprocess(prepared["fitted"]) else {}), **card},
        libraries=LIBRARIES)


def needed_columns(preprocess: dict) -> list[str]:
    """推論時必須提供的原始欄位：特徵，加上前處理步驟讀取的欄位（不含目標欄、只在訓練時刪列的步驟）。"""
    from tabular.preprocess import REGISTRY

    pipeline: FittedPipeline = preprocess["pipeline"]
    wanted = list(preprocess["features"])
    for step in pipeline.steps:
        if step.mode != "train_only" and not REGISTRY[step.id].auto_all:
            wanted += step.columns
    raw = set(pipeline.input_columns)
    target = preprocess["target"]
    return [c for c in dict.fromkeys(wanted) if c in raw and c != target]


def predict_frame(model: Any, preprocess: dict, frame: pd.DataFrame, *, with_probability: bool = False):
    """推論：套用訓練時擬合的前處理再預測。含缺值而無法預測的列回傳 None 與原因，不會少列。
    沒用到的原始欄位（例如病歷號、目標欄）可以不提供。
    with_probability=True 時另回傳每列「預測類別的機率」（分類模型；迴歸為 None）。"""
    pipeline: FittedPipeline = preprocess["pipeline"]
    optional = set(pipeline.input_columns) - set(needed_columns(preprocess))
    out = pipeline.transform(frame, optional=optional)
    if len(out) != len(frame):
        raise TabularError("前處理改變了列數，無法對回原始資料", code="row_count_changed")
    x = feature_matrix(out, preprocess["features"])
    missing = preprocess.get("missing") or "drop"
    ok = usable_rows(x, missing=missing).to_numpy()
    predictions: list = [None] * len(frame)
    probabilities: list[float | None] = [None] * len(frame)
    notes: list[str | None] = [None if good else "特徵含缺值，無法預測" for good in ok]
    if missing == "impute":
        filled, numbers = fill_values(model), set(x.columns) - set(categorical_columns(x))
        gaps = x.isna()
        for position in np.flatnonzero(gaps.any(axis=1).to_numpy()):
            parts = []
            for column in [c for c in x.columns if gaps.iloc[position][c]]:
                value = filled.get(column)
                if column in numbers:
                    how = "中位數" + ("" if value is None else f" {_r(value):g} ")
                else:
                    how = "最常見的值" + ("" if value is None else f"「{value}」")
                parts.append(f"{column} 缺值，已用訓練資料的{how}補上")
            notes[position] = "；".join(parts)
    if ok.any():
        values = model.predict(x[ok])
        for position, value in zip(np.flatnonzero(ok), values):
            predictions[position] = value.item() if hasattr(value, "item") else value
        if with_probability and hasattr(model, "predict_proba"):
            for position, row in zip(np.flatnonzero(ok), model.predict_proba(x[ok])):
                probabilities[position] = round(float(np.max(row)), 4)
    if with_probability:
        return predictions, notes, probabilities
    return predictions, notes
