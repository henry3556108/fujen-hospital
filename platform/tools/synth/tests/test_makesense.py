"""makesense.ai COCO exports for TC-B01-03 / TC-B01-04. Image file names are the
DICOM slice paths produced by the `dicom` command (relative to its out dir)."""

import json
import re

import pytest

from synth import makesense


@pytest.fixture(scope="module")
def generated(tmp_path_factory):
    out = tmp_path_factory.mktemp("makesense")
    makesense.generate(out, seed=42, count=3)
    return out, json.loads((out / "manifest.json").read_text())


def test_three_exports_listed(generated):
    out, manifest = generated
    assert manifest["counts"] == {"exports": 3}
    assert manifest["image_source"] == "dicom"
    files = [e["file"] for e in manifest["exports"]]
    assert files == [f"makesense_{i:03d}.json" for i in (1, 2, 3)]
    assert sorted(p.name for p in out.glob("makesense_*.json")) == files


def test_exports_are_consistent_coco(generated):
    out, manifest = generated
    for entry in manifest["exports"]:
        coco = json.loads((out / entry["file"]).read_text())
        assert set(coco) >= {"info", "images", "annotations", "categories"}
        image_ids = {im["id"]: im for im in coco["images"]}
        cat_ids = {c["id"] for c in coco["categories"]}
        assert coco["annotations"], entry["file"]
        assert len(coco["annotations"]) == entry["annotations"]
        for im in coco["images"]:
            assert re.fullmatch(r"study_\d{4}/series_001/IM\d{4}\.dcm", im["file_name"])
            assert (im["width"], im["height"]) == (64, 64)
        ann_ids = [a["id"] for a in coco["annotations"]]
        assert len(set(ann_ids)) == len(ann_ids)
        for a in coco["annotations"]:
            assert a["image_id"] in image_ids and a["category_id"] in cat_ids
            x, y, w, h = a["bbox"]
            assert w > 0 and h > 0 and x >= 0 and y >= 0 and x + w <= 64 and y + h <= 64
            assert a["area"] == w * h and a["iscrowd"] == 0
