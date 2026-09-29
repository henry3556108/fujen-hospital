"""推論服務：真的模型（結構式範本、Keras 影像範本、fake-trainer）經 HTTP 介面預測。"""
import json

import pytest
from fastapi.testclient import TestClient

from conftest import SPLIT, run_template
from trainer import serve
from trainer.fake_trainer import fake_train

TOKEN = {"X-Admin-Token": "t0ken"}


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("INFERENCE_ADMIN_TOKEN", "t0ken")
    serve._models.clear()
    return TestClient(serve.app)


def push(client, model_id, out, *, schema=None, model="model.pkl"):
    files = {"model": ("m", (out / model).read_bytes())}
    if (out / "preprocess.pkl").exists():
        files["preprocess"] = ("p", (out / "preprocess.pkl").read_bytes())
    data = {"card": (out / "model_card.json").read_text()}
    if schema:
        data["schema"] = schema
    response = client.put(f"/admin/models/{model_id}", headers=TOKEN, files=files, data=data)
    assert response.status_code == 200, response.text


def test_tabular_model_predicts_raw_csv_and_keeps_rows(client, tabular_dataset, synth, tmp_path):
    config = {"version": 1, "kind": "tabular_classification", "seed": 1, "split": SPLIT, "hyperparameters": {},
              "tabular": {"target": "diagnosis", "features": ["age", "bmi", "glucose"],
                          "steps": [{"id": "scale_standard", "columns": ["age"]}], "algorithm": "random_forest"}}
    run_template("tabular_classification", config, tabular_dataset, tmp_path / "out")
    push(client, 1, tmp_path / "out", schema=(synth / "tabular" / "schema.json").read_text())
    csv = (synth / "tabular" / "cohort_02.csv").read_bytes()
    answer = client.post("/models/1/predict/tabular", headers=TOKEN, content=csv).json()
    assert len(answer["predictions"]) == 100
    import pandas as pd

    missing = pd.read_csv(__import__("io").BytesIO(csv)).glucose.isna()
    assert [p is None for p in answer["predictions"]] == list(missing), "只有特徵缺值的列沒有預測"
    assert all((p is None) == (n is not None) for p, n in zip(answer["predictions"], answer["notes"]))
    # 沒有目標欄也可以
    frame = pd.read_csv(__import__("io").BytesIO(csv)).drop(columns=["diagnosis"])
    no_target = client.post("/models/1/predict/tabular", headers=TOKEN, content=frame.to_csv(index=False).encode())
    assert no_target.status_code == 200 and len(no_target.json()["predictions"]) == 100
    # 缺特徵欄或不合規格則回 422
    bad = client.post("/models/1/predict/tabular", headers=TOKEN, content=b"foo\n1\n")
    assert bad.status_code == 422


@pytest.mark.keras
def test_keras_classification_model_predicts_dicom(client, classification_dataset, synth, tmp_path):
    config = {"version": 1, "kind": "image_classification", "seed": 3, "split": SPLIT,
              "image": {"resize": [32, 32], "labels": ["CT", "MR"]}, "augmentation": {},
              "hyperparameters": {"epochs": 1}}
    run_template("image_classification", config, classification_dataset, tmp_path / "out")
    push(client, 2, tmp_path / "out", model="model.h5")
    files = sorted((synth / "dicom").rglob("*.dcm"))[:9]
    response = client.post("/models/2/predict/images", headers=TOKEN,
                           files=[("files", (p.name, p.read_bytes())) for p in files],
                           data={"formats": json.dumps(["dicom"] * 9)})
    results = response.json()["results"]
    assert len(results) == 9 and all(r["label"] in ("CT", "MR") and r["preview"].startswith("data:image/png")
                                     for r in results)


@pytest.mark.keras
def test_fake_h5_detection_and_segmentation_serve(client, synth, tmp_path):
    for model_id, kind in ((3, "image_detection"), (4, "image_segmentation")):
        out = tmp_path / kind
        fake_train({"version": 1, "kind": kind, "seed": 1, "split": SPLIT,
                    "image": {"resize": [32, 32], "labels": ["a", "b"]}},
                   {"items": [{"id": f"i{k}", "files": {}} for k in range(5)]}, out)
        push(client, model_id, out, model="model.h5")
        path = next((synth / "nifti").glob("*_image.nii.gz"))
        response = client.post(f"/models/{model_id}/predict/images", headers=TOKEN,
                               files=[("files", (path.name, path.read_bytes()))], data={"formats": '["nifti"]'})
        results = response.json()["results"]
        assert len(results) > 1 and "fake-trainer" in results[0]["note"], "立體影像每張切片一筆"


def test_admin_token_and_unknown_model(client):
    assert client.post("/models/1/predict/tabular", content=b"a\n1\n").status_code == 401
    assert client.post("/models/1/predict/tabular", headers={"X-Admin-Token": "nope"}, content=b"").status_code == 401
    response = client.post("/models/99/predict/tabular", headers=TOKEN, content=b"a\n1\n")
    assert response.status_code == 404 and response.json()["detail"]["code"] == "model_not_loaded"
