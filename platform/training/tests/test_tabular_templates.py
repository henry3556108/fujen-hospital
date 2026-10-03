"""結構式範本：TC-B05-01（分類、迴歸）、TC-B05-04（重現）、TC-B05-06（pkl 平台外可載入）。"""
import json
import pickle
import subprocess
import sys

import pandas as pd
import pytest

from conftest import SPLIT, run_template

STEPS = [{"id": "impute_mean", "columns": ["glucose"]}, {"id": "scale_standard", "columns": ["age", "bmi"]},
         {"id": "onehot", "columns": ["smoker"]}]
FEATURES = ["age", "bmi", "glucose", "sbp", "smoker_current", "smoker_former", "smoker_never"]


def config(kind, target, algorithm, *, seed=7, hyperparameters=None, features=FEATURES, steps=STEPS):
    return {"version": 1, "kind": kind, "seed": seed, "split": SPLIT, "hyperparameters": hyperparameters or {},
            "tabular": {"target": target, "features": features, "steps": steps, "algorithm": algorithm}}


@pytest.mark.parametrize("algorithm", ["logistic_regression", "random_forest", "gradient_boosting"])
def test_tc_b05_01_tabular_classification_trains(tabular_dataset, tmp_path, algorithm):
    card = run_template("tabular_classification", config("tabular_classification", "diagnosis", algorithm),
                        tabular_dataset, tmp_path / "out")
    assert card["format"] == "pkl" and card["algorithm"] == algorithm
    assert card["metrics"]["rows"] == {"train": 60, "validation": 20, "test": 20}
    assert 0 <= card["metrics"]["test"]["accuracy"] <= 1
    splits = json.loads((tmp_path / "out" / "splits.json").read_text())
    rows = splits["train"] + splits["validation"] + splits["test"]
    assert sorted(rows) == list(range(100)), "三個切分不重疊且涵蓋全部資料"


@pytest.mark.parametrize("algorithm", ["linear_regression", "random_forest", "gradient_boosting"])
def test_tc_b05_01_tabular_regression_trains(tabular_dataset, tmp_path, algorithm):
    card = run_template("tabular_regression", config("tabular_regression", "sbp", algorithm,
                                                     features=["age", "bmi", "glucose"], steps=STEPS[:2]),
                        tabular_dataset, tmp_path / "out")
    assert set(card["metrics"]["test"]) == {"r2", "mae", "rmse"}


@pytest.mark.parametrize("kind,target,algorithm", [("tabular_classification", "diagnosis", "random_forest"),
                                                   ("tabular_regression", "sbp", "gradient_boosting")])
def test_tc_b05_04_same_data_config_seed_reproduces(tabular_dataset, tmp_path, kind, target, algorithm):
    features = FEATURES if target != "sbp" else [f for f in FEATURES if f != "sbp"]
    cards = [run_template(kind, config(kind, target, algorithm, features=features), tabular_dataset,
                          tmp_path / f"run{i}") for i in range(3)]
    assert cards[0]["metrics"] == cards[1]["metrics"] == cards[2]["metrics"]
    assert len({c["model_sha256"] for c in cards}) == 1, "三次的模型檔逐位元相同"
    other = run_template(kind, config(kind, target, algorithm, features=features, seed=8), tabular_dataset,
                         tmp_path / "other")
    assert other["model_sha256"] != cards[0]["model_sha256"], "換種子會得到不同的切分與模型"


def test_tc_b05_06_pkl_loads_outside_platform(tabular_dataset, tmp_path):
    """model.pkl 只含 scikit-learn 原生物件：在沒有平台程式（tabular、trainer、範本）的直譯器也能載入並預測。"""
    card = run_template("tabular_classification", config("tabular_classification", "diagnosis", "logistic_regression"),
                        tabular_dataset, tmp_path / "out")
    script = (
        "import pickle, sys, pandas as pd\n"
        "assert not any(m.split('.')[0] in ('tabular', 'trainer', 'runtime', 'tabularkit') for m in sys.modules)\n"
        "model = pickle.load(open(sys.argv[1], 'rb'))\n"
        "rows = pd.DataFrame([[0.0] * len(model.feature_names_in_)] * 3, columns=model.feature_names_in_)\n"
        "print(list(model.feature_names_in_)); print(list(model.predict(rows)))\n"
        "assert not any(m.split('.')[0] in ('tabular', 'trainer', 'runtime', 'tabularkit') for m in sys.modules)\n")
    result = subprocess.run([sys.executable, "-S", "-c", "import site; site.main()\n" + script,
                             str(tmp_path / "out" / "model.pkl")], capture_output=True, text=True, cwd=tmp_path,
                            env={"PATH": "/usr/bin:/bin"})
    assert result.returncode == 0, result.stderr[-2000:]
    assert json.dumps(card["features"]).replace('"', "'") in result.stdout


