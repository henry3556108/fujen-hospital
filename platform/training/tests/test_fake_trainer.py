"""fake-trainer：不需 TensorFlow 就寫出 Keras 與 scikit-learn 載得回來的極小模型。"""
import builtins
import hashlib
import json
import pickle

import numpy as np
import pandas as pd
import pytest

from conftest import SPLIT
from trainer.fake_trainer import IMAGE_KINDS, fake_train, train

MANIFEST = {"version": 1, "kind": "x", "content_hash": "abc", "label_names": ["nodule", "organ"],
            "items": [{"id": f"img{i}", "group": f"study{i // 5}", "files": {}} for i in range(50)]}


def image_config(kind, seed=5):
    return {"version": 1, "kind": kind, "seed": seed, "split": SPLIT, "executor": "fake",
            "image": {"resize": [16, 24], "labels": ["nodule", "organ"]}, "hyperparameters": {}}


def tabular_config(kind, seed=5):
    return {"version": 1, "kind": kind, "seed": seed, "split": SPLIT, "executor": "fake", "hyperparameters": {},
            "tabular": {"target": "y", "features": ["age", "bmi", "sbp"], "steps": [], "algorithm": "random_forest"}}


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


@pytest.mark.parametrize("kind", IMAGE_KINDS)
def test_fake_h5_is_written_without_tensorflow(kind, tmp_path, monkeypatch):
    real_import = builtins.__import__

    def guarded(name, *args, **kwargs):
        assert name.split(".")[0] not in ("tensorflow", "keras"), "fake-trainer 不可依賴 TensorFlow"
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", guarded)
    card = fake_train(image_config(kind), MANIFEST, tmp_path / "a")
    fake_train(image_config(kind), MANIFEST, tmp_path / "b")
    fake_train(image_config(kind, seed=6), MANIFEST, tmp_path / "c")
    assert card["fake"] is True and card["format"] == "h5" and card["output"] == "classification"
    assert sha(tmp_path / "a" / "model.h5") == sha(tmp_path / "b" / "model.h5") == card["model_sha256"]
    assert sha(tmp_path / "a" / "model.h5") != sha(tmp_path / "c" / "model.h5")
    splits = json.loads((tmp_path / "a" / "splits.json").read_text())
    assert sorted(splits["train"] + splits["validation"] + splits["test"]) == sorted(i["id"] for i in MANIFEST["items"])
    assert len(splits["test"]) == 10


@pytest.mark.keras
@pytest.mark.parametrize("kind", IMAGE_KINDS)
def test_keras_loads_the_fake_h5_and_predicts(kind, tmp_path):
    import keras

    card = fake_train(image_config(kind), MANIFEST, tmp_path)
    model = keras.models.load_model(tmp_path / "model.h5")
    images = np.random.RandomState(0).rand(3, 16, 24, 1).astype("float32")
    out = model.predict(images, verbose=0)
    assert out.shape == (3, len(card["label_names"])) and np.allclose(out.sum(axis=1), 1, atol=1e-5)
    kernel, bias = model.get_layer("label").get_weights()
    logits = images.mean(axis=(1, 2)) @ kernel + bias          # 與手算結果相同：權重真的被載入
    expected = np.exp(logits) / np.exp(logits).sum(axis=1, keepdims=True)
    assert np.allclose(out, expected, atol=1e-5)


@pytest.mark.parametrize("kind", ["tabular_classification", "tabular_regression"])
def test_fake_pkl_loads_and_predicts(kind, tmp_path):
    card = fake_train(tabular_config(kind), {"items": [], "rows": 100, "content_hash": "abc"}, tmp_path)
    model = pickle.load(open(tmp_path / "model.pkl", "rb"))
    rows = pd.DataFrame(np.random.RandomState(0).rand(4, 3), columns=["age", "bmi", "sbp"])
    assert len(model.predict(rows)) == 4 and list(model.feature_names_in_) == ["age", "bmi", "sbp"]
    assert card["fake"] is True and card["format"] == "pkl"
    preprocess = pickle.load(open(tmp_path / "preprocess.pkl", "rb"))
    assert preprocess["pipeline"].transform(rows).equals(rows)
    assert len(json.loads((tmp_path / "splits.json").read_text())["test"]) == 20


def test_fake_trainer_reads_frozen_dataset_like_a_template(tabular_dataset, tmp_path):
    card = train(tabular_config("tabular_classification"), tabular_dataset, tmp_path / "out")
    splits = json.loads((tmp_path / "out" / "splits.json").read_text())
    assert len(splits["train"]) == 60 and card["dataset_content_hash"]
    assert (tmp_path / "out" / "train.log").read_text().startswith("fake-trainer")
