"""Clinical sources for FHIR ingestion: HL7 v2 ADT^A01, lab JSON, SQL, encounter CSV.

All four sources describe the same 20 patients as the `dicom` command (same seed).
"""

import csv
import datetime as dt
from pathlib import Path

from .common import patients, rng, write_json, write_manifest

COUNT = 20
LABS = [  # (LOINC, display, unit, low, high, mean, sd)
    ("2345-7", "Glucose [Mass/volume] in Serum or Plasma", "mg/dL", 70, 99, 105, 20),
    ("718-7", "Hemoglobin [Mass/volume] in Blood", "g/dL", 12.0, 17.5, 14, 1.5),
    ("2160-0", "Creatinine [Mass/volume] in Serum or Plasma", "mg/dL", 0.6, 1.3, 1.0, 0.25),
    ("6690-2", "Leukocytes [#/volume] in Blood by Automated count", "10*3/uL", 4.0, 11.0, 7.5, 2.0),
    ("2951-2", "Sodium [Moles/volume] in Serum or Plasma", "mmol/L", 135, 145, 140, 3),
]
ENCOUNTER_CLASSES = ["IMP", "AMB", "EMER"]
DEPARTMENTS = ["Internal Medicine", "Radiology", "Emergency", "Cardiology", "Oncology"]


def _hl7(control_id: str, ts: str, pat: dict, pid3: str, visit: str, room: int) -> bytes:
    segs = [
        f"MSH|^~\\&|SYNTH_HIS|SYNTH_HOSP|FHIR_GW|AI_PLATFORM|{ts}||ADT^A01^ADT_A01|{control_id}|P|2.5.1",
        f"EVN|A01|{ts}",
        f"PID|1||{pid3}||{pat['family']}^{pat['given']}||{pat['birth_date']}|{pat['sex']}"
        f"|||{room} SYNTH RD^^TAIPEI^^100^TW",
        f"PV1|1|I|W01^{room}^1||||D001^SYNTH^ATTENDING|||MED||||1|||D001^SYNTH^ATTENDING|IP|{visit}",
    ]
    return ("\r".join(segs) + "\r").encode("ascii")


def _iso(t: dt.datetime) -> str:
    return t.strftime("%Y-%m-%dT%H:%M:%S+08:00")


def _sql_str(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"


def generate(out: Path, seed: int = 42) -> dict:
    out = Path(out)
    (out / "hl7").mkdir(parents=True, exist_ok=True)
    (out / "invalid").mkdir(parents=True, exist_ok=True)
    r = rng(seed, "clinical")
    roster = patients(seed, COUNT)
    admits = [
        dt.datetime(2024, 1, 1, 8) + dt.timedelta(days=int(d), minutes=int(m))
        for d, m in zip(r.choice(360, size=COUNT, replace=False), r.integers(0, 600, size=COUNT))
    ]

    hl7_files = []
    for i, (pat, admit) in enumerate(zip(roster, admits)):
        name = f"adt_a01_{i + 1:04d}.hl7"
        msg = _hl7(f"MSG{seed}-{i + 1:04d}", admit.strftime("%Y%m%d%H%M%S"), pat,
                   f"{pat['patient_id']}^^^SYNTH^MR", f"VN{i + 1:04d}", 100 + i)
        (out / "hl7" / name).write_bytes(msg)
        hl7_files.append(name)

    invalid_name = "adt_a01_missing_pid3.hl7"
    (out / "invalid" / invalid_name).write_bytes(
        _hl7(f"MSG{seed}-INV1", admits[0].strftime("%Y%m%d%H%M%S"), roster[0], "", "VN9999", 999))

    labs = []
    for i, pat in enumerate(roster):
        code, display, unit, low, high, mean, sd = LABS[i % len(LABS)]
        value = round(max(0.1, float(r.normal(mean, sd))), 1)
        labs.append({
            "id": f"LAB{i + 1:04d}",
            "patient_id": pat["patient_id"],
            "loinc": code,
            "display": display,
            "value": value,
            "unit": unit,
            "reference_low": low,
            "reference_high": high,
            "effective": _iso(admits[i] + dt.timedelta(hours=2)),
            "status": "final",
        })
    write_json(out / "labs.json", labs)

    lines = [
        "CREATE TABLE patients (",
        "    patient_id VARCHAR(20) PRIMARY KEY,",
        "    family_name VARCHAR(64) NOT NULL,",
        "    given_name VARCHAR(64) NOT NULL,",
        "    sex CHAR(1) NOT NULL CHECK (sex IN ('M', 'F')),",
        "    birth_date DATE NOT NULL,",
        "    phone VARCHAR(32)",
        ");",
    ]
    for i, pat in enumerate(roster):
        b = pat["birth_date"]
        values = ", ".join([_sql_str(pat["patient_id"]), _sql_str(pat["family"]), _sql_str(pat["given"]),
                            _sql_str(pat["sex"]), _sql_str(f"{b[:4]}-{b[4:6]}-{b[6:]}"),
                            _sql_str(f"+886-2-5550-{i + 1:04d}")])
        lines.append("INSERT INTO patients (patient_id, family_name, given_name, sex, birth_date, phone) "
                     f"VALUES ({values});")
    (out / "patients.sql").write_text("\n".join(lines) + "\n", encoding="utf-8")

    with open(out / "encounters.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["encounter_id", "patient_id", "class", "department",
                                          "start", "end", "status"], lineterminator="\n")
        w.writeheader()
        for i, (pat, admit) in enumerate(zip(roster, admits)):
            w.writerow({
                "encounter_id": f"ENC{i + 1:04d}",
                "patient_id": pat["patient_id"],
                "class": ENCOUNTER_CLASSES[i % len(ENCOUNTER_CLASSES)],
                "department": DEPARTMENTS[int(r.integers(len(DEPARTMENTS)))],
                "start": _iso(admit),
                "end": _iso(admit + dt.timedelta(hours=int(r.integers(2, 120)))),
                "status": "finished",
            })

    return write_manifest(out, {
        "kind": "clinical",
        "seed": seed,
        "counts": {"patients": COUNT, "hl7_messages": COUNT, "lab_results": COUNT,
                   "sql_patients": COUNT, "encounters": COUNT, "invalid_hl7": 1},
        "patients": [{"patient_id": p["patient_id"], "sex": p["sex"]} for p in roster],
        "files": {"hl7": hl7_files, "labs": "labs.json", "sql": "patients.sql",
                  "encounters": "encounters.csv"},
        "invalid": [{"file": f"invalid/{invalid_name}", "test_case": "TC-C03-13",
                     "reason": "PID-3 (patient identifier list) is empty"}],
    })
