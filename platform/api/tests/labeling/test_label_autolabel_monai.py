"""TC-B03-04 對真實工具：MONAI Label 轉接服務（platform/autolabel/adapter）實際回應的錄製檔，與規格差異 0。

錄製檔由 platform/autolabel/scripts/e2e_check.py 對執行中的轉接服務產生（腹部 CT、segmentation_spleen 等模型），
這裡用與 fake-autolabel 相同的比對（欄位集合不多不少、型別、平台回存內容）。"""
import json
from pathlib import Path

import pytest

from app.labeling import formats, payloads

RECORDED = Path(__file__).resolve().parents[3] / "autolabel" / "adapter" / "tests" / "fixtures" / "recorded"


def _load(name: str):
    return json.loads((RECORDED / name).read_text(encoding="utf-8"))


def test_recorded_info_matches_spec_with_zero_differences():
    info = _load("info.json")
    models = formats.validate_info(info)
    assert set(info) == {name for name, _, _ in formats.INFO_FIELDS}
    assert "segmentation_spleen" in models
    for meta in models.values():
        assert set(meta) <= {name for name, _, _ in formats.MODEL_FIELDS}
        assert meta["type"] == "segmentation" and meta["dimension"] == 2


RESULTS = sorted(p.name for p in RECORDED.glob("infer_*.json"))


def test_there_are_recorded_results():
    assert len(RESULTS) >= 3


@pytest.mark.parametrize("name", RESULTS)
def test_recorded_result_matches_spec_with_zero_differences(name):
    recorded = _load(name)
    body, model, image = recorded["response"], recorded["model"], recorded["image"]
    models = formats.validate_info(_load("info.json"))
    spec = formats.RESULT_FIELDS[models[model]["type"]]
    required = {f for f, _, req in spec if req}
    allowed = {f for f, _, _ in spec}
    assert required <= set(body) and set(body) <= allowed
    payload = formats.to_payload(models[model]["type"], body, model=model, image=image)
    assert set(payload) == set(formats.STORED_FIELDS["segmentation"])
    mask = payloads.mask_from_rle(payload["rle"])
    assert len(mask) == payload["shape"][0] * payload["shape"][1]
    assert any(v != 0 for v in mask)          # 錄製的都是標準答案有脾臟的切面
