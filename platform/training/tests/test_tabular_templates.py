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
