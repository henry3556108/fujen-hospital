import json

import pytest
from sqlalchemy import select

from app.fhir.mapping import BUILTIN
from app.models import AuditLog
from app.permissions import Role


@pytest.fixture
def p1(make_project):
    return make_project("P1-lung-ct")


@pytest.fixture
def p2(make_project):
    return make_project("P2-tabular")


@pytest.fixture
def base(p1):
    return f"/api/projects/{p1.id}/fhir"


@pytest.fixture
def load(client, admin, base, clinical, hl7_messages, his_dsn, fhir):
    """建立 4 個來源與內建規則，依序執行；回傳 {kind: run}。"""
    def _load(kinds=("sql", "csv", "json", "hl7v2"), prefix=None):
        prefix = prefix or base
        specs = {
            "sql": ("sql-patient", {"config": {"dsn": his_dsn, "query": "SELECT * FROM patients"}}),
            "csv": ("csv-encounter", {"content": (clinical / "encounters.csv").read_text(encoding="utf-8")}),
            "json": ("json-lab-observation", {"content": (clinical / "labs.json").read_text(encoding="utf-8")}),
            "hl7v2": ("hl7v2-adt", {"content": "\n".join(hl7_messages)}),
        }
        runs = {}
        for kind in kinds:
            builtin, extra = specs[kind]
            source = client.post(f"{prefix}/sources", headers=admin, json={"name": f"src-{kind}", "kind": kind,
                                                                         **extra})
            assert source.status_code == 201, source.text
            mapping = client.post(f"{prefix}/mappings", headers=admin, json={"builtin": builtin})
            assert mapping.status_code == 201, mapping.text
            run = client.post(f"{prefix}/runs", headers=admin,
                              json={"source_id": source.json()["id"], "mapping_id": mapping.json()["id"]})
            assert run.status_code == 201, run.text
            runs[kind] = run.json()
        return runs
    return _load


def test_fhir_not_configured_returns_503(client, admin, base, monkeypatch):
    monkeypatch.delenv("FHIR_URL", raising=False)
    response = client.get(f"{base}/summary", headers=admin)
    assert response.status_code == 503 and "FHIR_URL" in response.json()["detail"]


def test_tc_c03_04_four_sources_through_the_api(client, admin, base, load):
    runs = load()
    assert {k: (r["status"], r["records_read"]) for k, r in runs.items()} == {
        k: ("succeeded", 20) for k in ("sql", "csv", "json", "hl7v2")}
    assert runs["hl7v2"]["resources_written"] == {"Patient": 20, "Encounter": 20}
    summary = client.get(f"{base}/summary", headers=admin).json()
    assert summary["counts"] == {"Patient": 20, "Encounter": 40, "Observation": 20}
    history = client.get(f"{base}/runs", headers=admin).json()
    assert [r["trigger"] for r in history] == ["manual"] * 4
    assert client.get(f"{base}/runs/{history[0]['id']}", headers=admin).json()["id"] == history[0]["id"]


def test_tc_c03_01_validate_endpoint(client, admin, base, load):
    load(("sql",))
    rows = client.get(f"{base}/resources/Patient?count=200", headers=admin).json()
    assert rows["total"] == 20 and len(rows["items"]) == 20
    for resource in rows["items"]:
        body = {k: v for k, v in resource.items() if k not in ("id", "meta")}
        assert client.post(f"{base}/validate", headers=admin, json=body).json() == {"valid": True, "issues": []}
    bad = client.post(f"{base}/validate", headers=admin, json={"resourceType": "Patient", "gender": "Q"}).json()
    assert bad["valid"] is False and any("gender" in i for i in bad["issues"])
    assert client.post(f"{base}/validate", headers=admin, json={"resourceType": "Device"}).status_code == 404


def test_resource_listing_pages_and_filters(client, admin, base, load):
    load(("sql",))
    page = client.get(f"{base}/resources/Patient?count=5&offset=15", headers=admin).json()
    assert page["total"] == 20 and len(page["items"]) == 5
    one = client.get(f"{base}/resources/Patient", headers=admin,
                     params={"identifier": "urn:ai-platform:mrn|SYN-42-0003"}).json()
    assert one["total"] == 1 and one["items"][0]["identifier"][0]["value"] == "SYN-42-0003"
    assert client.get(f"{base}/resources/Medication", headers=admin).status_code == 404


