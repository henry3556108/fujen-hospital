"""結構式分類範本（scikit-learn → model.pkl）。

設定（config.json）：
  tabular.target／features／steps   目標、特徵、前處理步驟（在訓練資料上擬合）
  tabular.algorithm                 logistic_regression｜random_forest｜gradient_boosting
  hyperparameters                   傳給演算法的參數（例如 {"C": 1.0} 或 {"n_estimators": 50}）
  split、seed                       訓練／驗證／測試比例與亂數種子
  validation                        {"method": "holdout"}（預設）或 {"method": "kfold", "folds": 5}

產出：model.pkl、preprocess.pkl、metrics.json（K 折時含 cv 的平均與標準差）、charts.json（混淆矩陣、
ROC 曲線〔二元分類〕、特徵重要性）、splits.json、model_card.json。
"""
from pathlib import Path

from sklearn.ensemble import GradientBoostingClassifier, RandomForestClassifier
from sklearn.linear_model import LogisticRegression

import runtime
import tabularkit

ALGORITHMS = {
    "logistic_regression": lambda seed, hp: LogisticRegression(**{"max_iter": 1000, **hp}, random_state=seed),
    "random_forest": lambda seed, hp: RandomForestClassifier(**{"n_estimators": 50, **hp}, random_state=seed, n_jobs=1),
    "gradient_boosting": lambda seed, hp: GradientBoostingClassifier(**{"n_estimators": 50, **hp}, random_state=seed),
}


def fit(make, x, y, *, where="訓練資料"):
    y = y.astype(str)
    if y.nunique() < 2:
        raise ValueError(f"{where}的目標欄位只有一種類別，無法訓練分類模型")
    model = tabularkit.build_model(make(), x)     # 文字／類別特徵在 Pipeline 內自動 One-Hot
    model.fit(x, y)
    return model


def train(config: dict, data_dir: Path, out_dir: Path) -> dict:
    prepared = tabularkit.prepare(config, data_dir)
    algorithm = config["tabular"]["algorithm"]
    seed, hyper = int(config["seed"]), config.get("hyperparameters") or {}

    def make():
        return ALGORITHMS[algorithm](seed, hyper)

    metrics = {"rows": {name: len(part[0]) for name, part in prepared["data"].items()}}
    if prepared["folds"]:
        metrics["cv"] = tabularkit.cross_validate(
            config, prepared, lambda xt, yt, xv, yv: tabularkit.classification_metrics(
                fit(make, xt, yt, where="交叉驗證某一折的訓練資料"), xv, yv, majority=tabularkit.majority_label(yt)))
    x_train, y_train, _ = prepared["data"]["train"]
    model = fit(make, x_train, y_train)
    majority = tabularkit.majority_label(y_train)
    classes = [str(c) for c in model.classes_]
    metrics["labels"] = {"majority": majority, **({"positive": classes[1]} if len(classes) == 2 else {})}
    for name, (x, y, _) in prepared["data"].items():
        if len(x):
            metrics[name] = tabularkit.classification_metrics(model, x, y, majority=majority)
    return tabularkit.save(out_dir, config=config, prepared=prepared, model=model, metrics=metrics,
                           card={"classes": [str(c) for c in model.classes_]},
                           charts=tabularkit.charts(config, prepared, model))


if __name__ == "__main__":
    raise SystemExit(runtime.main(train))
