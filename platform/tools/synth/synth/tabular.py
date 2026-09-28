"""Synthea-like structured CSVs, a validation schema and a known-bad CSV."""

import csv
from pathlib import Path

import numpy as np

from .common import rng, write_json, write_manifest

ROWS = 100
FILES = 3
BAD_TOTAL_ROWS = 30
BAD_PER_REASON = 2

SCHEMA = {
    "description": "Column rules for the platform CSV validator (TC-B01-10).",
    "columns": [
        {"name": "patient_id", "type": "string", "required": True, "unique": True, "pattern": r"^P\d{5}$"},
        {"name": "age", "type": "integer", "required": True, "min": 18, "max": 100},
        {"name": "sex", "type": "category", "required": True, "allowed": ["M", "F"]},
        {"name": "bmi", "type": "number", "required": False, "min": 12, "max": 60},
        {"name": "sbp", "type": "integer", "required": True, "min": 70, "max": 250},
        {"name": "dbp", "type": "integer", "required": True, "min": 40, "max": 150},
        {"name": "glucose", "type": "number", "required": False, "min": 40, "max": 500},
        {"name": "smoker", "type": "category", "required": True, "allowed": ["never", "former", "current"]},
        {"name": "diagnosis", "type": "integer", "required": True, "min": 0, "max": 1},
        {"name": "time_to_event", "type": "integer", "required": True, "min": 1, "max": 3650},
        {"name": "event", "type": "integer", "required": True, "min": 0, "max": 1},
        {"name": "study_accession", "type": "string", "required": False, "pattern": r"^ACC\d{4}$"},
    ],
}
COLUMNS = [c["name"] for c in SCHEMA["columns"]]

MUTATIONS = {
    "missing_required": [("age", ""), ("sex", ""), ("sbp", ""), ("smoker", "")],
    "wrong_type": [("age", "forty"), ("sbp", "12O"), ("bmi", "n/a"), ("glucose", "high")],
    "out_of_range": [("age", "150"), ("sbp", "400"), ("bmi", "95.0"), ("time_to_event", "-5")],
    "unknown_category": [("sex", "X"), ("smoker", "sometimes"), ("sex", "unknown")],
}


def _rows(r: np.random.Generator, n: int, id_prefix: int) -> list[dict]:
    age = r.integers(25, 90, size=n)
    sex = np.where(r.random(n) < 0.5, "M", "F")
    sex[:2] = ["M", "F"]  # both sexes always present
    bmi = np.clip(r.normal(25.5, 4.5, size=n), 16, 48)
    sbp = np.clip(np.round(95 + 0.6 * age + r.normal(0, 14, size=n)), 90, 210).astype(int)
    dbp = np.clip(np.round(sbp * 0.6 + r.normal(0, 6, size=n)), 50, 120).astype(int)
    dbp = np.minimum(dbp, sbp - 20)
    glucose = np.clip(r.lognormal(np.log(105), 0.25, size=n), 60, 380)
    smoker = r.choice(["never", "former", "current"], size=n, p=[0.55, 0.25, 0.20])
    logit = (-0.8 + 0.06 * (age - 57) + 0.02 * (sbp - 130) + 0.015 * (glucose - 105)
             + 0.8 * (smoker == "current"))
    diagnosis = (r.random(n) < 1 / (1 + np.exp(-logit))).astype(int)
    diagnosis[:2] = [0, 1]
    hazard = 1 / 1500 * np.exp(0.7 * diagnosis + 0.03 * (age - 55))
    t_event = r.exponential(1 / hazard)
    t_censor = r.uniform(180, 3650, size=n)
    time = np.clip(np.round(np.minimum(t_event, t_censor)), 1, 3650).astype(int)
    event = (t_event <= t_censor).astype(int)
    event[:2] = [0, 1]
    missing_glucose = set(int(i) for i in r.choice(n, size=max(1, n // 20), replace=False))
    has_acc = r.random(n) < 0.2
    acc = r.integers(1, 21, size=n)
    rows = []
    for i in range(n):
        rows.append({
            "patient_id": f"P{id_prefix}{i + 1:04d}",
            "age": str(int(age[i])),
            "sex": str(sex[i]),
            "bmi": f"{bmi[i]:.1f}",
            "sbp": str(int(sbp[i])),
            "dbp": str(int(dbp[i])),
            "glucose": "" if i in missing_glucose else f"{glucose[i]:.1f}",
            "smoker": str(smoker[i]),
            "diagnosis": str(int(diagnosis[i])),
            "time_to_event": str(int(time[i])),
            "event": str(int(event[i])),
            "study_accession": f"ACC{int(acc[i]):04d}" if has_acc[i] else "",
        })
    return rows


def _write_csv(path: Path, rows: list[dict]) -> None:
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=COLUMNS, lineterminator="\n")
        w.writeheader()
        w.writerows(rows)


def _bad_rows(r: np.random.Generator) -> tuple[list[dict], list[dict]]:
    rows = _rows(r, BAD_TOTAL_ROWS, 9)
    reasons = [reason for reason in (*MUTATIONS, "duplicate_id") for _ in range(BAD_PER_REASON)]
    reasons = [reasons[int(i)] for i in r.permutation(len(reasons))]
    # row 0 stays clean: it is the original that duplicate rows copy
    indices = sorted(int(i) for i in r.choice(np.arange(1, BAD_TOTAL_ROWS), size=len(reasons), replace=False))
    broken = []
    for idx, reason in zip(indices, reasons):
        if reason == "duplicate_id":
            column, value = "patient_id", rows[0]["patient_id"]
        else:
            options = MUTATIONS[reason]
            column, value = options[int(r.integers(len(options)))]
        rows[idx][column] = value
        broken.append({"row": idx, "reason": reason, "column": column, "value": value})
    return rows, broken


def generate(out: Path, seed: int = 42) -> dict:
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    r = rng(seed, "tabular")
    clean_files = []
    for f in range(1, FILES + 1):
        name = f"cohort_{f:02d}.csv"
        _write_csv(out / name, _rows(r, ROWS, f))
        clean_files.append(name)
    bad, broken = _bad_rows(r)
    _write_csv(out / "bad.csv", bad)
    write_json(out / "bad_rows.json", {
        "file": "bad.csv",
        "index_base": 0,
        "index_note": "row = 0-based data row index, header excluded",
        "rows": broken,
    })
    write_json(out / "schema.json", SCHEMA)
    return write_manifest(out, {
        "kind": "tabular",
        "seed": seed,
        "counts": {"clean_files": FILES, "clean_rows": FILES * ROWS, "columns": len(COLUMNS),
                   "bad_file_rows": BAD_TOTAL_ROWS, "bad_rows": len(broken)},
        "clean_files": clean_files,
        "bad_file": "bad.csv",
        "bad_rows_file": "bad_rows.json",
        "schema_file": "schema.json",
    })
