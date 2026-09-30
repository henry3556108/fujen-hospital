"""批次推論的 Job 進入點（trainer.batch）：下載輸入包 → 載入模型 → 分批預測 → 回報原始預測。"""
import io
import json
import tarfile

import pytest

from conftest import SPLIT, run_template
from trainer import batch
from trainer.fake_trainer import fake_train


class FakeIO:
    """記錄容器對平台 API 做了什麼（真的 HTTP 版在平台 API 的測試裡以 TestClient 驗證）。"""

    def __init__(self, bundle: bytes | Exception):
        self._bundle, self.completed = bundle, []

    def bundle(self) -> bytes:
        if isinstance(self._bundle, Exception):
            raise self._bundle
        return self._bundle

    def complete(self, status, message="", answer=None):
        self.completed.append({"status": status, "message": message, "answer": answer})


def make_bundle(meta: dict, files: dict[str, bytes]) -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w") as archive:
        for name, data in {"batch.json": json.dumps(meta).encode(), **files}.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))
    return buffer.getvalue()


@pytest.fixture
def tabular_model(tabular_dataset, tmp_path):
    config = {"version": 1, "kind": "tabular_classification", "seed": 1, "split": SPLIT, "hyperparameters": {},
              "tabular": {"target": "diagnosis", "features": ["age", "bmi", "glucose"],
                          "steps": [{"id": "scale_standard", "columns": ["age"]}], "algorithm": "random_forest"}}
    card = run_template("tabular_classification", config, tabular_dataset, tmp_path / "out")
    return tmp_path / "out", card


def tabular_bundle(out, card, csv: bytes, schema: bytes | None) -> bytes:
    files = {"model.pkl": (out / "model.pkl").read_bytes(), "preprocess.pkl": (out / "preprocess.pkl").read_bytes(),
             "input.csv": csv}
    if schema is not None:
        files["schema.json"] = schema
    return make_bundle({"inference_id": 7, "kind": card["kind"], "format": "pkl", "card": card}, files)


def test_tabular_batch_reports_one_prediction_per_row(tabular_model, synth, tmp_path):
    out, card = tabular_model
    csv = (synth / "tabular" / "cohort_02.csv").read_bytes()
    io_ = FakeIO(tabular_bundle(out, card, csv, (synth / "tabular" / "schema.json").read_bytes()))
    assert batch.run_batch(io_, tmp_path / "work") == 0
    [done] = io_.completed
    assert done["status"] == "succeeded", done["message"]
    answer = done["answer"]
    assert len(answer["predictions"]) == len(answer["notes"]) == 100
    assert sum(p is None for p in answer["predictions"]) == sum(n is not None for n in answer["notes"])


def test_tabular_input_that_does_not_fit_fails_with_a_reason(tabular_model, tmp_path):
    out, card = tabular_model
    io_ = FakeIO(tabular_bundle(out, card, b"foo,bar\n1,2\n", None))
    assert batch.run_batch(io_, tmp_path / "work") == 1
    [done] = io_.completed
    assert done["status"] == "failed" and "缺少特徵欄位" in done["message"] and done["answer"] is None


def test_bundle_download_failure_is_reported(tmp_path):
    io_ = FakeIO(RuntimeError("401 工作憑證無效"))
    assert batch.run_batch(io_, tmp_path / "work") == 1
    assert io_.completed[0]["status"] == "failed" and "工作憑證無效" in io_.completed[0]["message"]


class CountingPredictor:
    def __init__(self):
        self.calls = []

    def predict(self, files):
        self.calls.append([f[0] for f in files])
        return {"results": [{"name": name, "slice": 0, "label": fmt} for name, _, fmt in files]}


def test_images_are_predicted_in_chunks_and_keep_their_order(tmp_path):
    names = [f"img-{i:03d}" for i in range(70)]
    meta = {"inference_id": 8, "kind": "image_classification", "format": "h5", "card": {"kind": "image_classification"},
            "images": [{"name": n, "path": f"images/{i}", "format": "png"} for i, n in enumerate(names)]}
    files = {"model.h5": b"h5"} | {f"images/{i}": f"pixels-{i}".encode() for i in range(70)}
    predictor = CountingPredictor()
    io_ = FakeIO(make_bundle(meta, files))
    assert batch.run_batch(io_, tmp_path / "work", load=lambda meta, root: predictor, chunk=32) == 0
    assert [len(c) for c in predictor.calls] == [32, 32, 6]
    assert [r["name"] for r in io_.completed[0]["answer"]["results"]] == names


def test_bundle_paths_cannot_escape_the_workdir(tmp_path):
    meta = {"inference_id": 9, "kind": "image_classification", "format": "h5", "card": {},
            "images": [{"name": "x", "path": "../../etc/passwd", "format": "png"}]}
    io_ = FakeIO(make_bundle(meta, {"model.h5": b"h5"}))
    assert batch.run_batch(io_, tmp_path / "work", load=lambda meta, root: CountingPredictor()) == 1
    assert io_.completed[0]["status"] == "failed"


def test_main_needs_the_job_environment(monkeypatch):
    for name in ("JOB_IO_URL", "JOB_IO_TOKEN"):
        monkeypatch.delenv(name, raising=False)
    assert batch.main() == 2


@pytest.mark.keras
def test_keras_batch_on_fake_trainer_model(synth, tmp_path):
    out = tmp_path / "model"
    card = fake_train({"version": 1, "kind": "image_classification", "seed": 1, "split": SPLIT,
                       "image": {"resize": [32, 32], "labels": ["CT", "MR"]}},
                      {"items": [{"id": f"i{k}", "files": {}} for k in range(5)]}, out)
    dicoms = sorted((synth / "dicom").rglob("*.dcm"))[:25]
    meta = {"inference_id": 10, "kind": "image_classification", "format": "h5", "card": card,
            "images": [{"name": p.name, "path": f"images/{i}", "format": "dicom"} for i, p in enumerate(dicoms)]}
    files = {"model.h5": (out / "model.h5").read_bytes()} | {f"images/{i}": p.read_bytes() for i, p in enumerate(dicoms)}
    io_ = FakeIO(make_bundle(meta, files))
    assert batch.run_batch(io_, tmp_path / "work", chunk=10) == 0
    results = io_.completed[0]["answer"]["results"]
    assert len(results) == 25 and all(r["label"] in ("CT", "MR") and r["preview"] for r in results)
