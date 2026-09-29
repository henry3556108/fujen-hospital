import json

import pytest
from sqlalchemy import select

from app.fhir import etl
from app.fhir.mapping import BUILTIN
from app.fhir.models import FhirMapping, FhirRun, FhirSource
from app.models import AuditLog


@pytest.fixture
def project(make_project):
    return make_project("P-fhir")


@pytest.fixture
def add(session, project):
    def _add(obj):
        session.add(obj)
        session.commit()
        return obj
    return _add


@pytest.fixture
def builtin(add, project):
    made = {}

    def _mapping(name):
        if name not in made:
            b = BUILTIN[name]
            made[name] = add(FhirMapping(project_id=project.id, name=name, source_kind=b["source_kind"],
                                         rules=b["mapping"], created_by="admin01"))
        return made[name]
    return _mapping


@pytest.fixture
def sources(add, project, clinical, hl7_messages, his_dsn):
    def src(name, kind, config=None, content=None):
        return add(FhirSource(project_id=project.id, name=name, kind=kind, config=config or {}, content=content,
                              created_by="admin01"))
    return {
        "sql": src("his-patients", "sql", {"dsn": his_dsn, "query": "SELECT * FROM patients"}),
        "csv": src("encounters", "csv", content=(clinical / "encounters.csv").read_text(encoding="utf-8")),
        "json": src("labs", "json", content=(clinical / "labs.json").read_text(encoding="utf-8")),
        "hl7v2": src("adt", "hl7v2", content="\n".join(hl7_messages)),
    }


def run(session, fhir, project, source, mapping, **kwargs):
    return etl.run_etl(session, fhir, project=project, source=source, mapping=mapping, actor="admin01",
                       source_ip="10.0.0.9", **kwargs)


def audits(session):
    return list(session.scalars(select(AuditLog).where(AuditLog.category == "data_exchange").order_by(AuditLog.id)))


def test_tc_c03_04_four_sources_write_matching_counts(session, fhir, project, sources, builtin):
    expectations = [("sql", "sql-patient", {"Patient": 20}), ("csv", "csv-encounter", {"Encounter": 20}),
                    ("json", "json-lab-observation", {"Observation": 20}),
                    ("hl7v2", "hl7v2-adt", {"Patient": 20, "Encounter": 20})]
    for kind, mapping_name, written in expectations:
        result = run(session, fhir, project, sources[kind], builtin(mapping_name))
        assert (result.status, result.records_read, result.resources_written) == ("succeeded", 20, written), \
            (kind, result.errors)
    # HL7 的 20 位病人與 SQL 的是同一批（同一個病歷號），不會重複建立
    assert fhir.count(project.id, "Patient") == 20
    assert fhir.count(project.id, "Encounter") == 40
    assert fhir.count(project.id, "Observation") == 20


def test_tc_c03_01_twenty_of_each_resource_type_validate(session, fhir, project, sources, builtin):
    from app.fhir.resources import validate
    run(session, fhir, project, sources["sql"], builtin("sql-patient"))
    run(session, fhir, project, sources["csv"], builtin("csv-encounter"))
    run(session, fhir, project, sources["json"], builtin("json-lab-observation"))
    for kind in ("Patient", "Encounter", "Observation"):
        rows = fhir.all(project.id, kind)
        assert len(rows) == 20
        stored = [{k: v for k, v in r.items() if k not in ("id", "meta")} for r in rows]
        assert [validate(r) for r in stored] == [[]] * 20


def test_rerun_is_idempotent(session, fhir, project, sources, builtin):
    mapping = builtin("sql-patient")
    run(session, fhir, project, sources["sql"], mapping)
    again = run(session, fhir, project, sources["sql"], mapping)
    assert again.status == "succeeded" and fhir.count(project.id, "Patient") == 20


def test_references_require_the_patient_to_exist(session, fhir, project, sources, builtin):
    result = run(session, fhir, project, sources["csv"], builtin("csv-encounter"))
    assert result.status == "failed" and "找不到唯一的資源" in result.errors[0]["reasons"][0]
    assert fhir.count(project.id, "Encounter") == 0