def test_tc_c03_05_three_rule_sets_created_with_the_mapping_tool(client, admin, base, clinical, his_dsn, fhir, p1):
    """自訂 3 組規則（不是內建的）：預覽結果、實際寫入的資源都要與預期逐欄位相同。"""
    rule_sets = [
        ("patient-min", "sql", {"resources": [{"resourceType": "Patient",
                                                "key": {"system": "urn:ai-platform:mrn", "from": "patient_id"},
                                                "fields": [{"path": "name[0].text",
                                                            "template": "{family_name} {given_name}"},
                                                           {"path": "gender", "from": "sex",
                                                            "map": {"M": "male", "F": "female"}}]}]},
         {"patient_id": "SYN-42-0001", "family_name": "TSAI", "given_name": "JACK", "sex": "M"},
         {"resourceType": "Patient", "identifier": [{"system": "urn:ai-platform:mrn", "value": "SYN-42-0001"}],
          "name": [{"text": "TSAI JACK"}], "gender": "male"}),
        ("encounter-amb", "csv", {"resources": [{"resourceType": "Encounter",
                                                  "key": {"system": "urn:ai-platform:encounter",
                                                          "template": "E-{encounter_id}"},
                                                  "fields": [{"path": "status", "const": "finished"},
                                                             {"path": "class.system", "const": "urn:x:class"},
                                                             {"path": "class.code", "from": "class",
                                                              "transform": "lower"},
                                                             {"path": "subject.reference", "template":
                                                              "Patient?identifier=urn:ai-platform:mrn|{patient_id}"},
                                                             {"path": "period.start", "from": "start",
                                                              "transform": "datetime"}]}]},
         {"encounter_id": "ENC0001", "patient_id": "SYN-42-0001", "class": "IMP",
          "start": "2024-09-12T11:08:00+08:00"},
         {"resourceType": "Encounter", "identifier": [{"system": "urn:ai-platform:encounter", "value": "E-ENC0001"}],
          "status": "finished", "class": {"system": "urn:x:class", "code": "imp"},
          "subject": {"reference": "Patient?identifier=urn:ai-platform:mrn|SYN-42-0001"},
          "period": {"start": "2024-09-12T11:08:00+08:00"}}),
        ("lab-flag", "json", {"resources": [{"resourceType": "Observation",
                                              "key": {"system": "urn:ai-platform:lab", "from": "id"},
                                              "fields": [{"path": "status", "const": "final"},
                                                         {"path": "code.coding[0].system",
                                                          "const": "http://loinc.org"},
                                                         {"path": "code.coding[0].code", "from": "loinc"},
                                                         {"path": "subject.reference", "template":
                                                          "Patient?identifier=urn:ai-platform:mrn|{patient_id}"},
                                                         {"path": "effectiveDateTime", "from": "effective",
                                                          "transform": "datetime"},
                                                         {"path": "valueString", "template": "{value} {unit}"}]}]},
         {"id": "LAB0001", "patient_id": "SYN-42-0001", "loinc": "2345-7", "value": 101.8, "unit": "mg/dL",
          "effective": "2024-09-12T13:08:00+08:00"},
         {"resourceType": "Observation", "identifier": [{"system": "urn:ai-platform:lab", "value": "LAB0001"}],
          "status": "final", "code": {"coding": [{"system": "http://loinc.org", "code": "2345-7"}]},
          "subject": {"reference": "Patient?identifier=urn:ai-platform:mrn|SYN-42-0001"},
          "effectiveDateTime": "2024-09-12T13:08:00+08:00", "valueString": "101.8 mg/dL"}),
    ]
    created = []
    for name, kind, rules, sample, expected in rule_sets:
        result = client.post(f"{base}/mappings/preview", headers=admin, json={"rules": rules, "records": [sample]})
        assert result.status_code == 200, result.text
        assert result.json()["results"] == [{"index": 0, "ok": True, "reasons": [], "resources": [expected]}]
        made = client.post(f"{base}/mappings", headers=admin, json={"name": name, "source_kind": kind,
                                                                   "rules": rules})
        assert made.status_code == 201, made.text
        created.append((made.json(), kind, sample, expected))
    listed = client.get(f"{base}/mappings", headers=admin).json()
    assert [m["name"] for m in listed] == ["patient-min", "encounter-amb", "lab-flag"]
    assert [m["rules"] for m in listed] == [r[2] for r in rule_sets]

    # 實際寫入：來源各放一筆樣本，轉出後存進 FHIR 的資源與預期相同（參照改成實際的資源編號）
    contents = {"csv": "encounter_id,patient_id,class,start\nENC0001,SYN-42-0001,IMP,2024-09-12T11:08:00+08:00\n",
                "json": json.dumps([rule_sets[2][3]])}
    for mapping, kind, sample, expected in created:
        body = {"name": f"one-{kind}", "kind": kind}
        body.update({"config": {"dsn": his_dsn, "query": "SELECT * FROM patients WHERE patient_id='SYN-42-0001'"}}
                    if kind == "sql" else {"content": contents[kind]})
        source = client.post(f"{base}/sources", headers=admin, json=body).json()
        run = client.post(f"{base}/runs", headers=admin, json={"source_id": source["id"],
                                                                "mapping_id": mapping["id"]})
        assert run.status_code == 201, run.text
        [stored] = fhir.all(p1.id, expected["resourceType"])
        patient_id = fhir.all(p1.id, "Patient")[0]["id"]
        want = json.loads(json.dumps(expected).replace(
            "Patient?identifier=urn:ai-platform:mrn|SYN-42-0001", f"Patient/{patient_id}"))
        assert {k: v for k, v in stored.items() if k not in ("id", "meta")} == want


