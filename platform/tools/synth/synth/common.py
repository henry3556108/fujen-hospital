"""Shared helpers: seeded RNG streams, UID derivation, manifest writing."""

import json
import zlib
from pathlib import Path

import numpy as np

UID_ROOT = "1.2.826.0.1.3680043.10.9999."
DEFAULT_SEED = 42

FIRST_NAMES = ["WEI", "MEI", "JUN", "LING", "HAO", "YU", "CHEN", "TING", "JIE", "XIN",
               "ANNA", "BEN", "CLARA", "DAVID", "EMMA", "FRANK", "GRACE", "HENRY", "IRIS", "JACK"]
LAST_NAMES = ["CHANG", "LIN", "WANG", "HUANG", "LIU", "TSAI", "YANG", "HSU", "CHENG", "WU",
              "SMITH", "JONES", "BROWN", "TAYLOR", "WILSON", "DAVIS", "CLARK", "LEWIS", "WALKER", "HALL"]


def rng(seed: int, stream: str) -> np.random.Generator:
    """Independent, reproducible random stream per (seed, purpose)."""
    return np.random.default_rng([seed, zlib.crc32(stream.encode())])


def uid(seed: int, *parts: int) -> str:
    """Deterministic DICOM UID under the fixed test root: ROOT + seed + parts."""
    return UID_ROOT + ".".join(str(int(p)) for p in (seed, *parts))


def unique_names(r: np.random.Generator, n: int) -> list[tuple[str, str]]:
    """n distinct (last, first) name pairs."""
    pairs = [(last, first) for last in LAST_NAMES for first in FIRST_NAMES]
    idx = r.choice(len(pairs), size=n, replace=False)
    return [pairs[int(i)] for i in idx]


def write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")


def write_manifest(out: Path, manifest: dict) -> dict:
    write_json(Path(out) / "manifest.json", manifest)
    return manifest
