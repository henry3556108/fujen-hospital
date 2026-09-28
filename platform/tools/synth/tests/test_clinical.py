"""FHIR ingestion sources for TC-C03-01 / TC-C03-04 (SQL, CSV, HL7 v2, JSON, 20
each) and the invalid HL7 message for TC-C03-13."""

import csv
import json
import sqlite3

import pytest

from synth import clinical, dicom


@pytest.fixture(scope="module")
def generated(tmp_path_factory):
    out = tmp_path_factory.mktemp("clinical")
    clinical.generate(out, seed=42)
    return out, json.loads((out / "manifest.json").read_text())


def segments(path):
    raw = path.read_bytes().decode("ascii")
    assert "\n" not in raw
    segs = [s for s in raw.split("\r") if s]
    return {s.split("|")[0]: s.split("|") for s in segs}, [s.split("|")[0] for s in segs]


def test_counts(generated):
    _, manifest = generated
    assert manifest["counts"] == {"patients": 20, "hl7_messages": 20, "lab_results": 20,
                                  "sql_patients": 20, "encounters": 20, "invalid_hl7": 1}


def test_hl7_adt_a01_messages(generated):
    out, manifest = generated
    files = sorted((out / "hl7").glob("*.hl7"))
    assert [f.name for f in files] == manifest["files"]["hl7"]
    assert len(files) == 20
    control_ids, pids = set(), []
    for f in files:
        seg, order = segments(f)
        assert order[0] == "MSH" and {"EVN", "PID", "PV1"} <= set(order)
        msh = seg["MSH"]
        assert msh[1] == "^~\\&"
        assert msh[8].startswith("ADT^A01")
        assert msh[11].startswith("2.")
        control_ids.add(msh[9])
        pid3 = seg["PID"][3]
        assert pid3
        pids.append(pid3.split("^")[0])
        assert seg["PID"][8] in {"M", "F"}
    assert len(control_ids) == 20
    assert pids == [p["patient_id"] for p in manifest["patients"]]


def test_invalid_hl7_missing_pid3(generated):
    out, manifest = generated
    files = sorted((out / "invalid").glob("*.hl7"))
    assert len(files) == 1
    seg, _ = segments(files[0])
    assert seg["MSH"][8].startswith("ADT^A01")
    assert seg["PID"][3] == ""
    assert seg["PID"][5]  # otherwise well-formed
    entry = manifest["invalid"][0]
    assert entry["file"] == f"invalid/{files[0].name}"
    assert entry["test_case"] == "TC-C03-13" and "PID-3" in entry["reason"]


def test_labs_json(generated):
    out, manifest = generated
    labs = json.loads((out / "labs.json").read_text())
    assert len(labs) == 20
    known = {p["patient_id"] for p in manifest["patients"]}
    assert len({lab["id"] for lab in labs}) == 20
    for lab in labs:
        assert lab["patient_id"] in known
        assert lab["loinc"] and lab["unit"] and lab["effective"]
        assert isinstance(lab["value"], (int, float))
        assert lab["reference_low"] < lab["reference_high"]


def test_patients_sql_executes(generated):
    out, manifest = generated
    sql = (out / "patients.sql").read_text()
    assert sql.count("CREATE TABLE") == 1
    assert sql.count("INSERT INTO") == 20
    db = sqlite3.connect(":memory:")  # plain ANSI subset, also valid PostgreSQL
    db.executescript(sql)
    rows = db.execute("SELECT patient_id, sex FROM patients ORDER BY patient_id").fetchall()
    assert [r[0] for r in rows] == sorted(p["patient_id"] for p in manifest["patients"])
    assert {r[1] for r in rows} == {"M", "F"}


def test_encounters_csv(generated):
    out, manifest = generated
    with open(out / "encounters.csv", newline="") as f:
        rows = list(csv.DictReader(f))
    assert len(rows) == 20
    assert len({r["encounter_id"] for r in rows}) == 20
    known = {p["patient_id"] for p in manifest["patients"]}
    for r in rows:
        assert r["patient_id"] in known
        assert r["start"] < r["end"]


def test_patients_are_the_dicom_patients(generated, tmp_path):
    _, manifest = generated
    d = dicom.generate(tmp_path, seed=42, studies=20)
    assert [(p["patient_id"], p["sex"]) for p in manifest["patients"]] == \
        [(s["patient_id"], s["patient_sex"]) for s in d["studies"]]
