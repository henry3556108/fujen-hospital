import csv
import datetime as dt
import json

import pytest

from app.fhir import hl7v2, mapping
from app.fhir.mapping import BUILTIN, RecordRejected, apply, set_path, validate_mapping
from app.fhir.resources import validate


def test_set_path_builds_nested_lists_and_objects():
    target = {}
    set_path(target, "name[0].given[0]", "JACK")
    set_path(target, "name[0].family", "TSAI")
    set_path(target, "code.coding[0].code", "x")
    set_path(target, "gender", "male")
    assert target == {"name": [{"given": ["JACK"], "family": "TSAI"}], "code": {"coding": [{"code": "x"}]},
                      "gender": "male"}


@pytest.mark.parametrize("name", sorted(BUILTIN))
def test_builtin_mappings_are_well_formed(name):
    assert validate_mapping(BUILTIN[name]["mapping"]) == []


@pytest.mark.parametrize("bad, expected", [
    ({}, "resources"),
    ({"resources": [{"resourceType": "Medication", "key": {"system": "s", "from": "id"}, "fields": []}]},
     "resourceType"),
    ({"resources": [{"resourceType": "Patient", "fields": []}]}, "key"),
    ({"resources": [{"resourceType": "Patient", "key": {"system": "s", "from": "a", "template": "b"},
                     "fields": []}]}, "key"),
    ({"resources": [{"resourceType": "Patient", "key": {"system": "s", "from": "id"},
                     "fields": [{"path": "name[x]", "from": "a"}]}]}, "path"),
    ({"resources": [{"resourceType": "Patient", "key": {"system": "s", "from": "id"},
                     "fields": [{"path": "identifier[0].value", "from": "a"}]}]}, "identifier"),
    ({"resources": [{"resourceType": "Patient", "key": {"system": "s", "from": "id"},
                     "fields": [{"path": "gender", "from": "a", "const": "b"}]}]}, "其中之一"),
    ({"resources": [{"resourceType": "Patient", "key": {"system": "s", "from": "id"},
                     "fields": [{"path": "gender", "from": "a", "transform": "rot13"}]}]}, "transform"),
])
def test_malformed_mappings_are_reported(bad, expected):
    assert any(expected in p for p in validate_mapping(bad))


def test_tc_c03_05_rule_set_1_sql_rows_to_patient():
    row = {"patient_id": "SYN-42-0001", "family_name": "TSAI", "given_name": "JACK", "sex": "M",
           "birth_date": dt.date(1965, 3, 20), "phone": "+886-2-5550-0001"}
    [mapped] = apply(BUILTIN["sql-patient"]["mapping"], row)
    assert mapped.resource == {
        "resourceType": "Patient",
        "identifier": [{"system": "urn:ai-platform:mrn", "value": "SYN-42-0001"}],
        "name": [{"family": "TSAI", "given": ["JACK"]}],
        "gender": "male", "birthDate": "1965-03-20",
        "telecom": [{"system": "phone", "value": "+886-2-5550-0001"}],
    }
    assert mapped.condition == "Patient?identifier=urn:ai-platform:mrn|SYN-42-0001"
    assert validate(mapped.resource) == []


def test_tc_c03_05_rule_set_2_csv_rows_to_encounter(clinical):
    with open(clinical / "encounters.csv", encoding="utf-8") as f:
        row = next(csv.DictReader(f))
    [mapped] = apply(BUILTIN["csv-encounter"]["mapping"], row)
    assert mapped.resource == {
        "resourceType": "Encounter",
        "identifier": [{"system": "urn:ai-platform:encounter", "value": "ENC0001"}],
        "status": "finished",
        "class": {"system": "http://terminology.hl7.org/CodeSystem/v3-ActCode", "code": "IMP"},
        "serviceType": {"text": "Internal Medicine"},
        "subject": {"reference": "Patient?identifier=urn:ai-platform:mrn|SYN-42-0001"},
        "period": {"start": "2024-09-12T11:08:00+08:00", "end": "2024-09-16T14:08:00+08:00"},
    }
    assert validate(mapped.resource) == []