def test_mapping_update_and_delete(client, admin, base):
    made = client.post(f"{base}/mappings", headers=admin, json={"builtin": "sql-patient"}).json()
    rules = BUILTIN["sql-patient"]["mapping"]
    changed = {"resources": [{**rules["resources"][0], "fields": rules["resources"][0]["fields"][:2]}]}
    updated = client.put(f"{base}/mappings/{made['id']}", headers=admin, json={"name": "patients", "rules": changed})
    assert updated.status_code == 200 and updated.json()["name"] == "patients"
    assert client.get(f"{base}/mappings/{made['id']}", headers=admin).json()["rules"] == changed
    assert client.delete(f"{base}/mappings/{made['id']}", headers=admin).status_code == 204
    assert client.get(f"{base}/mappings/{made['id']}", headers=admin).status_code == 404


@pytest.mark.parametrize("body, status", [
    ({"name": "x", "source_kind": "csv", "rules": {"resources": []}}, 422),
    ({"name": "x", "source_kind": "xml", "rules": BUILTIN["sql-patient"]["mapping"]}, 422),
    ({"name": "x"}, 422),
    ({"builtin": "nope"}, 422),
    ({"builtin": "sql-patient", "rules": BUILTIN["sql-patient"]["mapping"]}, 422),
])
def test_invalid_mappings_are_rejected(client, admin, base, body, status):
    assert client.post(f"{base}/mappings", headers=admin, json=body).status_code == status


def test_duplicate_names_conflict(client, admin, base):
    body = {"name": "enc", "kind": "csv", "content": "a\n1\n"}
    assert client.post(f"{base}/sources", headers=admin, json=body).status_code == 201
    assert client.post(f"{base}/sources", headers=admin, json=body).status_code == 409
    assert client.post(f"{base}/mappings", headers=admin, json={"builtin": "sql-patient"}).status_code == 201
    assert client.post(f"{base}/mappings", headers=admin, json={"builtin": "sql-patient"}).status_code == 409


@pytest.mark.parametrize("body", [
    {"name": "s", "kind": "xml", "content": "x"},
    {"name": "s", "kind": "csv"},
    {"name": "s", "kind": "sql", "config": {"dsn": "sqlite://", "query": "DROP TABLE x"}},
    {"name": "s", "kind": "sql", "config": {"query": "select 1"}},
    {"name": " ", "kind": "csv", "content": "a\n1\n"},
])
def test_invalid_sources_are_rejected(client, admin, base, body):
    assert client.post(f"{base}/sources", headers=admin, json=body).status_code == 422