def test_preprocessing_is_fitted_on_training_rows_only(tabular_dataset, tmp_path):
    """標準化用的平均值來自訓練列，不是全部資料。"""
    import runtime
    import tabularkit

    cfg = config("tabular_classification", "diagnosis", "logistic_regression")
    prepared = tabularkit.prepare(cfg, tabular_dataset)
    frame = tabularkit.load_frame(tabular_dataset, runtime.load_manifest(tabular_dataset))
    scaler = next(s for s in prepared["fitted"].steps if s.id == "scale_standard").state["age"]
    assert scaler.mean_[0] == pytest.approx(frame.age.iloc[prepared["rows"]["train"]].mean())
    assert scaler.mean_[0] != pytest.approx(frame.age.mean())


def test_inference_keeps_rows_and_marks_unpredictable_ones(tabular_dataset, tmp_path):
    import runtime
    import tabularkit

    out = tmp_path / "out"
    run_template("tabular_classification", config("tabular_classification", "diagnosis", "logistic_regression",
                                                  steps=STEPS[1:]), tabular_dataset, out)
    model = pickle.load(open(out / "model.pkl", "rb"))
    preprocess = pickle.load(open(out / "preprocess.pkl", "rb"))
    frame = tabularkit.load_frame(tabular_dataset, runtime.load_manifest(tabular_dataset)).drop(columns=["diagnosis"])
    predictions, notes = tabularkit.predict_frame(model, preprocess, frame)
    assert len(predictions) == len(frame) == 100
    missing = frame.glucose.isna().to_numpy()
    assert missing.any(), "合成資料的 glucose 有缺值"
    assert [p is None for p in predictions] == list(missing)
    assert all((n is not None) == m for n, m in zip(notes, missing))


def test_non_numeric_feature_reports_clear_error(tabular_dataset, tmp_path):
    cfg = config("tabular_classification", "diagnosis", "logistic_regression", features=["age", "smoker"], steps=[])
    (tmp_path / "c.json").write_text(json.dumps(cfg))
    from conftest import TEMPLATES
    result = subprocess.run([sys.executable, str(TEMPLATES / "tabular_classification.py"), "--config",
                             str(tmp_path / "c.json"), "--data", str(tabular_dataset), "--out", str(tmp_path / "o")],
                            capture_output=True, text=True, cwd=TEMPLATES)
    assert result.returncode != 0 and "不是數值" in result.stderr


# ---------------------------------------------------------------- K 折交叉驗證與結果圖表（2026-10-03 B3、B4、B7）

KFOLD = {"method": "kfold", "folds": 5}
REG_FEATURES = ["age", "bmi", "glucose"]


def kfold_config(kind, target, algorithm, *, folds=5, seed=7, features=FEATURES, steps=STEPS):
    cfg = config(kind, target, algorithm, seed=seed, features=features, steps=steps)
    cfg["split"] = {"train": 0.8, "validation": 0.0, "test": 0.2}
    cfg["validation"] = {"method": "kfold", "folds": folds}
    return cfg


def read(out, name):
    return json.loads((out / name).read_text())


def test_config_without_validation_is_holdout_and_writes_charts(tabular_dataset, tmp_path):
    """舊設定（沒有 validation）照舊以固定比例切分；多寫一個 charts.json，模型卡與 metrics 沒有圖表資料。"""
    out = tmp_path / "out"
    card = run_template("tabular_classification", config("tabular_classification", "diagnosis", "random_forest"),
                        tabular_dataset, out)
    assert "cv" not in card["metrics"] and card["metrics"]["rows"] == {"train": 60, "validation": 20, "test": 20}
    charts = read(out, "charts.json")
    assert charts["version"] == 1 and charts["kind"] == "tabular_classification"
    assert charts["subset"] == "test" and charts["rows"] == 20
    cm = charts["confusion_matrix"]
    assert cm["labels"] == ["0", "1"] and sum(map(sum, cm["matrix"])) == 20
    assert "confusion_matrix" not in json.dumps(card) and "feature_importance" not in json.dumps(read(out, "metrics.json"))


