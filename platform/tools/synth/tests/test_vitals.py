"""Bedside monitor readings for TC-C03-12 (100 readings -> Observation)."""

import datetime as dt
import json

import pytest

from synth import vitals


@pytest.fixture(scope="module")
def generated(tmp_path_factory):
    out = tmp_path_factory.mktemp("vitals")
    vitals.generate(out, seed=42, count=100)
    return out, json.loads((out / "manifest.json").read_text())


def test_100_json_lines_at_1s_intervals(generated):
    out, manifest = generated
    assert manifest["counts"] == {"readings": 100}
    lines = (out / manifest["file"]).read_text().splitlines()
    readings = [json.loads(line) for line in lines]
    assert len(readings) == 100
    times = [dt.datetime.fromisoformat(r["timestamp"]) for r in readings]
    assert all(t.tzinfo is not None for t in times)
    assert all((b - a).total_seconds() == 1 for a, b in zip(times, times[1:]))
    assert len({r["sequence"] for r in readings}) == 100


def test_values_realistic_and_mapped_to_loinc(generated):
    out, manifest = generated
    readings = [json.loads(line) for line in (out / manifest["file"]).read_text().splitlines()]
    for r in readings:
        assert 40 <= r["heart_rate"] <= 180
        assert 85 <= r["spo2"] <= 100
        assert 6 <= r["resp_rate"] <= 40
        assert r["device_id"] and r["patient_id"]
    assert len({r["heart_rate"] for r in readings}) > 5
    assert manifest["loinc"] == {"heart_rate": "8867-4", "spo2": "59408-5", "resp_rate": "9279-1"}
