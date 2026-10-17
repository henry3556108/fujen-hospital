"""M2 流程程式碼：推論服務只用限制類別的 Unpickler 載入 pkl（缺口 2）；環節程式（labels.py、preprocess.py）的掛勾。"""
import json
import os
import pickle
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from conftest import SPLIT, TEMPLATES, run_template
from trainer import predict

STEPS = [{"id": "impute_mean", "columns": ["glucose"]}, {"id": "scale_standard", "columns": ["age", "bmi"]},
         {"id": "onehot", "columns": ["smoker"]}]
FEATURES = ["age", "bmi", "glucose", "sbp", "smoker_current", "smoker_former", "smoker_never"]


def tab_config(kind="tabular_classification", target="diagnosis", algorithm="random_forest", **tabular):
    return {"version": 1, "kind": kind, "seed": 7, "split": SPLIT, "hyperparameters": {},
            "tabular": {"target": target, "features": FEATURES, "steps": STEPS, "algorithm": algorithm} | tabular}


class Shell:
    def __reduce__(self):
        return os.system, ("echo pwned > /tmp/should-not-exist",)


class Evil:
    def __reduce__(self):
        return eval, ("1+1",)


@pytest.mark.parametrize("payload,blocked", [(Shell(), "posix.system"), (Evil(), "builtins.eval")])
def test_safe_unpickler_rejects_code_execution(payload, blocked):
    with pytest.raises(predict.UnsafeModel, match="不允許的類別"):
        predict.safe_loads(pickle.dumps(payload))


@pytest.mark.parametrize("module,name", [
    ("subprocess", "Popen"), ("numpy", "load"), ("numpy", "memmap"), ("pandas", "read_pickle"),
    ("pandas.io.pickle", "read_pickle"), ("numpy.lib.npyio", "DataSource"), ("sklearn.datasets", "fetch_openml"),
    ("pandas", "HDFStore"), ("numpy", "ndarray.tofile"), ("sklearn.base", "BaseEstimator.__init__.__globals__"),
    ("builtins", "getattr"), ("builtins", "__import__"), ("os", "system"), ("joblib", "load"),
])
def test_dangerous_globals_are_not_allowed(module, name):
    assert not predict.allowed_global(module, name)


@pytest.mark.parametrize("kind,target,algorithm,features", [
    ("tabular_classification", "diagnosis", "logistic_regression", FEATURES),
    ("tabular_classification", "diagnosis", "random_forest", FEATURES),
    ("tabular_classification", "diagnosis", "gradient_boosting", FEATURES),
    ("tabular_regression", "sbp", "linear_regression", [f for f in FEATURES if f != "sbp"]),
    ("tabular_regression", "sbp", "random_forest", [f for f in FEATURES if f != "sbp"]),
])
def test_platform_template_models_load_with_the_safe_unpickler(kind, target, algorithm, features, tabular_dataset,
                                                               tmp_path):
    out = tmp_path / "out"
    run_template(kind, tab_config(kind, target, algorithm, features=features), tabular_dataset, out)
    for name in ("model.pkl", "preprocess.pkl"):
        predict.safe_loads((out / name).read_bytes())
    assert predict.model_check(out) == {"deployable": True}


def test_model_check_blocks_pickled_code(tmp_path):
    (tmp_path / "model.pkl").write_bytes(pickle.dumps(Shell()))
    result = predict.model_check(tmp_path)
    assert result["deployable"] is False and "model.pkl" in result["deploy_blocked"]
    assert not Path("/tmp/should-not-exist").exists()


# ---------------------------------------------------------------- 環節程式的掛勾

def stage_copy(tmp_path: Path, kind: str, **stage_files: str) -> Path:
    """模擬平台組出的原始碼資料夾：範本、共用模組，加上環節程式（labels.py、preprocess.py）。"""
    work = tmp_path / "work"
    work.mkdir()
    for name in ("runtime.py", "tabularkit.py", "imagekit.py", f"{kind}.py"):
        shutil.copy(TEMPLATES / name, work / name)
    for name, code in stage_files.items():
        (work / f"{name}.py").write_text(code, encoding="utf-8")
    return work


def run_copy(work: Path, kind: str, config: dict, data: Path, out: Path):
    out.mkdir(parents=True, exist_ok=True)
    (tmp := out.parent / "config.json").write_text(json.dumps(config))
    return subprocess.run([sys.executable, str(work / f"{kind}.py"), "--config", str(tmp), "--data", str(data),
                           "--out", str(out)], capture_output=True, text=True, cwd=work)


def default(stage: str, flavour: str) -> str:
    return (TEMPLATES / "stages" / f"{stage}_{flavour}.py").read_text(encoding="utf-8")


