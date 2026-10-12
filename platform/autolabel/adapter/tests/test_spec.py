"""規格 1.0 的輸出：RLE 與平台的 payloads 一致、模型清單只有規格欄位。"""
import numpy as np
import pytest
from app.labeling import formats, payloads

from autolabel_adapter import spec

MONAI_INFO = {
    "name": "MONAILabel - Radiology (0.8.5)",
    "description": "DeepLearning models for radiology",
    "version": "0.8.5",
    "labels": ["spleen", "liver"],
    "models": {
        "segmentation_spleen": {"type": "segmentation", "labels": {"spleen": 1}, "dimension": 3,
                                "description": "A pre-trained model for volumetric (3D) segmentation of the spleen",
                                "config": {"device": ["cuda", "cpu"]}},
        "segmentation": {"type": "segmentation", "labels": {"liver": 5, "spleen": 1, "background": 0},
                         "dimension": 3, "description": "multi organ"},
        "deepedit": {"type": "deepedit", "labels": {"spleen": 1}, "dimension": 3},
        "histogram": {"type": "scribbles", "labels": ["x"], "dimension": 3},
    },
    "trainers": {}, "strategies": {}, "scoring": {}, "train_stats": {}, "datastore": {},
}


@pytest.mark.parametrize("mask", [
    np.zeros((4, 5), dtype=np.uint8),
    np.array([[0, 0, 1], [1, 1, 0]], dtype=np.uint8),
    np.random.default_rng(3).integers(0, 3, size=(17, 23)).astype(np.uint8),
])
def test_rle_matches_the_platform_encoder_and_round_trips(mask):
    rle = spec.rle_encode(mask)
    assert rle == payloads.rle_from_mask(mask.ravel().tolist())
    assert payloads.mask_from_rle(rle) == mask.ravel().tolist()
    assert all(type(v) is int and type(n) is int for v, n in rle)


def test_rle_is_row_major():
    mask = np.array([[1, 0], [0, 0]], dtype=np.uint8)
    assert spec.rle_encode(mask) == [[1, 1], [0, 3]]
    assert spec.rle_encode(mask.T.copy()) == [[1, 1], [0, 3]]
    assert spec.rle_encode(np.array([[0, 1], [0, 0]], dtype=np.uint8)) == [[0, 1], [1, 1], [0, 2]]


def test_models_are_segmentation_only_and_labels_sorted_by_value():
    models = spec.models_from_info(MONAI_INFO)
    assert list(models) == ["segmentation", "segmentation_spleen"]
    assert models["segmentation"]["labels"] == {"spleen": 1, "liver": 5}
    assert list(spec.models_from_info(MONAI_INFO, {"segmentation_spleen"})) == ["segmentation_spleen"]


def test_label_list_is_numbered_from_one():
    assert spec.label_map(["a", "b"]) == {"a": 1, "b": 2}
    with pytest.raises(spec.SpecError):
        spec.label_map({"a": 1, "b": 1})


def test_info_has_exactly_the_spec_fields():
    body = spec.info_response(MONAI_INFO, spec.models_from_info(MONAI_INFO))
    models = formats.validate_info(body)
    assert set(body) == {name for name, _, _ in formats.INFO_FIELDS}
    for meta in models.values():
        assert set(meta) <= {name for name, _, _ in formats.MODEL_FIELDS}
        assert meta["dimension"] == 2 and meta["type"] == "segmentation"
    assert body["labels"] == ["spleen", "liver"]
    assert body["models"]["segmentation"]["labels"] == ["spleen", "liver"]


def test_segmentation_response_passes_the_platform_validation():
    mask = np.zeros((8, 6), dtype=np.uint8)
    mask[2:5, 1:4] = 1
    body = spec.segmentation_response("segmentation_spleen", "1.2.3", mask, {"spleen": 1})
    allowed = {name for name, _, _ in formats.SEGMENTATION_FIELDS}
    assert set(body) == allowed
    payload = formats.to_payload("segmentation", body, model="segmentation_spleen", image="1.2.3")
    assert payload["shape"] == [8, 6] and payload["label_names"] == {"background": 0, "spleen": 1}
    assert payloads.mask_from_rle(payload["rle"]) == mask.ravel().tolist()


def test_undefined_label_value_is_an_error():
    with pytest.raises(spec.SpecError, match="未定義"):
        spec.segmentation_response("m", "1", np.full((2, 2), 7, dtype=np.uint8), {"spleen": 1})
