"""Deterministic fixture generator for a 100-row synthetic patient table.

Run ``uv run python tests/fixtures/generate.py`` to regenerate ``patients.csv``.
"""

from __future__ import annotations

import csv
import io
import json
from datetime import date, timedelta
from pathlib import Path

import numpy as np

HERE = Path(__file__).parent
SCHEMA_PATH = HERE / "patients.schema.json"
CSV_PATH = HERE / "patients.csv"

HEADER = [
    "patient_id", "age", "sex", "bmi", "smoker", "cholesterol",
    "admit_date", "diagnosis", "outcome", "time", "event", "group",
]


def make_rows(seed: int = 0, n: int = 100, id_offset: int = 1) -> list[list[str]]:
    rng = np.random.default_rng(seed)
    rows: list[list[str]] = []
    diagnoses = ["pneumonia", "fracture", "stroke", "diabetes"]
    for i in range(n):
        age = int(rng.integers(20, 90))
        sex = "M" if rng.random() < 0.5 else "F"
        bmi = round(float(rng.normal(25, 4)), 1)
        smoker = bool(rng.random() < 0.3)
        chol = round(float(rng.normal(200, 30)), 1)
        admit = date(2024, 1, 1) + timedelta(days=int(rng.integers(0, 365)))
        diag = diagnoses[int(rng.integers(0, len(diagnoses)))]
        lin = -4.5 + 0.06 * age + 0.1 * (bmi - 25) + 0.8 * smoker
        outcome = int(rng.random() < 1 / (1 + np.exp(-lin)))
        group = "A" if rng.random() < 0.5 else "B"
        hazard = 0.01 * np.exp(0.02 * (age - 50) + (0.5 if group == "B" else 0.0))
        t = float(rng.exponential(1 / hazard))
        censor = float(rng.uniform(20, 200))
        event = int(t <= censor)
        time = round(min(t, censor), 2) + 0.01
        bmi_s = "" if i % 17 == 5 else f"{bmi}"  # a few missing BMI values
        rows.append([
            str(id_offset + i), str(age), sex, bmi_s, "true" if smoker else "false",
            f"{chol}", admit.isoformat(), diag, str(outcome), f"{time:.2f}", str(event), group,
        ])
    return rows


def to_csv_text(rows: list[list[str]], header: list[str] = HEADER) -> str:
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\n")
    writer.writerow(header)
    writer.writerows(rows)
    return buf.getvalue()


def load_schema() -> dict:
    return json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))


if __name__ == "__main__":
    CSV_PATH.write_text(to_csv_text(make_rows()), encoding="utf-8")
