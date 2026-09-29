"""FHIR 的來源內容（CSV、HL7 V2、JSON）與 HL7 V2 訊息都要先掃毒（TC-D01-06）：被攔下時不存、不寫 FHIR；掃毒服務中斷時全部拒絕。
生理監視器讀數是數值 API 呼叫、不是檔案，不掃毒。"""
import pytest
from sqlalchemy import select

from app.fhir.models import FhirRun, FhirSource
from app.models import AuditLog
from app.scanning import FakeScanner, eicar


@pytest.fixture
def base(make_project):
    return f"/api/projects/{make_project('P1-lung-ct').id}/fhir"


def blocked_rows(session):
    return list(session.scalars(select(AuditLog).where(AuditLog.action == "malware_blocked")))


def test_tc_d01_06_infected_source_content_is_rejected_and_not_stored(app, client, session, admin, base, fhir):
    app.state.scanner = FakeScanner()
    content = "encounter_id,patient_id\nENC1,SYN-1\n" + eicar().decode("ascii")
    response = client.post(f"{base}/sources", headers=admin, json={"name": "enc", "kind": "csv", "content": content})
    assert response.status_code == 422 and response.json()["detail"]["code"] == "malware_detected"
    assert session.scalars(select(FhirSource)).all() == []
    [row] = blocked_rows(session)
    assert row.actor == "admin01" and row.target == "fhir-source:enc" and row.result == "rejected"
    clean = client.post(f"{base}/sources", headers=admin,
                        json={"name": "enc", "kind": "csv", "content": "encounter_id,patient_id\nENC1,SYN-1\n"})
    assert clean.status_code == 201
    assert app.state.scanner.scanned == ["fhir-source:enc", "fhir-source:enc"]


def test_sql_source_has_no_uploaded_content_to_scan(app, client, admin, base, his_dsn):
    app.state.scanner = FakeScanner(offline=True)
    response = client.post(f"{base}/sources", headers=admin,
                           json={"name": "his", "kind": "sql", "config": {"dsn": his_dsn, "query": "SELECT 1"}})
    assert response.status_code == 201


def test_tc_d01_06_infected_hl7_message_writes_nothing(app, client, session, admin, base, fhir, hl7_messages):
    app.state.scanner = FakeScanner()
    infected = hl7_messages[0] + "NTE|1||" + eicar().decode("ascii") + "\r"
    response = client.post(f"{base}/hl7v2", headers={**admin, "Content-Type": "text/plain"}, content=infected)
    assert response.status_code == 422 and response.json()["detail"]["code"] == "malware_detected"
    assert fhir.transactions == 0 and session.scalars(select(FhirRun)).all() == []
    assert [r.target for r in blocked_rows(session)] == ["fhir-hl7v2-message"]
    ok = client.post(f"{base}/hl7v2", headers={**admin, "Content-Type": "text/plain"}, content=hl7_messages[0])
    assert ok.status_code == 201


@pytest.mark.parametrize("path, kwargs", [
    ("/sources", {"json": {"name": "enc", "kind": "csv", "content": "a,b\n1,2\n"}}),
    ("/hl7v2", {"content": b"MSH|^~\\&|X", "headers": {"Content-Type": "text/plain"}}),
])
def test_scanner_offline_rejects_every_upload(app, client, session, admin, base, fhir, path, kwargs):
    app.state.scanner = FakeScanner(offline=True)
    headers = {**admin, **kwargs.pop("headers", {})}
    response = client.post(f"{base}{path}", headers=headers, **kwargs)
    assert response.status_code == 503 and "掃毒服務暫時無法使用" in response.json()["detail"]
    assert session.scalars(select(FhirSource)).all() == [] and session.scalars(select(FhirRun)).all() == []
