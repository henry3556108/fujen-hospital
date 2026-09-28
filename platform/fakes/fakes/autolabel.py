"""Fake auto-labeling service: the subset of the MONAI Label HTTP API the platform calls.

Outputs depend only on (model, image id) via SHA-256, so they are reproducible.
Test double only. Never deploy to a customer production environment.
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterator
from typing import Any

from fastapi import FastAPI, HTTPException, Query

from fakes import faults
from fakes.cli import serve

SHAPE = (64, 64)  # (height, width) of the fake 2D slice
LABELS = {"background": 0, "lung": 1, "nodule": 2}
MODELS: dict[str, dict[str, Any]] = {
    "fake_segmentation": {
        "type": "segmentation",
        "labels": ["lung", "nodule"],
        "dimension": 2,
        "description": "Deterministic fake segmentation (hash of image id)",
    },
    "fake_detection": {
        "type": "detection",
        "labels": ["lung", "nodule"],
        "dimension": 2,
        "description": "Deterministic fake detection (hash of image id)",
    },
}

app = FastAPI(title="fake-autolabel", description="Fake MONAI Label subset. Test use only.")
faults.install(app, "FAKE_AUTOLABEL", lambda status, message: {"detail": message})


def _stream(model: str, image: str) -> Iterator[int]:
    """Endless deterministic byte stream seeded by model + image id."""
    block = 0
    while True:
        yield from hashlib.sha256(f"{model}\x00{image}\x00{block}".encode()).digest()
        block += 1


def _between(rng: Iterator[int], lo: int, hi: int) -> int:
    """Deterministic int in [lo, hi]."""
    value = (next(rng) << 8) | next(rng)
    return lo + value % (hi - lo + 1)


def _segmentation(image: str) -> dict[str, Any]:
    h, w = SHAPE
    rng = _stream("fake_segmentation", image)
    # One lung ellipse plus one nodule disc inside it.
    cy, cx = _between(rng, 24, 40), _between(rng, 24, 40)
    ry, rx = _between(rng, 12, 20), _between(rng, 10, 18)
    ny, nx = cy + _between(rng, -6, 6), cx + _between(rng, -6, 6)
    nr = _between(rng, 2, 5)
    flat: list[int] = []
    for y in range(h):
        for x in range(w):
            if (y - ny) ** 2 + (x - nx) ** 2 <= nr * nr:
                flat.append(LABELS["nodule"])
            elif ((y - cy) / ry) ** 2 + ((x - cx) / rx) ** 2 <= 1.0:
                flat.append(LABELS["lung"])
            else:
                flat.append(LABELS["background"])
    rle: list[list[int]] = []
    for v in flat:
        if rle and rle[-1][0] == v:
            rle[-1][1] += 1
        else:
            rle.append([v, 1])
    return {
        "shape": [h, w],
        "encoding": "rle",
        "rle_order": "row-major, [label_value, run_length] pairs",
        "rle": rle,
        "label_names": dict(LABELS),
    }


def _detection(image: str) -> dict[str, Any]:
    h, w = SHAPE
    rng = _stream("fake_detection", image)
    boxes = []
    for _ in range(_between(rng, 1, 3)):
        x1, y1 = _between(rng, 0, w - 9), _between(rng, 0, h - 9)
        x2 = min(w, x1 + _between(rng, 4, 24))
        y2 = min(h, y1 + _between(rng, 4, 24))
        label = "nodule" if next(rng) % 2 else "lung"
        score = round(0.5 + _between(rng, 0, 499) / 1000, 3)
        boxes.append({"label": label, "box": [x1, y1, x2, y2], "score": score})
    return {"shape": [h, w], "box_format": "xyxy", "boxes": boxes}


@app.get("/info/")
def info() -> dict[str, Any]:
    return {
        "name": "fake-monailabel",
        "description": "Fake MONAI Label app for smoke tests. Never deploy to production.",
        "version": "0.0.1-fake",
        "labels": [name for name in LABELS if name != "background"],
        "models": MODELS,
    }


@app.post("/infer/{model}")
def infer(model: str, image: str = Query(..., min_length=1)) -> dict[str, Any]:
    if model not in MODELS:
        raise HTTPException(status_code=404, detail=f"Model '{model}' not found")
    result = _segmentation(image) if MODELS[model]["type"] == "segmentation" else _detection(image)
    return {"model": model, "image": image, **result}


def main(argv: list[str] | None = None) -> None:
    serve(app, "autolabel", 8102, argv)


if __name__ == "__main__":
    main()
