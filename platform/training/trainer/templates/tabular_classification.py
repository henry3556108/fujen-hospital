"""結構式分類範本（scikit-learn → model.pkl）。

設定（config.json）：
  tabular.target／features／steps   目標、特徵、前處理步驟（在訓練資料上擬合）
  tabular.algorithm                 logistic_regression｜random_forest｜gradient_boosting
  hyperparameters                   傳給演算法的參數（例如 {"C": 1.0} 或 {"n_estimators": 50}）
  split、seed                       訓練／驗證／測試比例與亂數種子
"""
from pathlib import Path

from sklearn.ensemble import GradientBoostingClassifier, RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, f1_score

import runtime
import tabularkit

ALGORITHMS = {
    "logistic_regression": lambda seed, hp: LogisticRegression(**{"max_iter": 1000, **hp}, random_state=seed),
    "random_forest": lambda seed, hp: RandomForestClassifier(**{"n_estimators": 50, **hp}, random_state=seed, n_jobs=1),
    "gradient_boosting": lambda seed, hp: GradientBoostingClassifier(**{"n_estimators": 50, **hp}, random_state=seed),
}


def train(config: dict, data_dir: Path, out_dir: Path) -> dict:
    prepared = tabularkit.prepare(config, data_dir)
    x_train, y_train, _ = prepared["data"]["train"]
    y_train = y_train.astype(str)
    if y_train.nunique() < 2:
        raise ValueError("訓練資料的目標欄位只有一種類別，無法訓練分類模型")
    algorithm = config["tabular"]["algorithm"]
    model = ALGORITHMS[algorithm](int(config["seed"]), config.get("hyperparameters") or {})
    model.fit(x_train, y_train)

    metrics = {"rows": {name: len(part[0]) for name, part in prepared["data"].items()}}
    for name, (x, y, _) in prepared["data"].items():
        if len(x):
            predicted = model.predict(x)
            metrics[name] = {"accuracy": float(accuracy_score(y.astype(str), predicted)),
                             "f1_macro": float(f1_score(y.astype(str), predicted, average="macro", zero_division=0))}
    return tabularkit.save(out_dir, config=config, prepared=prepared, model=model, metrics=metrics,
                           card={"classes": [str(c) for c in model.classes_]})


if __name__ == "__main__":
    raise SystemExit(runtime.main(train))