def test_tc_ss_04_source_password_is_never_returned(client, admin, base):
    dsn = "postgresql+psycopg://his_reader:Sup3r-Secret@his-db:5432/his"
    made = client.post(f"{base}/sources", headers=admin,
                       json={"name": "his", "kind": "sql", "config": {"dsn": dsn, "query": "select 1"}})
    assert made.status_code == 201
    texts = [made.text, client.get(f"{base}/sources", headers=admin).text,
             client.get(f"{base}/sources/{made.json()['id']}", headers=admin).text]
    assert all("Sup3r-Secret" not in t for t in texts)
    assert "his_reader:***@his-db" in made.json()["config"]["dsn"]


def test_source_in_use_by_run_can_be_deleted_and_history_remains(client, admin, base, load):
    runs = load(("sql",))
    source_id = runs["sql"]["source_id"]
    assert client.delete(f"{base}/sources/{source_id}", headers=admin).status_code == 204
    kept = client.get(f"{base}/runs/{runs['sql']['id']}", headers=admin).json()
    assert kept["status"] == "succeeded" and kept["source_id"] is None


def test_tc_c03_13_invalid_hl7_via_api(client, admin, base, invalid_hl7, hl7_messages, fhir, p1):
    ok = client.post(f"{base}/hl7v2", headers={**admin, "Content-Type": "text/plain"}, content=hl7_messages[0])
    assert ok.status_code == 201 and ok.json()["resources_written"] == {"Patient": 1, "Encounter": 1}
    before = {k: fhir.count(p1.id, k) for k in ("Patient", "Encounter")}
    for name, expected in [("adt_a01_missing_pid3.hl7", "PID-3"), ("adt_a01_bad_sex_code.hl7", "PID-8")]:
        response = client.post(f"{base}/hl7v2", headers={**admin, "Content-Type": "text/plain"},
                               content=invalid_hl7[name])
        assert response.status_code == 422
        detail = response.json()["detail"]
        assert detail["run"]["status"] == "rejected" and expected in detail["run"]["errors"][0]["reasons"][0]
        stored = client.get(f"{base}/runs/{detail['run']['id']}", headers=admin).json()
        assert stored["errors"] == detail["run"]["errors"]      # 原因有留下紀錄
    assert {k: fhir.count(p1.id, k) for k in ("Patient", "Encounter")} == before


def test_hl7_as_json_body(client, admin, base, hl7_messages, fhir):
    response = client.post(f"{base}/hl7v2", headers=admin, json={"message": hl7_messages[1]})
    assert response.status_code == 201
    assert client.post(f"{base}/hl7v2", headers=admin, json={"text": "x"}).status_code == 422


def test_tc_c03_12_vitals_via_api(client, admin, base, load, vitals, fhir, p1):
    load(("sql",))
    for reading in vitals[:50]:
        assert client.post(f"{base}/vitals", headers=admin, json=reading).status_code == 201
    batch = client.post(f"{base}/vitals", headers=admin, json={"readings": vitals[50:]})
    assert batch.status_code == 201 and batch.json()["resources_written"] == {"Observation": 150}
    assert fhir.count(p1.id, "Observation") == 300
    assert client.post(f"{base}/vitals", headers=admin, json=[]).status_code == 422
    assert client.post(f"{base}/vitals", headers=admin, json={"readings": [1]}).status_code == 422


def test_fhir_server_down_returns_503_and_records_the_failure(client, admin, base, load, fhir, vitals):
    load(("sql",))
    fhir.offline = True
    response = client.post(f"{base}/vitals", headers=admin, json=vitals[0])
    assert response.status_code == 503 and response.json()["detail"]["run"]["status"] == "failed"
    assert client.get(f"{base}/summary", headers=admin).status_code == 503


def test_tc_c03_10_graph_matches_the_stored_resources(client, admin, base, load, fhir, p1):
    load()
    graph = client.get(f"{base}/graph", headers=admin, params={"patient": "SYN-42-0001"}).json()
    [patient] = [p for p in fhir.all(p1.id, "Patient") if p["identifier"][0]["value"] == "SYN-42-0001"]
    ref = f"Patient/{patient['id']}"
    related = [r for kind in ("Encounter", "Observation") for r in fhir.all(p1.id, kind)
               if r["subject"]["reference"] == ref]
    assert len(related) == 3      # CSV 的就診、HL7 的就診、一筆檢驗
    assert {n["id"] for n in graph["nodes"]} == {ref} | {f"{r['resourceType']}/{r['id']}" for r in related}
    assert sorted((e["from"], e["to"], e["relation"]) for e in graph["edges"]) == sorted(
        (f"{r['resourceType']}/{r['id']}", ref, "subject") for r in related)
    assert graph["nodes"][0] == {"id": ref, "type": "Patient", "label": "TSAI JACK（SYN-42-0001）",
                                 "identifier": "SYN-42-0001"}
    assert client.get(f"{base}/graph", headers=admin, params={"patient": "NOPE"}).status_code == 404


