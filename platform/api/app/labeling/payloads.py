"""三種標註內容的驗證與正規化（純函式）。

- classification：{"label"}
- segmentation：RLE 遮罩，row-major，[標籤值, 長度]；長度總和＝高×寬；label_names 必含 background=0
- detection：xyxy 框，座標落在影像內（0 ≤ x1 < x2 ≤ 寬、0 ≤ y1 < y2 ≤ 高）

存進資料庫的是 normalize() 的輸出，所以「重新載入差異 0」比對的是正規化後的內容。
"""
from collections.abc import Sequence

KINDS = ("classification", "segmentation", "detection")
MAX_SIDE = 4096
MAX_LABEL = 128
MAX_BOXES = 1000


class InvalidPayload(ValueError):
    """標註內容不合規格；訊息為繁體中文，直接回給使用者（422）。"""


def rle_from_mask(mask: Sequence[int]) -> list[list[int]]:
    rle: list[list[int]] = []
    for value in mask:
        if rle and rle[-1][0] == value:
            rle[-1][1] += 1
        else:
            rle.append([value, 1])
    return rle


def mask_from_rle(rle: Sequence[Sequence[int]]) -> list[int]:
    mask: list[int] = []
    for value, run in rle:
        mask.extend([value] * run)
    return mask


def _is_int(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _label(value, what: str = "標籤") -> str:
    if not isinstance(value, str) or not value.strip():
        raise InvalidPayload(f"{what}不可空白")
    text = value.strip()
    if len(text) > MAX_LABEL:
        raise InvalidPayload(f"{what}不可超過 {MAX_LABEL} 個字")
    return text


def _shape(value) -> tuple[int, int]:
    if (not isinstance(value, (list, tuple)) or len(value) != 2
            or not all(_is_int(v) and 1 <= v <= MAX_SIDE for v in value)):
        raise InvalidPayload(f"shape 必須是 [高, 寬]，各為 1 到 {MAX_SIDE} 的整數")
    return value[0], value[1]


def _classification(payload: dict) -> dict:
    return {"label": _label(payload.get("label"))}


def _segmentation(payload: dict) -> dict:
    height, width = _shape(payload.get("shape"))
    if payload.get("encoding") != "rle":
        raise InvalidPayload("分割標註的 encoding 必須是 rle")
    names = payload.get("label_names")
    if not isinstance(names, dict) or not names:
        raise InvalidPayload("label_names 不可為空")
    clean: dict[str, int] = {}
    for name, value in names.items():
        if not _is_int(value) or not 0 <= value <= 255:
            raise InvalidPayload("label_names 的標籤值必須是 0 到 255 的整數")
        clean[_label(name, "標籤名稱")] = value
    if clean.get("background") != 0:
        raise InvalidPayload("label_names 必須包含 background＝0")
    if len(set(clean.values())) != len(clean):
        raise InvalidPayload("label_names 的標籤值不可重複")
    rle = payload.get("rle")
    if not isinstance(rle, list):
        raise InvalidPayload("rle 必須是 [標籤值, 長度] 的清單")
    allowed, total, merged = set(clean.values()), 0, []
    for pair in rle:
        if not isinstance(pair, (list, tuple)) or len(pair) != 2 or not all(_is_int(v) for v in pair):
            raise InvalidPayload("rle 的每一段必須是 [標籤值, 長度]")
        value, run = pair
        if run <= 0:
            raise InvalidPayload("rle 的長度必須大於 0")
        if value not in allowed:
            raise InvalidPayload(f"rle 出現 label_names 沒有的標籤值 {value}")
        total += run
        if merged and merged[-1][0] == value:
            merged[-1][1] += run
        else:
            merged.append([value, run])
    if total != height * width:
        raise InvalidPayload(f"rle 長度總和 {total} 與影像大小 {height}×{width} 不符")
    return {"shape": [height, width], "encoding": "rle", "rle": merged, "label_names": clean}


def _detection(payload: dict) -> dict:
    height, width = _shape(payload.get("shape"))
    if payload.get("box_format") != "xyxy":
        raise InvalidPayload("偵測標註的 box_format 必須是 xyxy")
    boxes = payload.get("boxes")
    if not isinstance(boxes, list) or not boxes:
        raise InvalidPayload("boxes 至少要有一個框")
    if len(boxes) > MAX_BOXES:
        raise InvalidPayload(f"boxes 不可超過 {MAX_BOXES} 個")
    out = []
    for item in boxes:
        if not isinstance(item, dict):
            raise InvalidPayload("boxes 的每一項必須是物件")
        box = item.get("box")
        if not isinstance(box, (list, tuple)) or len(box) != 4 or not all(_is_int(v) for v in box):
            raise InvalidPayload("box 必須是 4 個整數 [x1, y1, x2, y2]")
        x1, y1, x2, y2 = box
        if not (0 <= x1 < x2 <= width and 0 <= y1 < y2 <= height):
            raise InvalidPayload(f"框 {list(box)} 超出影像範圍或大小為 0")
        clean = {"label": _label(item.get("label")), "box": [x1, y1, x2, y2]}
        if item.get("score") is not None:
            score = item["score"]
            if isinstance(score, bool) or not isinstance(score, (int, float)) or not 0 <= score <= 1:
                raise InvalidPayload("score 必須介於 0 與 1")
            clean["score"] = float(score)
        out.append(clean)
    return {"shape": [height, width], "box_format": "xyxy", "boxes": out}


_NORMALIZERS = {"classification": _classification, "segmentation": _segmentation, "detection": _detection}


def normalize(kind: str, payload) -> dict:
    if kind not in _NORMALIZERS:
        raise InvalidPayload(f"標註種類必須是 {'、'.join(KINDS)} 其中之一")
    if not isinstance(payload, dict):
        raise InvalidPayload("標註內容必須是物件")
    return _NORMALIZERS[kind](payload)


def labels_of(kind: str, payload: dict) -> list[str]:
    """標註用到的標籤（不含 background），供摘要統計。"""
    if kind == "classification":
        return [payload["label"]]
    if kind == "detection":
        return sorted({b["label"] for b in payload["boxes"]})
    used = {value for value, _ in payload["rle"]}
    return sorted(name for name, value in payload["label_names"].items() if value in used and value != 0)