def test_tc_c03_13_one_bad_record_rejects_the_whole_batch(session, fhir, project, add, clinical, builtin):
    rows = json.loads((clinical / "labs.json").read_text(encoding="utf-8"))
    rows[7]["loinc"] = ""
    rows[12]["value"] = "high"
    source = add(FhirSource(project_id=project.id, name="bad-labs", kind="json", content=json.dumps(rows),
                            created_by="admin01"))
    result = run(session, fhir, project, source, builtin("json-lab-observation"))
    assert result.status == "rejected" and result.records_read == 20 and result.resources_written == {}
    assert [e["index"] for e in result.errors] == [7, 12]
    assert "loinc" in result.errors[0]["reasons"][0] and "不是數字" in result.errors[1]["reasons"][0]
    assert fhir.transactions == 0 and fhir.tenants() == []


def test_tc_c03_13_batch_with_invalid_hl7_is_rejected_with_reasons(session, fhir, project, add, hl7_messages,
                                                                  invalid_hl7, builtin):
    source = add(FhirSource(project_id=project.id, name="adt-bad", kind="hl7v2", created_by="admin01",
                            content="\n".join(hl7_messages[:5] + list(invalid_hl7.values()))))
    result = run(session, fhir, project, source, builtin("hl7v2-adt"))
    assert result.status == "rejected" and fhir.transactions == 0
    assert {e["control_id"] for e in result.errors} == {"MSG42-INV1", "MSG42-INV2"}


@pytest.mark.parametrize("cut", [0, 7, 19])
def test_tc_c03_07_interrupted_write_leaves_nothing_behind(session, fhir, project, sources, builtin, cut):
    mapping = builtin("sql-patient")
    fhir.ensure_tenant(project.id)
    fhir.fail_after_entries = cut
    result = run(session, fhir, project, sources["sql"], mapping)
    assert result.status == "failed" and result.resources_written == {}
    assert fhir.count(project.id, "Patient") == 0
    retry = run(session, fhir, project, sources["sql"], mapping)
    assert retry.status == "succeeded" and fhir.count(project.id, "Patient") == 20


def test_fhir_server_offline_is_recorded_as_failed(session, fhir, project, sources, builtin):
    fhir.offline = True
    result = run(session, fhir, project, sources["sql"], builtin("sql-patient"))
    assert result.status == "failed" and "無法連線" in result.errors[0]["reasons"][0]


def test_mapping_for_another_source_kind_is_rejected(session, fhir, project, sources, builtin):
    result = run(session, fhir, project, sources["csv"], builtin("sql-patient"))
    assert result.status == "rejected" and "不符" in result.errors[0]["reasons"][0]


def test_tc_c03_09_every_run_is_audited_with_its_outcome(session, fhir, project, sources, builtin):
    run(session, fhir, project, sources["sql"], builtin("sql-patient"))
    run(session, fhir, project, sources["csv"], builtin("sql-patient"))
    fhir.offline = True
    run(session, fhir, project, sources["json"], builtin("json-lab-observation"))
    rows = audits(session)
    assert [(a.action, a.result) for a in rows] == [("fhir.etl.run", "success"), ("fhir.etl.run", "rejected"),
                                                    ("fhir.etl.run", "failed")]
    first = rows[0]
    assert first.actor == "admin01" and first.source_ip == "10.0.0.9" and first.at is not None
    assert first.target == f"project:{project.id}/source:{sources['sql'].id}"
    assert first.detail["records_read"] == 20 and first.detail["resources_written"] == {"Patient": 20}
    assert session.scalar(select(FhirRun).where(FhirRun.id == first.detail["run_id"])).status == "succeeded"


