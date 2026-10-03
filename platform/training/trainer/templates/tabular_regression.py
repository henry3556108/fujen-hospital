"""結構式迴歸範本（scikit-learn → model.pkl）。

設定（config.json）：
  tabular.target／features／steps   目標（數值）、特徵、前處理步驟（在訓練資料上擬合）
  tabular.algorithm                 linear_regression｜random_forest｜gradient_boosting
  hyperparameters                   傳給演算法的參數
  split、seed                       訓練／驗證／測試比例與亂數種子
  validation                        {"method": "holdout"}（預設）或 {"method": "kfold", "folds": 5}

產出：model.pkl、preprocess.pkl、metrics.json（K 折時含 cv 的平均與標準差）、charts.json（預測值對實際值、
殘差分布、特徵重要性）、splits.json、model_card.json。
"""
from pathlib import Path

import pandas as pd
from sklearn.ensemble import GradientBoostingRegressor, RandomForestRegressor
from sklearn.linear_model import LinearRegression

import runtime
import tabularkit

ALGORITHMS = {
    "linear_regression": lambda seed, hp: LinearRegression(**hp),
    "random_forest": lambda seed, hp: RandomForestRegressor(**{"n_estimators": 50, **hp}, random_state=seed, n_jobs=1),
    "gradient_boosting": lambda seed, hp: GradientBoostingRegressor(**{"n_estimators": 50, **hp}, random_state=seed),
}


def train(config: dict, data_dir: Path, out_dir: Path) -> dict:
    prepared = tabularkit.prepare(config, data_dir)
    x_train, y_train, _ = prepared["data"]["train"]
    if not pd.api.types.is_numeric_dtype(y_train):
        raise ValueError(f"目標欄位「{config['tabular']['target']}」不是數值，無法訓練迴歸模型")
    algorithm = config["tabular"]["algorithm"]
    seed, hyper = int(config["seed"]), config.get("hyperparameters") or {}

    def fit(x, y):
        model = ALGORITHMS[algorithm](seed, hyper)
        model.fit(x, y.astype("float64"))
        return model

    metrics = {"rows": {name: len(part[0]) for name, part in prepared["data"].items()}}
    if prepared["folds"]:
        metrics["cv"] = tabularkit.cross_validate(
            config, prepared, lambda xt, yt, xv, yv: tabularkit.regression_metrics(fit(xt, yt), xv, yv))
    model = fit(x_train, y_train)
    for name, (x, y, _) in prepared["data"].items():
        if len(x):
            metrics[name] = tabularkit.regression_metrics(model, x, y)
    return tabularkit.save(out_dir, config=config, prepared=prepared, model=model, metrics=metrics, card={},
                           charts=tabularkit.charts(config, prepared, model))


if __name__ == "__main__":
    raise SystemExit(runtime.main(train))
