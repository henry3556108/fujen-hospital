"""自動標註規格 1.0 的輸出（docs/specs/autolabel-io-format.md）：模型清單與分割結果。

只輸出規格列出的欄位（TC-B03-04 比對欄位集合差異 0），規格以外的 MONAI Label 欄位一律不轉出。
"""
from __future__ import annotations

import numpy as np

from autolabel_adapter import __version__

RLE_ORDER = "row-major, [label_value, run_length] pairs"
# MONAI Label 的模型種類中，平台規格 1.0 只用得到 segmentation（deepgrow、deepedit、scribbles 要使用者點選，不是自動標註）
SUPPORTED_TYPES = ("segmentation",)


class SpecError(ValueError):
    """MONAI Label 的回應無法轉成規格格式。"""


def label_map(labels) -> dict[str, int]:
    """MONAI Label 的 labels（{名稱: 值} 或名稱清單）→ {名稱: 值}，不含 background，依值排序。"""
    if isinstance(labels, dict):
        pairs = {str(k): int(v) for k, v in labels.items()}
    elif isinstance(labels, list):
        pairs = {str(name): i for i, name in enumerate(labels, start=1)}
    else:
        pairs = {}
    pairs = {k: v for k, v in pairs.items() if k.lower() != "background" and v != 0}
    if any(not 0 < v <= 255 for v in pairs.values()) or len(set(pairs.values())) != len(pairs):
        raise SpecError("模型的標籤值必須是 1–255 且不重複")
    return dict(sorted(pairs.items(), key=lambda kv: kv[1]))


def models_from_info(info: dict, allowed: set[str] | None = None) -> dict[str, dict]:
    """MONAI Label /info/ 的 models → 名稱 → {type, labels（{名稱: 值}）, description}。

    只收分割模型；allowed 有值時只收清單內的模型。結果依模型名稱排序。
    """
    out: dict[str, dict] = {}
    for name, meta in sorted((info.get("models") or {}).items()):
        if not isinstance(meta, dict) or meta.get("type") not in SUPPORTED_TYPES:
            continue
        if allowed and name not in allowed:
            continue
        labels = label_map(meta.get("labels"))
        if not labels:
            continue
        out[name] = {"type": meta["type"], "labels": labels, "description": str(meta.get("description") or "")}
    return out


def info_response(info: dict, models: dict[str, dict]) -> dict:
    """規格 §2：name、description、version、labels、models{type, labels, dimension, description}。

    dimension 固定為 2：MONAI Label 以整個序列（3D）推論，但這個服務依規格 1.0 對單張影像回傳 2D 遮罩。
    """
    labels: list[str] = []
    for meta in models.values():
        labels += [name for name in meta["labels"] if name not in labels]
    monai_version = str(info.get("version") or "unknown")
    return {
        "name": f"MONAI Label（{info.get('name') or 'radiology'}）",
        "description": "MONAI Label 分割模型；以整個序列做 3D 推論，回傳指定影像（切面）的 2D 遮罩",
        "version": f"{__version__}+monailabel-{monai_version}",
        "labels": labels,
        "models": {
            name: {
                "type": meta["type"],
                "labels": list(meta["labels"]),
                "dimension": 2,
                **({"description": meta["description"]} if meta["description"] else {}),
            }
            for name, meta in models.items()
        },
    }


def rle_encode(mask: np.ndarray) -> list[list[int]]:
    """2D 遮罩 → row-major 的 [標籤值, 長度] 清單，相鄰同值合併（與平台 payloads.rle_from_mask 相同）。"""
    flat = np.ascontiguousarray(mask).ravel()
    if flat.size == 0:
        return []
    starts = np.concatenate(([0], np.flatnonzero(flat[1:] != flat[:-1]) + 1))
    lengths = np.diff(np.concatenate((starts, [flat.size])))
    return [[int(v), int(n)] for v, n in zip(flat[starts], lengths)]


def segmentation_response(model: str, image: str, mask: np.ndarray, labels: dict[str, int]) -> dict:
    """規格 §3。遮罩出現 label_names 沒有的值時拒絕（不默默改成 background）。"""
    label_names = {"background": 0, **labels}
    unknown = set(np.unique(mask).tolist()) - set(label_names.values())
    if unknown:
        raise SpecError(f"模型輸出了未定義的標籤值 {sorted(unknown)}")
    height, width = mask.shape
    return {
        "model": model,
        "image": image,
        "shape": [int(height), int(width)],
        "encoding": "rle",
        "rle_order": RLE_ORDER,
        "rle": rle_encode(mask),
        "label_names": label_names,
    }