def test_hl7_single_message_writes_patient_and_encounter_together(session, fhir, project, hl7_messages):
    result = etl.ingest_hl7(session, fhir, project=project, raw=hl7_messages[0], actor="admin01")
    assert result.status == "succeeded" and result.resources_written == {"Patient": 1, "Encounter": 1}
    [enc] = fhir.all(project.id, "Encounter")
    assert enc["subject"]["reference"] == f"Patient/{fhir.all(project.id, 'Patient')[0]['id']}"
    assert audits(session)[-1].detail["control_id"] == "MSG42-0001"


def test_tc_c03_13_invalid_hl7_message_is_rejected_and_reason_recorded(session, fhir, project, invalid_hl7):
    for name, expected in [("adt_a01_missing_pid3.hl7", "PID-3"), ("adt_a01_bad_sex_code.hl7", "PID-8")]:
        result = etl.ingest_hl7(session, fhir, project=project, raw=invalid_hl7[name], actor="admin01")
        assert result.status == "rejected" and expected in result.errors[0]["reasons"][0]
    assert fhir.transactions == 0 and fhir.tenants() == []
    assert [(a.action, a.result) for a in audits(session)] == [("fhir.hl7v2.receive", "rejected")] * 2
    stored = list(session.scalars(select(FhirRun).order_by(FhirRun.id)))
    assert [r.errors[0]["control_id"] for r in stored] == ["MSG42-INV1", "MSG42-INV2"]


def test_tc_c03_12_hundred_monitor_readings_become_observations(session, fhir, project, vitals, sources, builtin):
    run(session, fhir, project, sources["sql"], builtin("sql-patient"))
    for reading in vitals:   # 即時：一筆讀數一次請求
        assert etl.ingest_vitals(session, fhir, project=project, readings=[reading], actor="admin01"
                                 ).status == "succeeded"
    observations = fhir.all(project.id, "Observation")
    assert len(observations) == 300
    [patient] = [p for p in fhir.all(project.id, "Patient") if p["identifier"][0]["value"] == "SYN-42-0001"]
    by_key = {o["identifier"][0]["value"]: o for o in observations}
    codes = {"heart_rate": ("8867-4", "/min"), "spo2": ("59408-5", "%"), "resp_rate": ("9279-1", "/min")}
    for reading in vitals:
        for metric, (loinc, unit) in codes.items():
            o = by_key[f"{reading['device_id']}-{reading['sequence']}-{metric}"]
            assert o["code"]["coding"][0]["code"] == loinc
            assert o["valueQuantity"]["value"] == reading[metric] and o["valueQuantity"]["unit"] == unit
            assert o["effectiveDateTime"] == reading["timestamp"]
            assert o["subject"]["reference"] == f"Patient/{patient['id']}"
            assert o["device"]["display"] == reading["device_id"]
            assert o["status"] == "final"


def test_monitor_reading_with_missing_value_is_rejected_whole(session, fhir, project, vitals, sources, builtin):
    run(session, fhir, project, sources["sql"], builtin("sql-patient"))
    broken = {k: v for k, v in vitals[1].items() if k != "spo2"}
    result = etl.ingest_vitals(session, fhir, project=project, readings=[vitals[0], broken], actor="admin01")
    assert result.status == "rejected" and result.errors == [{"index": 1, "reasons": ["缺少來源欄位 spo2"]}]
    assert fhir.count(project.id, "Observation") == 0


def test_monitor_reading_for_unknown_patient_writes_nothing(session, fhir, project, vitals):
    result = etl.ingest_vitals(session, fhir, project=project, readings=vitals[:3], actor="admin01")
    assert result.status == "failed" and fhir.count(project.id, "Observation") == 0


def test_build_bundle_keeps_last_of_duplicates():
    from app.fhir.mapping import apply
    rules = BUILTIN["sql-patient"]["mapping"]
    base = {"patient_id": "A", "given_name": "X", "sex": "M", "birth_date": "1990-01-01"}
    mapped = apply(rules, {**base, "family_name": "OLD"}) + apply(rules, {**base, "family_name": "NEW"})
    bundle = etl.build_bundle(mapped)
    assert len(bundle["entry"]) == 1 and bundle["entry"][0]["resource"]["name"][0]["family"] == "NEW"