def test_default_stage_programs_give_the_same_model(tabular_dataset, tmp_path):
    kind = "tabular_classification"
    plain = run_template(kind, tab_config(), tabular_dataset, tmp_path / "plain")
    work = stage_copy(tmp_path, kind, labels=default("labels", "tabular"), preprocess=default("preprocess", "tabular"))
    result = run_copy(work, kind, tab_config(), tabular_dataset, tmp_path / "staged")
    assert result.returncode == 0, result.stderr[-3000:]
    staged = json.loads((tmp_path / "staged" / "model_card.json").read_text())
    assert staged["metrics"] == plain["metrics"] and staged["model_sha256"] == plain["model_sha256"]
    assert "custom_preprocess" not in staged


@pytest.mark.parametrize("code,message", [
    ("def build_labels(frame, config):\n    frame['age'] = 0\n    return frame\n", "labels.py 改動了特徵欄位「age」"),
    ("def build_labels(frame, config):\n    return frame.drop(columns=['diagnosis'])\n", "labels.py 執行後找不到目標欄位「diagnosis」"),
    ("def build_labels(frame, config):\n    return frame.to_dict()\n", "build_labels 必須回傳 DataFrame"),
])
def test_labels_program_rules(code, message, tabular_dataset, tmp_path):
    work = stage_copy(tmp_path, "tabular_classification", labels=code)
    result = run_copy(work, "tabular_classification", tab_config(), tabular_dataset, tmp_path / "out")
    assert result.returncode != 0 and message in result.stdout + result.stderr, result.stderr[-2000:]


def test_custom_preprocess_marks_the_card_and_is_not_deployable(tabular_dataset, tmp_path):
    code = ("import pandas\n\nclass Keep:\n    def transform(self, frame):\n        return frame.fillna(0)\n\n"
            "def fit_transform(train, config):\n    step = Keep()\n    return step, step.transform(train)\n")
    work = stage_copy(tmp_path, "tabular_classification", preprocess=code)
    config = tab_config(steps=[], features=["age", "bmi", "glucose", "sbp"])
    result = run_copy(work, "tabular_classification", config, tabular_dataset, tmp_path / "out")
    assert result.returncode == 0, result.stderr[-3000:]
    card = json.loads((tmp_path / "out" / "model_card.json").read_text())
    assert card["custom_preprocess"] is True
    check = predict.model_check(tmp_path / "out")
    assert check["deployable"] is False and "preprocess.pkl" in check["deploy_blocked"]


@pytest.mark.keras
def test_image_hooks_and_h5_check(classification_dataset, tmp_path):
    """影像：預設環節程式與範本結果相同；平台範本的 H5 可以部署；含 Lambda 層的 H5 不行。"""
    kind = "image_classification"
    config = {"version": 1, "kind": kind, "seed": 11, "split": SPLIT, "image": {"resize": [32, 32], "labels": ["CT", "MR"]},
              "augmentation": {"rotation_range": 10, "horizontal_flip": True}, "hyperparameters": {"epochs": 1, "batch_size": 8}}
    plain = run_template(kind, config, classification_dataset, tmp_path / "plain")
    assert predict.h5_reason(tmp_path / "plain" / "model.h5") is None
    assert predict.model_check(tmp_path / "plain") == {"deployable": True}
    work = stage_copy(tmp_path, kind, labels=default("labels", "image"), preprocess=default("preprocess", "image"))
    result = run_copy(work, kind, config, classification_dataset, tmp_path / "staged")
    assert result.returncode == 0, result.stderr[-3000:]
    staged = json.loads((tmp_path / "staged" / "model_card.json").read_text())
    assert staged["metrics"]["training_samples"] == plain["metrics"]["training_samples"]

    script = ("import keras, sys\n"
              "inputs = keras.Input((4,))\n"
              "out = keras.layers.Lambda(lambda x: x * 2)(inputs)\n"
              "keras.Model(inputs, out).save(sys.argv[1])\n")
    subprocess.run([sys.executable, "-c", script, str(tmp_path / "lambda.h5")], check=True, capture_output=True)
    assert "Lambda 層" in predict.h5_reason(tmp_path / "lambda.h5")


@pytest.mark.keras
def test_image_label_program_cannot_change_files(classification_dataset, tmp_path):
    code = ("def build_labels(manifest, config):\n"
            "    manifest['items'][0]['files'] = {}\n    return manifest\n")
    work = stage_copy(tmp_path, "image_classification", labels=code)
    config = {"version": 1, "kind": "image_classification", "seed": 11, "split": SPLIT,
              "image": {"resize": [32, 32], "labels": ["CT", "MR"]}, "augmentation": {},
              "hyperparameters": {"epochs": 1, "batch_size": 8}}
    result = run_copy(work, "image_classification", config, classification_dataset, tmp_path / "out")
    assert result.returncode != 0 and "labels.py" in result.stdout + result.stderr
