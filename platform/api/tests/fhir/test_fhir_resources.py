import copy

import pytest

from app.fhir.resources import validate

PATIENT = {"resourceType": "Patient", "identifier": [{"system": "urn:synth:mrn", "value": "SYN-42-0001"}],
           "name": [{"family": "TSAI", "given": ["JACK"]}], "gender": "male", "birthDate": "1965-03-20"}
ENCOUNTER = {"resourceType": "Encounter", "identifier": [{"system": "urn:synth:encounter", "value": "ENC0001"}],
             "status": "finished",
             "class": {"system": "http://terminology.hl7.org/CodeSystem/v3-ActCode", "code": "IMP"},
             "subject": {"reference": "Patient?identifier=urn:synth:mrn|SYN-42-0001"},
             "period": {"start": "2024-09-12T11:08:00+08:00", "end": "2024-09-16T14:08:00+08:00"}}
OBSERVATION = {"resourceType": "Observation", "identifier": [{"system": "urn:synth:lab", "value": "LAB0001"}],
               "status": "final",
               "code": {"coding": [{"system": "http://loinc.org", "code": "2345-7"}]},
               "subject": {"reference": "Patient?identifier=urn:synth:mrn|SYN-42-0001"},
               "effectiveDateTime": "2024-09-12T13:08:00+08:00",
               "valueQuantity": {"value": 101.8, "unit": "mg/dL", "system": "http://unitsofmeasure.org",
                                 "code": "mg/dL"}}


@pytest.mark.parametrize("resource", [PATIENT, ENCOUNTER, OBSERVATION], ids=lambda r: r["resourceType"])
def test_valid_resources_pass(resource):
    assert validate(resource) == []


def _without(resource, key):
    r = copy.deepcopy(resource)
    r.pop(key)
    return r


@pytest.mark.parametrize("resource, expected", [
    ({**PATIENT, "gender": "Q"}, "gender"),
    ({**PATIENT, "birthDate": "1965-13-20"}, "birthDate"),
    ({**PATIENT, "unknownField": 1}, "unknownField"),
    (_without(PATIENT, "identifier"), "identifier"),
    ({**ENCOUNTER, "status": "done"}, "status"),
    (_without(ENCOUNTER, "class"), "class"),
    (_without(ENCOUNTER, "subject"), "subject.reference"),
    (_without(OBSERVATION, "status"), "status"),
    ({**OBSERVATION, "code": {"text": "glucose"}}, "code.coding"),
    (_without(OBSERVATION, "valueQuantity"), "value[x]"),
    (_without(OBSERVATION, "effectiveDateTime"), "effective[x]"),
    ({"resourceType": "Medication"}, "不支援的資源型別"),
])
def test_invalid_resources_list_the_problem(resource, expected):
    issues = validate(resource)
    assert any(expected in i for i in issues), issues
