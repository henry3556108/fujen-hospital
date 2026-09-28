"""Simulated bedside-monitor readings (JSON lines, one per second)."""

import datetime as dt
import json
from pathlib import Path

import numpy as np

from .common import patients, rng, write_manifest

LOINC = {"heart_rate": "8867-4", "spo2": "59408-5", "resp_rate": "9279-1"}
UNITS = {"heart_rate": "/min", "spo2": "%", "resp_rate": "/min"}
TZ = dt.timezone(dt.timedelta(hours=8))


def generate(out: Path, seed: int = 42, count: int = 100) -> dict:
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    r = rng(seed, "vitals")
    patient_id = patients(seed, 1)[0]["patient_id"]
    start = dt.datetime(2024, 6, 1, 10, 0, 0, tzinfo=TZ) + dt.timedelta(minutes=int(r.integers(0, 600)))
    # slow random walks around physiological baselines
    hr = np.clip(78 + np.cumsum(r.normal(0, 0.8, count)), 50, 150)
    spo2 = np.clip(97 + np.cumsum(r.normal(0, 0.15, count)), 90, 100)
    rr = np.clip(16 + np.cumsum(r.normal(0, 0.3, count)), 10, 30)
    lines = []
    for i in range(count):
        lines.append(json.dumps({
            "sequence": i + 1,
            "device_id": "MON-SYNTH-01",
            "patient_id": patient_id,
            "timestamp": (start + dt.timedelta(seconds=i)).isoformat(),
            "heart_rate": int(round(hr[i])),
            "spo2": int(round(spo2[i])),
            "resp_rate": int(round(rr[i])),
        }, sort_keys=True))
    (out / "vitals.jsonl").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return write_manifest(out, {
        "kind": "vitals",
        "seed": seed,
        "counts": {"readings": count},
        "file": "vitals.jsonl",
        "loinc": LOINC,
        "units": UNITS,
    })
