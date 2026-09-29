"""影像範本：TC-B05-01（分類、分割、偵測）、TC-B05-04（重現）、TC-B05-06（H5 平台外可載入）。"""
import json
import subprocess
import sys

import numpy as np
import pytest

from conftest import SPLIT, run_template

pytestmark = pytest.mark.keras
AUGMENT = {"rotation_range": 10, "width_shift_range": 0.1, "height_shift_range": 0.1, "shear_range": 5,
           "zoom_range": 0.1, "horizontal_flip": True, "vertical_flip": False}


def config(kind, *, seed=11, labels=None, augmentation=None, resize=(32, 32), **hyper):
    return {"version": 1, "kind": kind, "seed": seed, "split": SPLIT,
            "image": {"resize": list(resize), "labels": labels},
            "augmentation": augmentation if augmentation is not None else AUGMENT,
            "hyperparameters": {"epochs": 2, "batch_size": 8, **hyper}}


def test_tc_b05_01_image_classification_trains(classification_dataset, tmp_path):
    card = run_template("image_classification", config("image_classification", labels=["CT", "MR"], epochs=6),
                        classification_dataset, tmp_path / "out")
    assert card["format"] == "h5" and card["label_names"] == ["CT", "MR"]
    assert card["metrics"]["samples"] == {"train": 60, "validation": 20, "test": 20}
    assert card["metrics"]["training_samples"] == 120, "原始 60 筆＋增強 60 筆"
    splits = json.loads((tmp_path / "out" / "splits.json").read_text())
    groups = splits["groups"]
    assert len(groups["train"]) == 12 and len(groups["validation"]) == len(groups["test"]) == 4
    assert not set(groups["train"]) & set(groups["test"]), "同一研究不會同時在訓練與測試"


def test_tc_b05_01_image_segmentation_trains(segmentation_dataset, tmp_path):
    card = run_template("image_segmentation", config("image_segmentation", labels=["class_1", "class_2"]),
                        segmentation_dataset, tmp_path / "out")
    assert card["label_names"] == ["class_1", "class_2"]
    assert set(card["metrics"]["test"]) == {"pixel_accuracy", "dice"}
    assert all(card["metrics"]["samples"][k] > 0 for k in ("train", "validation", "test"))


def test_tc_b05_01_image_detection_trains(detection_dataset, tmp_path):
    card = run_template("image_detection", config("image_detection", labels=["nodule", "organ"]),
                        detection_dataset, tmp_path / "out")
    assert card["max_boxes"] == 2 and card["metrics"]["samples"] == {"train": 5, "validation": 5, "test": 5}
    assert 0 <= card["metrics"]["test"]["mean_iou"] <= 1


@pytest.mark.parametrize("kind,fixture,labels", [
    ("image_classification", "classification_dataset", ["CT", "MR"]),
    ("image_segmentation", "segmentation_dataset", ["class_1", "class_2"]),
    ("image_detection", "detection_dataset", ["nodule", "organ"]),
])
def test_tc_b05_04_same_data_config_seed_reproduces(kind, fixture, labels, tmp_path, request):
    data = request.getfixturevalue(fixture)
    cards = [run_template(kind, config(kind, labels=labels), data, tmp_path / f"run{i}") for i in range(3)]
    assert cards[0]["metrics"] == cards[1]["metrics"] == cards[2]["metrics"], "指標差異 0"
    weights = [_weights(tmp_path / f"run{i}" / "model.h5") for i in range(3)]
    assert all(np.array_equal(a, b) for a, b in zip(weights[0], weights[1]))
    assert all(np.array_equal(a, b) for a, b in zip(weights[0], weights[2])), "權重逐位元相同"
    other = _weights_of(run_template, kind, config(kind, labels=labels, seed=12), data, tmp_path / "other")
    assert any(not np.array_equal(a, b) for a, b in zip(weights[0], other)), "換種子結果不同"


def _weights(path):
    import h5py

    out = []
    with h5py.File(path, "r") as f:
        f["model_weights"].visititems(lambda name, obj: out.append(np.array(obj)) if isinstance(obj, h5py.Dataset) else None)
    assert out
    return out


def _weights_of(run, kind, cfg, data, out):
    run(kind, cfg, data, out)
    return _weights(out / "model.h5")


def test_label_selection_limits_training_images(classification_dataset, tmp_path):
    """Label 選擇：只選一種 Label 時無法訓練分類，錯誤訊息清楚。"""
    from conftest import TEMPLATES
    cfg = tmp_path / "c.json"
    cfg.write_text(json.dumps(config("image_classification", labels=["CT"])))
    result = subprocess.run([sys.executable, str(TEMPLATES / "image_classification.py"), "--config", str(cfg),
                             "--data", str(classification_dataset), "--out", str(tmp_path / "o")],
                            capture_output=True, text=True, cwd=TEMPLATES)
    assert result.returncode != 0 and "至少需要 2 種 Label" in result.stderr


@pytest.mark.parametrize("kind,fixture,labels", [
    ("image_classification", "classification_dataset", ["CT", "MR"]),
    ("image_detection", "detection_dataset", ["nodule", "organ"]),
])
def test_tc_b05_06_h5_loads_outside_platform(kind, fixture, labels, tmp_path, request):
    """只用 keras 載入（不 import 任何平台程式、不需自訂物件）並預測。"""
    run_template(kind, config(kind, labels=labels), request.getfixturevalue(fixture), tmp_path / "out")
    script = (
        "import sys, numpy as np, keras\n"
        "model = keras.models.load_model(sys.argv[1])\n"
        "out = model.predict(np.zeros((2, 32, 32, 1), dtype='float32'), verbose=0)\n"
        "shapes = {k: v.shape for k, v in out.items()} if isinstance(out, dict) else out.shape\n"
        "print('SHAPES', shapes)\n"
        "assert not any(m.split('.')[0] in ('trainer', 'runtime', 'imagekit', 'tabular') for m in sys.modules)\n")
    result = subprocess.run([sys.executable, "-c", script, str(tmp_path / "out" / "model.h5")],
                            capture_output=True, text=True, cwd=tmp_path)
    assert result.returncode == 0, result.stderr[-3000:]
    assert "SHAPES" in result.stdout