def test_binary_classification_has_roc_auc_and_permutation_importance(tabular_dataset, tmp_path):
    out = tmp_path / "out"
    card = run_template("tabular_classification", config("tabular_classification", "diagnosis",
                                                         "logistic_regression"), tabular_dataset, out)
    charts = read(out, "charts.json")
    roc = charts["roc"]
    assert roc["positive"] == "1" and roc["points"][0] == [0.0, 0.0] and roc["points"][-1] == [1.0, 1.0]
    assert roc["auc"] == pytest.approx(card["metrics"]["test"]["auc"], abs=1e-6)
    assert 0 <= card["metrics"]["test"]["auc"] <= 1
    importance = charts["feature_importance"]
    assert importance["method"] == "permutation" and importance["metric"] == "accuracy"
    assert sorted(i["feature"] for i in importance["items"]) == sorted(FEATURES)
    means = [i["mean"] for i in importance["items"]]
    assert means == sorted(means, reverse=True)
    assert charts["regression"] is None


def test_regression_charts_have_points_and_residual_histogram(tabular_dataset, tmp_path):
    out = tmp_path / "out"
    run_template("tabular_regression", config("tabular_regression", "sbp", "linear_regression",
                                              features=REG_FEATURES, steps=STEPS[:2]), tabular_dataset, out)
    charts = read(out, "charts.json")
    assert charts["confusion_matrix"] is None and charts["roc"] is None
    reg = charts["regression"]
    assert reg["total"] == len(reg["points"]) == charts["rows"] and reg["sampled"] is False
    assert sum(b["count"] for b in reg["residuals"]) == reg["total"]
    assert charts["feature_importance"]["metric"] == "r2"


@pytest.mark.parametrize("algorithm", ["logistic_regression", "random_forest", "gradient_boosting"])
def test_kfold_classification_reports_mean_and_std(tabular_dataset, tmp_path, algorithm):
    out = tmp_path / "out"
    card = run_template("tabular_classification", kfold_config("tabular_classification", "diagnosis", algorithm),
                        tabular_dataset, out)
    cv = card["metrics"]["cv"]
    assert cv["method"] == "kfold" and cv["folds"] == 5 and cv["stratified"] is True and cv["rows"] == 80
    for name in ("accuracy", "f1_macro", "auc"):
        values = cv[name]["values"]
        assert len(values) == 5
        assert cv[name]["mean"] == pytest.approx(sum(values) / 5)
        assert cv[name]["std"] >= 0
    assert card["metrics"]["rows"] == {"train": 80, "validation": 0, "test": 20}, "最後的模型以全部非測試列訓練"
    splits = read(out, "splits.json")
    folds = splits["folds"]
    assert len(folds) == 5 and sorted(r for f in folds for r in f) == splits["train"], "每列剛好在一折當驗證"
    assert not set(splits["train"]) & set(splits["test"]), "測試列不參與交叉驗證"
    assert read(out, "charts.json")["subset"] == "test"


@pytest.mark.parametrize("algorithm", ["linear_regression", "random_forest", "gradient_boosting"])
def test_kfold_regression_reports_r2_mae_rmse(tabular_dataset, tmp_path, algorithm):
    card = run_template("tabular_regression", kfold_config("tabular_regression", "sbp", algorithm, folds=4,
                                                           features=REG_FEATURES, steps=STEPS[:2]),
                        tabular_dataset, tmp_path / "out")
    cv = card["metrics"]["cv"]
    assert cv["folds"] == 4 and cv["stratified"] is False
    assert {k for k in cv if isinstance(cv[k], dict)} == {"r2", "mae", "rmse"}
    assert all(len(cv[k]["values"]) == 4 for k in ("r2", "mae", "rmse"))


