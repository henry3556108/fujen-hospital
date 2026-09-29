import pytest

from app.labeling.payloads import InvalidPayload, mask_from_rle, normalize, rle_from_mask


def test_rle_round_trip():
    mask = [0, 0, 1, 1, 1, 2, 0, 0]
    rle = rle_from_mask(mask)
    assert rle == [[0, 2], [1, 3], [2, 1], [0, 2]]
    assert mask_from_rle(rle) == mask


def test_rle_empty_mask():
    assert rle_from_mask([]) == []


def test_classification_trims_label():
    assert normalize("classification", {"label": "  nodule "}) == {"label": "nodule"}


@pytest.mark.parametrize("payload", [{}, {"label": ""}, {"label": "   "}, {"label": 3}, {"label": "x" * 129}])
def test_classification_rejects_bad_label(payload):
    with pytest.raises(InvalidPayload):
        normalize("classification", payload)


def _seg(**over):
    base = {"shape": [2, 4], "encoding": "rle", "rle": [[0, 3], [1, 5]], "label_names": {"background": 0, "lung": 1}}
    base.update(over)
    return base


def test_segmentation_normalizes_and_merges_runs():
    out = normalize("segmentation", _seg(rle=[[0, 1], [0, 2], [1, 5]]))
    assert out == {"shape": [2, 4], "encoding": "rle", "rle": [[0, 3], [1, 5]],
                   "label_names": {"background": 0, "lung": 1}}


@pytest.mark.parametrize("over", [
    {"shape": [2]}, {"shape": [0, 4]}, {"shape": [2, 5000]}, {"encoding": "png"},
    {"rle": [[0, 3], [1, 4]]},            # 長度總和不等於高×寬
    {"rle": [[0, 3], [1, 0], [1, 5]]},    # 長度必須為正
    {"rle": [[0, 3], [7, 5]]},            # 標籤值不在 label_names
    {"rle": "abc"}, {"rle": [[0, 3, 1], [1, 5]]},
    {"label_names": {}}, {"label_names": {"lung": 1}},            # 缺 background=0
    {"label_names": {"background": 0, "a": 1, "b": 1}},           # 標籤值重複
    {"label_names": {"background": 0, "": 1}},
])
def test_segmentation_rejects(over):
    with pytest.raises(InvalidPayload):
        normalize("segmentation", _seg(**over))


def _det(**over):
    base = {"shape": [64, 64], "box_format": "xyxy",
            "boxes": [{"label": "nodule", "box": [1, 2, 10, 20], "score": 0.9}, {"label": "lung", "box": [0, 0, 64, 64]}]}
    base.update(over)
    return base


def test_detection_keeps_boxes_in_order_and_optional_score():
    out = normalize("detection", _det())
    assert out["boxes"] == [{"label": "nodule", "box": [1, 2, 10, 20], "score": 0.9},
                            {"label": "lung", "box": [0, 0, 64, 64]}]


@pytest.mark.parametrize("over", [
    {"box_format": "xywh"}, {"shape": [64]}, {"boxes": []}, {"boxes": "x"},
    {"boxes": [{"label": "", "box": [1, 2, 3, 4]}]},
    {"boxes": [{"label": "a", "box": [1, 2, 3]}]},
    {"boxes": [{"label": "a", "box": [5, 2, 5, 4]}]},      # x1 必須小於 x2
    {"boxes": [{"label": "a", "box": [1, 9, 3, 4]}]},      # y1 必須小於 y2
    {"boxes": [{"label": "a", "box": [-1, 2, 3, 4]}]},
    {"boxes": [{"label": "a", "box": [1, 2, 65, 4]}]},     # 超出影像
    {"boxes": [{"label": "a", "box": [1, 2, 3, 4], "score": 1.5}]},
    {"boxes": [{"label": "a", "box": [1, "2", 3, 4]}]},
])
def test_detection_rejects(over):
    with pytest.raises(InvalidPayload):
        normalize("detection", _det(**over))


def test_unknown_kind():
    with pytest.raises(InvalidPayload):
        normalize("polygon", {})