def test_tc_c03_08_other_tenants_cannot_read_or_write(client, admin, base, load, p1, p2, member, add_user):
    load(("sql",))
    insider = member(p1, "pi01", Role.PRINCIPAL_INVESTIGATOR)
    other_tenant = member(p2, "pi02", Role.PRINCIPAL_INVESTIGATOR)
    outsider = add_user("user01")[1]
    assert client.get(f"{base}/summary", headers=insider).json()["counts"]["Patient"] == 20
    paths = ["/summary", "/resources/Patient", "/sources", "/mappings", "/runs",
             "/graph?patient=SYN-42-0001", "/resources/Observation", "/mappings/builtin", "/sources/1", "/runs/1"]
    for headers in (other_tenant, outsider):
        assert [client.get(f"{base}{p}", headers=headers).status_code for p in paths] == [403] * 10
    # 同一位使用者在自己的租戶看不到別的租戶的資料
    own = client.get(f"/api/projects/{p2.id}/fhir/summary", headers=other_tenant).json()
    assert own["counts"] == {"Patient": 0, "Encounter": 0, "Observation": 0}
    assert client.get(f"/api/projects/{p2.id}/fhir/sources", headers=other_tenant).json() == []
    assert client.get(f"/api/projects/{p2.id}/fhir/runs/1", headers=admin).status_code == 404


def test_only_admin_can_manage_and_write(client, base, p1, member, hl7_messages, vitals):
    pi = member(p1, "pi01", Role.PRINCIPAL_INVESTIGATOR)
    attempts = [
        client.post(f"{base}/sources", headers=pi, json={"name": "s", "kind": "csv", "content": "a\n1\n"}),
        client.post(f"{base}/mappings", headers=pi, json={"builtin": "sql-patient"}),
        client.post(f"{base}/mappings/preview", headers=pi, json={"rules": {}, "records": []}),
        client.post(f"{base}/runs", headers=pi, json={"source_id": 1, "mapping_id": 1}),
        client.post(f"{base}/hl7v2", headers=pi, content=hl7_messages[0]),
        client.post(f"{base}/vitals", headers=pi, json=vitals[0]),
        client.delete(f"{base}/sources/1", headers=pi),
        client.delete(f"{base}/mappings/1", headers=pi),
    ]
    assert [r.status_code for r in attempts] == [403] * 8
    assert client.get(f"{base}/sources").status_code == 401


def test_tc_c03_09_twenty_audit_rows_have_every_field(client, admin, base, load, session, vitals, invalid_hl7):
    load()
    for reading in vitals[:8]:
        client.post(f"{base}/vitals", headers=admin, json=reading)
    client.post(f"{base}/hl7v2", headers=admin, content=invalid_hl7["adt_a01_missing_pid3.hl7"])
    client.get(f"{base}/resources/Patient", headers=admin)
    client.get(f"{base}/graph", headers=admin, params={"patient": "SYN-42-0001"})
    rows = list(session.scalars(select(AuditLog).where(AuditLog.category == "data_exchange")
                                .order_by(AuditLog.id)))
    assert len(rows) >= 20
    for row in rows[:20]:
        assert row.actor == "admin01" and row.at is not None and row.action.startswith("fhir.")
        assert row.target.startswith("project:") and row.result in ("success", "rejected", "failed")
        assert row.source_ip
    actions = {r.action for r in rows}
    assert {"fhir.source.create", "fhir.mapping.create", "fhir.etl.run", "fhir.vitals.receive",
            "fhir.hl7v2.receive", "fhir.resource.list", "fhir.graph.read"} <= actions
    assert ("fhir.hl7v2.receive", "rejected") in {(r.action, r.result) for r in rows}