def test_kfold_preprocessing_is_fitted_inside_each_fold(tabular_dataset):
    """每折的標準化平均值來自該折的訓練列，不是整個交叉驗證的資料（不洩漏）。"""
    import runtime
    import tabularkit

    cfg = kfold_config("tabular_classification", "diagnosis", "logistic_regression")
    prepared = tabularkit.prepare(cfg, tabular_dataset)
    frame = tabularkit.load_frame(tabular_dataset, runtime.load_manifest(tabular_dataset))
    seen = []
    for fold in tabularkit.fold_data(cfg, prepared):
        scaler = next(s for s in fold["fitted"].steps if s.id == "scale_standard").state["age"]
        assert scaler.mean_[0] == pytest.approx(frame.age.iloc[fold["train_rows"]].mean())
        assert not set(fold["train_rows"]) & set(fold["validation_rows"])
        seen.append(scaler.mean_[0])
    pool_mean = frame.age.iloc[prepared["rows"]["train"]].mean()
    assert len(seen) == 5 and any(m != pytest.approx(pool_mean) for m in seen)


def test_kfold_needs_enough_rows(tabular_dataset, tmp_path):
    cfg = kfold_config("tabular_classification", "diagnosis", "logistic_regression", folds=10)
    cfg["split"] = {"train": 0.05, "validation": 0.0, "test": 0.95}
    (tmp_path / "c.json").write_text(json.dumps(cfg))
    from conftest import TEMPLATES
    result = subprocess.run([sys.executable, str(TEMPLATES / "tabular_classification.py"), "--config",
                             str(tmp_path / "c.json"), "--data", str(tabular_dataset), "--out", str(tmp_path / "o")],
                            capture_output=True, text=True, cwd=TEMPLATES)
    assert result.returncode != 0 and "無法做 10 折交叉驗證" in result.stderr


@pytest.mark.parametrize("kind,target,algorithm,features", [
    ("tabular_classification", "diagnosis", "random_forest", FEATURES),
    ("tabular_regression", "sbp", "gradient_boosting", REG_FEATURES)])
def test_tc_b05_04_kfold_and_charts_reproduce(tabular_dataset, tmp_path, kind, target, algorithm, features):
    """同資料、設定、種子：K 折結果、圖表資料、模型檔逐位元組相同；換種子則不同。"""
    steps = STEPS if kind == "tabular_classification" else STEPS[:2]
    outs = []
    for i in range(3):
        out = tmp_path / f"run{i}"
        run_template(kind, kfold_config(kind, target, algorithm, features=features, steps=steps), tabular_dataset, out)
        outs.append(out)
    for name in ("metrics.json", "charts.json", "splits.json", "model.pkl"):
        assert len({(o / name).read_bytes() for o in outs}) == 1, f"{name} 三次相同"
    other = tmp_path / "other"
    run_template(kind, kfold_config(kind, target, algorithm, features=features, steps=steps, seed=8),
                 tabular_dataset, other)
    assert (other / "charts.json").read_bytes() != (outs[0] / "charts.json").read_bytes()
    assert read(other, "metrics.json")["cv"] != read(outs[0], "metrics.json")["cv"]


def test_tc_b05_06_kfold_pkl_loads_with_scikit_learn_only(tabular_dataset, tmp_path):
    """K 折訓練出的 model.pkl 一樣只含 scikit-learn 物件；圖表資料不在模型檔內。"""
    out = tmp_path / "out"
    run_template("tabular_classification", kfold_config("tabular_classification", "diagnosis", "gradient_boosting"),
                 tabular_dataset, out)
    script = (
        "import pickle, sys, pandas as pd\n"
        "model = pickle.load(open(sys.argv[1], 'rb'))\n"
        "bad = [m for m in sys.modules if m.split('.')[0] in ('tabular', 'trainer', 'runtime', 'tabularkit')]\n"
        "assert not bad, bad\n"
        "assert type(model).__module__.startswith('sklearn.'), type(model).__module__\n"
        "rows = pd.DataFrame([[0.0] * len(model.feature_names_in_)] * 2, columns=model.feature_names_in_)\n"
        "print(list(model.predict(rows)))\n")
    result = subprocess.run([sys.executable, "-S", "-c", "import site; site.main()\n" + script,
                             str(out / "model.pkl")], capture_output=True, text=True, cwd=tmp_path,
                            env={"PATH": "/usr/bin:/bin"})
    assert result.returncode == 0, result.stderr[-2000:]
    blob = (out / "model.pkl").read_bytes()
    assert b"confusion_matrix" not in blob and b"feature_importance" not in blob and b"residuals" not in blob


def test_runner_uploads_charts():
    from trainer.runner import UPLOADS

    assert "charts.json" in UPLOADS