def test_tc_c03_05_rule_set_3_json_labs_to_observation(clinical):
    lab = json.loads((clinical / "labs.json").read_text(encoding="utf-8"))[0]
    [mapped] = apply(BUILTIN["json-lab-observation"]["mapping"], lab)
    assert mapped.resource == {
        "resourceType": "Observation",
        "identifier": [{"system": "urn:ai-platform:lab", "value": "LAB0001"}],
        "status": "final",
        "category": [{"coding": [{"system": "http://terminology.hl7.org/CodeSystem/observation-category",
                                  "code": "laboratory"}]}],
        "code": {"coding": [{"system": "http://loinc.org", "code": "2345-7",
                             "display": "Glucose [Mass/volume] in Serum or Plasma"}]},
        "subject": {"reference": "Patient?identifier=urn:ai-platform:mrn|SYN-42-0001"},
        "effectiveDateTime": "2024-09-12T13:08:00+08:00",
        "valueQuantity": {"value": 101.8, "unit": "mg/dL", "system": "http://unitsofmeasure.org", "code": "mg/dL"},
        "referenceRange": [{"low": {"value": 70}, "high": {"value": 99}}],
    }
    assert validate(mapped.resource) == []


def test_hl7_adt_maps_to_patient_and_encounter(hl7_messages):
    patient, encounter = apply(BUILTIN["hl7v2-adt"]["mapping"], hl7v2.to_record(hl7_messages[0]))
    assert patient.resource["resourceType"] == "Patient" and patient.resource["gender"] == "male"
    assert patient.resource["address"] == [{"line": ["100 SYNTH RD"], "city": "TAIPEI", "postalCode": "100",
                                            "country": "TW"}]
    assert encounter.resource["class"]["code"] == "IMP"
    assert encounter.resource["period"] == {"start": "2024-09-12T11:08:00+08:00"}
    assert encounter.resource["location"] == [{"location": {"display": "W01-100-1"}}]
    assert encounter.condition == "Encounter?identifier=urn:ai-platform:visit|VN0001"
    assert validate(patient.resource) == [] and validate(encounter.resource) == []


def test_vitals_reading_maps_to_three_observations(vitals):
    observations = apply(BUILTIN["monitor-vitals"]["mapping"], vitals[0])
    assert [o.resource["code"]["coding"][0]["code"] for o in observations] == ["8867-4", "59408-5", "9279-1"]
    assert [o.value for o in observations] == ["MON-SYNTH-01-1-heart_rate", "MON-SYNTH-01-1-spo2",
                                               "MON-SYNTH-01-1-resp_rate"]
    assert observations[0].resource["valueQuantity"] == {"value": 79, "unit": "/min",
                                                         "system": "http://unitsofmeasure.org", "code": "/min"}
    assert all(validate(o.resource) == [] for o in observations)


def test_missing_required_field_and_unmapped_code_are_both_reported():
    row = {"patient_id": "X1", "family_name": "", "given_name": "A", "sex": "Q", "birth_date": "1965-03-20"}
    with pytest.raises(RecordRejected) as exc:
        apply(BUILTIN["sql-patient"]["mapping"], row)
    assert any("family_name" in r for r in exc.value.reasons)
    assert any("'Q'" in r and "對照表" in r for r in exc.value.reasons)


def test_missing_key_field_rejects_record():
    with pytest.raises(RecordRejected) as exc:
        apply(BUILTIN["sql-patient"]["mapping"], {"family_name": "A", "given_name": "B", "sex": "M",
                                                  "birth_date": "1965-03-20"})
    assert any("patient_id" in r for r in exc.value.reasons)


@pytest.mark.parametrize("transform, value, expected", [
    ("date", "19650320", "1965-03-20"), ("date", "1965-03-20", "1965-03-20"),
    ("date", dt.datetime(1965, 3, 20, 8), "1965-03-20"),
    ("datetime", "20240912110800", "2024-09-12T11:08:00+08:00"),
    ("datetime", "2024-09-12T11:08:00", "2024-09-12T11:08:00+08:00"),
    ("datetime", "2024-09-12T11:08:00Z", "2024-09-12T11:08:00Z"),
    ("number", "101.8", 101.8), ("number", 70, 70), ("integer", "16", 16),
    ("upper", "imp", "IMP"), ("string", 5, "5"),
])
def test_transforms(transform, value, expected):
    rules = {"resources": [{"resourceType": "Patient", "key": {"system": "s", "from": "id"},
                            "fields": [{"path": "x", "from": "v", "transform": transform}]}]}
    [mapped] = apply(rules, {"id": "1", "v": value})
    assert mapped.resource["x"] == expected


@pytest.mark.parametrize("transform, value", [("date", "1965-13-40"), ("datetime", "yesterday"),
                                              ("number", "abc"), ("number", "nan"), ("integer", "1.5")])
def test_bad_values_are_rejected(transform, value):
    rules = {"resources": [{"resourceType": "Patient", "key": {"system": "s", "from": "id"},
                            "fields": [{"path": "x", "from": "v", "transform": transform}]}]}
    with pytest.raises(RecordRejected):
        apply(rules, {"id": "1", "v": value})
