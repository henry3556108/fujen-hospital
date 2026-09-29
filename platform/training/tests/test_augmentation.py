"""TC-B05-03 資料增強 6 項：設定逐項保留，影像、遮罩、方框套用同一個變換，同種子結果相同。"""
import numpy as np
import pytest

import imagekit

SIX = {"rotation_range": 15, "width_shift_range": 0.1, "height_shift_range": 0.2, "shear_range": 5,
       "zoom_range": 0.15, "horizontal_flip": True, "vertical_flip": True}
OFF = imagekit.normalise_augmentation({})
NEUTRAL = {"rotation": 0.0, "shift_x": 0.0, "shift_y": 0.0, "shear": 0.0, "zoom": 1.0, "flip_h": False, "flip_v": False}


def picture():
    image = np.zeros((32, 32), dtype="float32")
    image[8:16, 4:12] = 1.0                      # 方框 x=4, y=8, 寬 8, 高 8
    return image, image.astype("int32"), [{"label": "nodule", "bbox": [4, 8, 8, 8]}]


def test_tc_b05_03_six_settings_round_trip():
    config = imagekit.normalise_augmentation(SIX)
    assert set(config) == set(imagekit.AUGMENTATION_KEYS) and len(config) == 6 + 1  # 位移分長、寬兩個鍵
    assert config == {**SIX, "rotation_range": 15.0, "shear_range": 5.0}
    assert imagekit.augmentation_enabled(config) and not imagekit.augmentation_enabled(OFF)


def test_neutral_parameters_change_nothing():
    image, mask, boxes = picture()
    out_image, out_mask, out_boxes = imagekit.augment(image, NEUTRAL, mask=mask, boxes=boxes)
    assert np.allclose(out_image, image) and (out_mask == mask).all()
    assert out_boxes[0]["bbox"] == pytest.approx([4, 8, 8, 8])


@pytest.mark.parametrize("name,expected,flipped", [
    ("flip_h", [20, 8, 8, 8], lambda a: a[:, ::-1]),
    ("flip_v", [4, 16, 8, 8], lambda a: a[::-1, :]),
])
def test_flips_move_image_mask_and_box_together(name, expected, flipped):
    image, mask, boxes = picture()
    out_image, out_mask, out_boxes = imagekit.augment(image, {**NEUTRAL, name: True}, mask=mask, boxes=boxes)
    assert np.allclose(out_image, flipped(image)) and (out_mask == flipped(mask)).all()
    # 方框以像素邊界表示，翻轉後與遮罩的外接矩形差不超過 1 像素
    assert out_boxes[0]["bbox"] == pytest.approx(expected, abs=1.0)


@pytest.mark.parametrize("params", [
    {"rotation": 20.0}, {"shift_x": 0.2}, {"shift_y": -0.15}, {"shear": 10.0}, {"zoom": 1.3}, {"zoom": 0.8},
    {"rotation": 10.0, "shift_x": 0.1, "shear": 5.0, "zoom": 1.1, "flip_h": True},
])
def test_each_transform_keeps_box_around_the_object(params):
    image, mask, boxes = picture()
    _, out_mask, out_boxes = imagekit.augment(image, {**NEUTRAL, **params}, mask=mask, boxes=boxes)
    rows, cols = np.nonzero(out_mask)
    assert len(rows), "物件仍在畫面內"
    x, y, w, h = out_boxes[0]["bbox"]
    assert x - 1.5 <= cols.min() and cols.max() <= x + w + 1.5
    assert y - 1.5 <= rows.min() and rows.max() <= y + h + 1.5
    assert not np.array_equal(out_mask, mask), "變換確實發生"


def test_same_seed_same_augmented_set_and_originals_kept():
    image, mask, boxes = picture()
    samples = [{"id": f"s{i}", "group": "g", "image": image, "mask": mask, "boxes": boxes} for i in range(4)]
    config = imagekit.normalise_augmentation(SIX)
    a = imagekit.augment_training_set(samples, config, seed=3, copies=2)
    b = imagekit.augment_training_set(samples, config, seed=3, copies=2)
    c = imagekit.augment_training_set(samples, config, seed=4, copies=2)
    assert len(a) == 12 and [s["id"] for s in a[:4]] == ["s0", "s1", "s2", "s3"]
    assert all(np.array_equal(x["image"], y["image"]) for x, y in zip(a, b))
    assert any(not np.array_equal(x["image"], y["image"]) for x, y in zip(a[4:], c[4:]))
    for s in a[4:]:
        p = s["augmentation"]
        assert abs(p["rotation"]) <= 15 and abs(p["shift_x"]) <= 0.1 and abs(p["shift_y"]) <= 0.2
        assert abs(p["shear"]) <= 5 and 0.85 <= p["zoom"] <= 1.15
    assert imagekit.augment_training_set(samples, OFF, seed=3) == samples, "全部關閉時不產生增強樣本"


def test_resize_keeps_mask_classes_and_scales_boxes():
    mask = np.zeros((64, 64), dtype="int32")
    mask[10:30, 20:50] = 2
    small = imagekit.resize(mask, (32, 32), order=0)
    assert small.shape == (32, 32) and set(np.unique(small)) == {0, 2}
    assert imagekit.resize(np.ones((64, 64), dtype="float32"), (24, 40)).shape == (24, 40)
    assert imagekit.scale_boxes([{"label": "a", "bbox": [20, 10, 30, 20]}], (64, 64), (32, 32))[0]["bbox"] == [10, 5, 15, 10]
