"""結構式迴歸範本（scikit-learn → model.pkl）。

設定（config.json）：
  tabular.target／features／steps   目標（數值）、特徵、前處理步驟（在訓練資料上擬合）
  tabular.algorithm                 linear_regression｜random_forest｜gradient_boosting
  hyperparameters                   傳給演算法的參數
  split、seed                       訓練／驗證／測試比例與亂數種子
"""
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingRegressor, RandomForestRegressor
from sklearn.linear_model import LinearRegression
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score

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
    model = ALGORITHMS[algorithm](int(config["seed"]), config.get("hyperparameters") or {})
    model.fit(x_train, y_train.astype("float64"))

    metrics = {"rows": {name: len(part[0]) for name, part in prepared["data"].items()}}
    for name, (x, y, _) in prepared["data"].items():
        if len(x):
            predicted = model.predict(x)
            y = y.astype("float64")
            metrics[name] = {"r2": float(r2_score(y, predicted)) if len(x) > 1 else None,
                             "mae": float(mean_absolute_error(y, predicted)),
                             "rmse": float(np.sqrt(mean_squared_error(y, predicted)))}
    return tabularkit.save(out_dir, config=config, prepared=prepared, model=model, metrics=metrics, card={})


if __name__ == "__main__":
    raise SystemExit(runtime.main(train))
