"""Fake MONAI Label subset (supports TC-B03-01/02/04/05 auto-labeling)."""

import time

import pytest
from fastapi.testclient import TestClient

from fakes import faults
from fakes.autolabel import app

client = TestClient(app)


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    monkeypatch.delenv("FAKE_AUTOLABEL_DELAY_MS", raising=False)
    monkeypatch.delenv("FAKE_AUTOLABEL_FAIL_RATE", raising=False)
    faults.reset_counter(app)


def infer(model, image, **kw):
    return client.post(f"/infer/{model}", params={"image": image}, **kw)


def rle_decode(rle, size):
    flat = []
    for value, run in rle:
        flat.extend([value] * run)
    assert len(flat) == size
    return flat


# --- /info/ ---------------------------------------------------------------

def test_info_lists_name_version_labels_and_both_models():
    r = client.get("/info/")
    assert r.status_code == 200
    info = r.json()
    assert info["name"]
    assert info["version"]
    assert {"lung", "nodule"} <= set(info["labels"])
    assert set(info["models"]) == {"fake_segmentation", "fake_detection"}
    assert info["models"]["fake_segmentation"]["type"] == "segmentation"
    assert info["models"]["fake_detection"]["type"] == "detection"
    for m in info["models"].values():
        assert set(m["labels"]) <= set(info["labels"])


# --- segmentation -----------------------------------------------------------

def test_segmentation_returns_rle_mask_with_label_names():
    r = infer("fake_segmentation", "study-001/series-1")
    assert r.status_code == 200
    out = r.json()
    assert out["model"] == "fake_segmentation"
    assert out["image"] == "study-001/series-1"
    h, w = out["shape"]
    assert h > 0 and w > 0
    assert out["encoding"] == "rle"
    flat = rle_decode(out["rle"], h * w)
    names = out["label_names"]
    assert names["background"] == 0
    assert set(names) >= {"lung", "nodule"}
    assert set(flat) <= set(names.values())
    assert names["lung"] in flat  # mask is not empty


def test_segmentation_is_deterministic_per_image_and_differs_between_images():
    a1 = infer("fake_segmentation", "img-A").json()
    a2 = infer("fake_segmentation", "img-A").json()
    b = infer("fake_segmentation", "img-B").json()
    assert a1 == a2
    assert a1["rle"] != b["rle"]


# --- detection --------------------------------------------------------------

def test_detection_returns_boxes_with_scores_inside_image():
    out = infer("fake_detection", "study-002").json()
    assert out["model"] == "fake_detection"
    h, w = out["shape"]
    assert 1 <= len(out["boxes"]) <= 5
    for b in out["boxes"]:
        x1, y1, x2, y2 = b["box"]
        assert 0 <= x1 < x2 <= w and 0 <= y1 < y2 <= h
        assert 0.0 <= b["score"] <= 1.0
        assert b["label"] in {"lung", "nodule"}


def test_detection_is_deterministic_and_depends_on_image_and_model():
    a1 = infer("fake_detection", "img-A").json()
    a2 = infer("fake_detection", "img-A").json()
    b = infer("fake_detection", "img-B").json()
    assert a1 == a2
    assert a1["boxes"] != b["boxes"]


# --- errors and faults -------------------------------------------------------

def test_unknown_model_is_404_json():
    r = infer("no_such_model", "img-A")
    assert r.status_code == 404
    assert "no_such_model" in r.json()["detail"]


def test_missing_image_is_rejected():
    r = client.post("/infer/fake_segmentation")
    assert r.status_code == 422


def test_status_header_injects_failure():
    r = infer("fake_segmentation", "img-A", headers={"X-Fake-Status": "503"})
    assert r.status_code == 503
    assert r.json()["detail"]


def test_delay_header_sleeps():
    start = time.perf_counter()
    r = infer("fake_detection", "img-A", headers={"X-Fake-Delay-Ms": "150"})
    assert r.status_code == 200
    assert time.perf_counter() - start >= 0.15


def test_env_fail_rate_and_delay(monkeypatch):
    monkeypatch.setenv("FAKE_AUTOLABEL_FAIL_RATE", "1")
    monkeypatch.setenv("FAKE_AUTOLABEL_DELAY_MS", "100")
    start = time.perf_counter()
    r = infer("fake_detection", "img-A")
    assert r.status_code == 503
    assert time.perf_counter() - start >= 0.1
