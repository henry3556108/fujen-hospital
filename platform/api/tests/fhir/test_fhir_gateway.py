from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from app.fhir import gateway, traffic
from app.fhir.gateway import FhirTarget, match_fhir
from app.fhir.models import FhirTrafficAlert
from app.models import AuditLog
from app.permissions import Role


@pytest.mark.parametrize("method, uri, expected", [
    ("GET", "/fhir/projects/1/metadata", (1, "metadata", "read")),
    ("GET", "/fhir/projects/1/Patient", (1, "Patient", "read")),
    ("GET", "/fhir/projects/1/Patient?identifier=urn:ai-platform:mrn|SYN-42-0001&_count=5", (1, "Patient", "read")),
    ("GET", "/fhir/projects/12/Observation/1003", (12, "Observation/1003", "read")),
    ("HEAD", "/fhir/projects/1/Encounter/1002", (1, "Encounter/1002", "read")),
    ("GET", "/fhir/projects/1/Patient/1001/_history", (1, "Patient/1001/_history", "read")),
    ("GET", "/fhir/projects/1/Patient/1001/_history/2", (1, "Patient/1001/_history/2", "read")),
    ("GET", "/fhir/projects/1/Patient/1001/$everything", (1, "Patient/1001/$everything", "read")),
    ("POST", "/fhir/projects/1/Patient/_search", (1, "Patient/_search", "read")),
    ("POST", "/fhir/projects/1/Patient/$validate", (1, "Patient/$validate", "read")),
    ("POST", "/fhir/projects/1", (1, "", "write")),
    ("POST", "/fhir/projects/1/Patient", (1, "Patient", "write")),
    ("PUT", "/fhir/projects/1/Patient/1001", (1, "Patient/1001", "write")),
    ("PUT", "/fhir/projects/1/Patient?identifier=urn:x|1", None),
    ("DELETE", "/fhir/projects/1/Observation/1003", (1, "Observation/1003", "write")),
    ("PATCH", "/fhir/projects/1/Patient/1001", (1, "Patient/1001", "write")),
    # 系統層級操作、其他分割區、未支援的型別與方法
    ("POST", "/fhir/projects/1/$partition-management-create-partition", None),
    ("POST", "/fhir/projects/1/$expunge", None),
    ("POST", "/fhir/projects/1/Patient/1001/$expunge", None),
    ("GET", "/fhir/projects/1/Encounter/1002/$everything", None),
    ("GET", "/fhir/projects/DEFAULT/Patient", None),
    ("GET", "/fhir/DEFAULT/Patient", None),
    ("GET", "/fhir/1/Patient", None),
    ("GET", "/fhir/projects/1/Medication", None),
    ("GET", "/fhir/projects/1", None),
    ("DELETE", "/fhir/projects/1/Patient", None),
    ("POST", "/fhir/projects/1/Patient/1001", None),
    ("TRACE", "/fhir/projects/1/Patient", None),
    ("DELETE", "/fhir/projects/1/Patient/1001/_history/1", None),
    # 非正規路徑一律拒絕
    ("GET", "/fhir/projects/1/../2/Patient", None),
    ("GET", "/fhir/projects/1/%2e%2e/2/Patient", None),
    ("GET", "/fhir/projects/1//Patient", None),
    ("GET", "/fhir/projects/1/Patient;x=1", None),
    ("GET", "/fhir/projects/1/Patient/a%2Fb", None),
    ("GET", "/fhir/projects/1/Patient?x=1#frag", None),
    ("GET", "/fhir/projects/1/Patient/", None),
])
def test_match_fhir(method, uri, expected):
    assert match_fhir(uri, method) == (FhirTarget(*expected) if expected else None)


@pytest.fixture
def p1(make_project):
    return make_project("P1-lung-ct")


@pytest.fixture
def p2(make_project):
    return make_project("P2-tabular")


@pytest.fixture
def mailer(app):
    app.state.mailer = traffic.InMemoryMailer()
    return app.state.mailer


def check(client, headers, uri, method="GET"):
    return client.get("/authz/check", headers={**headers, "X-Forwarded-Uri": uri, "X-Forwarded-Method": method,
                                               "X-Forwarded-For": "203.0.113.7"})


def accesses(session):
    return list(session.scalars(select(AuditLog).where(AuditLog.action == "fhir.gateway.access")
                                .order_by(AuditLog.id)))


def test_tc_c03_02_twenty_requests_through_the_gateway_are_allowed(client, session, p1, member, mailer):
    pi = member(p1, "pi01", Role.PRINCIPAL_INVESTIGATOR)
    uris = [f"/fhir/projects/{p1.id}/Patient", f"/fhir/projects/{p1.id}/Encounter?_count=5",
            f"/fhir/projects/{p1.id}/Observation/1003", f"/fhir/projects/{p1.id}/metadata"] * 5
    responses = [check(client, pi, uri) for uri in uris]
    assert [r.status_code for r in responses] == [200] * 20
    assert responses[0].headers["x-user"] == "pi01" and responses[0].headers["x-fhir-tenant"] == str(p1.id)
    rows = accesses(session)
    assert len(rows) == 20 and {r.result for r in rows} == {"success"}
    assert rows[2].target == f"project:{p1.id}/Observation/1003" and rows[2].detail["method"] == "GET"
    assert rows[0].source_ip == "203.0.113.7" and rows[0].actor == "pi01"


def test_tc_c03_08_other_tenant_is_denied_ten_times(client, session, p1, p2, member, add_user, mailer):
    other = member(p2, "pi02", Role.PRINCIPAL_INVESTIGATOR)
    outsider = add_user("user01")[1]
    attempts = [(other, "GET", "Patient"), (other, "GET", "Observation/1003"), (other, "POST", "Patient/_search"),
                (other, "GET", "Patient/1001/$everything"), (other, "POST", ""), (outsider, "GET", "Patient"),
                (outsider, "GET", "Encounter"), (outsider, "PUT", "Patient/1001"), (outsider, "GET", "metadata"),
                (outsider, "DELETE", "Patient/1001")]
    responses = [check(client, headers, f"/fhir/projects/{p1.id}/{path}".rstrip("/"), method)
                 for headers, method, path in attempts]
    assert [r.status_code for r in responses] == [403] * 10
    assert check(client, other, f"/fhir/projects/{p2.id}/Patient").status_code == 200     # 自己的租戶可以
    assert check(client, other, "/fhir/projects/999/Patient").status_code == 403           # 不存在的專案
    denied = [r for r in accesses(session) if r.result == "denied"]
    assert len(denied) == 10 and {r.actor for r in denied} == {"pi02", "user01"}


def test_unauthenticated_and_malformed_requests(client, p1, member, session):
    assert client.get("/authz/check", headers={"X-Forwarded-Uri": f"/fhir/projects/{p1.id}/Patient"}
                      ).status_code == 401
    pi = member(p1, "pi01", Role.PRINCIPAL_INVESTIGATOR)
    assert check(client, pi, f"/fhir/projects/{p1.id}/$expunge", "POST").status_code == 403
    assert check(client, pi, "/fhir/DEFAULT/Patient").status_code == 403
    assert accesses(session) == []


def test_writes_require_admin(client, admin, p1, member, mailer):
    pi = member(p1, "pi01", Role.PRINCIPAL_INVESTIGATOR)
    for method, path in [("POST", ""), ("POST", "/Patient"), ("PUT", "/Patient/1"), ("DELETE", "/Patient/1")]:
        assert check(client, pi, f"/fhir/projects/{p1.id}{path}", method).status_code == 403
        assert check(client, admin, f"/fhir/projects/{p1.id}{path}", method).status_code == 200
    assert check(client, pi, f"/fhir/projects/{p1.id}/Patient/_search", "POST").status_code == 200


def test_tc_c03_03_route_can_be_viewed_and_changed_and_takes_effect(client, admin, p1, session, mailer):
    routes = client.get("/api/admin/gateway/routes", headers=admin).json()
    [fhir_route] = [r for r in routes if r["id"] == "fhir-rest"]
    assert fhir_route["managed"] and fhir_route["enabled"] and fhir_route["uri"] == "/fhir/projects/*"
    uri = f"/fhir/projects/{p1.id}/Patient"
    assert check(client, admin, uri).status_code == 200

    off = client.patch("/api/admin/gateway/routes/fhir-rest", headers=admin, json={"enabled": False})
    assert off.status_code == 200 and off.json()["enabled"] is False and off.json()["updated_by"] == "admin01"
    denied = check(client, admin, uri)
    assert denied.status_code == 403 and "停用" in denied.json()["detail"]
    assert client.get("/api/admin/gateway/routes", headers=admin).json()[0]["enabled"] is False   # 重新載入一致

    client.patch("/api/admin/gateway/routes/fhir-rest", headers=admin,
                 json={"enabled": True, "methods": ["GET", "HEAD"], "alert_threshold_per_minute": 30})
    assert check(client, admin, uri).status_code == 200
    blocked = check(client, admin, uri, "POST")
    assert blocked.status_code == 403 and "POST" in blocked.json()["detail"]
    reloaded = client.get("/api/admin/gateway/routes", headers=admin).json()[0]
    assert (reloaded["methods"], reloaded["alert_threshold_per_minute"]) == (["GET", "HEAD"], 30)
    changes = [a.detail for a in session.scalars(select(AuditLog).where(
        AuditLog.action == "fhir.gateway.route.update").order_by(AuditLog.id))]
    assert changes == [{"enabled": False},
                       {"enabled": True, "methods": ["GET", "HEAD"], "alert_threshold_per_minute": 30}]


def test_route_management_is_admin_only_and_validated(client, admin, p1, member):
    pi = member(p1, "pi01", Role.PRINCIPAL_INVESTIGATOR)
    assert client.get("/api/admin/gateway/routes", headers=pi).status_code == 403
    assert client.patch("/api/admin/gateway/routes/fhir-rest", headers=pi, json={"enabled": False}
                        ).status_code == 403
    assert client.get("/api/admin/gateway/routes").status_code == 401
    for body in ({"methods": []}, {"methods": ["TRACE"]}, {"alert_threshold_per_minute": 0}):
        assert client.patch("/api/admin/gateway/routes/fhir-rest", headers=admin, json=body).status_code == 422
    assert client.patch("/api/admin/gateway/routes/nope", headers=admin, json={"enabled": False}
                        ).status_code == 404


def test_static_routes_are_listed_read_only_without_secrets(client, admin, tmp_path, monkeypatch):
    config = tmp_path / "apisix.yaml"
    config.write_text("""routes:
  - id: platform-api
    uri: /api/*
    plugins:
      cors: {allow_origins: "http://localhost:5173"}
    upstream: {type: roundrobin, nodes: {"api:8000": 1}}
  - id: dicomweb
    uri: /dicomweb/projects/*
    methods: ["GET", "HEAD"]
    plugins:
      serverless-post-function:
        functions: ["return function() ngx.req.set_header('Authorization', 'Basic c2VjcmV0') end"]
    upstream: {type: roundrobin, nodes: {"orthanc:8042": 1}}
#END
""", encoding="utf-8")
    monkeypatch.setenv("GATEWAY_ROUTES_FILE", str(config))
    response = client.get("/api/admin/gateway/routes", headers=admin)
    routes = response.json()
    assert [r["id"] for r in routes] == ["fhir-rest", "/api/*", "/dicomweb/projects/*"]
    assert "platform-api" not in response.text          # 設定檔裡的路由名稱不回傳（可能與帳號同名）
    assert routes[2] == {"id": "/dicomweb/projects/*", "managed": False, "description": "", "uri": "/dicomweb/projects/*",
                         "upstream": ["orthanc:8042"], "enabled": True, "methods": ["GET", "HEAD"],
                         "alert_threshold_per_minute": None, "plugins": ["serverless-post-function"],
                         "updated_by": None, "updated_at": None}
    assert "c2VjcmV0" not in response.text
    assert client.patch("/api/admin/gateway/routes/dicomweb", headers=admin, json={"enabled": False}
                        ).status_code == 409


def test_tc_c03_10_abnormal_traffic_raises_one_alert_and_sends_mail(client, admin, p1, session, mailer, member):
    client.patch("/api/admin/gateway/routes/fhir-rest", headers=admin, json={"alert_threshold_per_minute": 30})
    pi = member(p1, "pi01", Role.PRINCIPAL_INVESTIGATOR)
    uri = f"/fhir/projects/{p1.id}/Patient"
    for _ in range(30):
        assert check(client, pi, uri).status_code == 200
    assert mailer.sent == [] and session.scalars(select(FhirTrafficAlert)).all() == []
    for _ in range(40):                                  # 異常流量：超過門檻後繼續打
        assert check(client, pi, uri).status_code == 200   # 告警不阻擋存取
    alerts = session.scalars(select(FhirTrafficAlert)).all()
    assert 1 <= len(alerts) <= 2                         # 跨分鐘邊界時最多兩筆，同一分鐘只有一筆
    assert len(mailer.sent) == len(alerts) and alerts[0].notified
    assert (alerts[0].actor, alerts[0].project_id, alerts[0].threshold) == ("pi01", p1.id, 30)
    subject, body = mailer.sent[0]
    assert "流量異常" in subject and "pi01" in body and "每分鐘 30 次" in body
    listed = client.get(f"/api/projects/{p1.id}/fhir/alerts", headers=admin).json()
    assert len(listed) == len(alerts) and listed[0]["actor"] == "pi01" and listed[0]["notified"] is True
    assert client.get(f"/api/projects/{p1.id}/fhir/alerts", headers=pi).status_code == 403


def test_alert_window_and_suppression_with_a_clock(session, p1):
    box = traffic.InMemoryMailer()
    t0 = datetime(2026, 10, 1, 8, 0, 5, tzinfo=timezone.utc)

    def hit(at, actor="pi01"):
        alert = traffic.record_access(session, actor=actor, project_id=p1.id, method="GET", path="Patient",
                                      allowed=True, reason=None, source_ip=None, threshold=5, mailer=box,
                                      now=lambda: at)
        session.commit()
        return alert

    assert [hit(t0 + timedelta(seconds=i)) for i in range(5)] == [None] * 5
    first = hit(t0 + timedelta(seconds=6))
    assert first is not None and first.request_count == 6 and len(box.sent) == 1
    assert [hit(t0 + timedelta(seconds=10 + i)) for i in range(5)] == [None] * 5     # 同一分鐘：抑制
    assert hit(t0 + timedelta(seconds=7), actor="md01") is None                       # 別人的流量分開計
    assert hit(t0 + timedelta(minutes=5)) is None                                     # 流量回到正常
    assert len(box.sent) == 1


def test_mail_failure_does_not_block_access(client, admin, p1, session, mailer):
    client.patch("/api/admin/gateway/routes/fhir-rest", headers=admin, json={"alert_threshold_per_minute": 3})
    mailer.fail = True
    for _ in range(6):
        assert check(client, admin, f"/fhir/projects/{p1.id}/Patient").status_code == 200
    [alert] = session.scalars(select(FhirTrafficAlert)).all()
    assert alert.notified is False


def test_mailer_from_env():
    assert traffic.mailer_from_env({}) is None
    assert traffic.mailer_from_env({"ALERT_SMTP_HOST": "mailpit"}) is None
    m = traffic.mailer_from_env({"ALERT_SMTP_HOST": "mailpit", "ALERT_SMTP_PORT": "1025",
                                 "ALERT_EMAIL_TO": "ops@example.test, it@example.test"})
    assert (m.host, m.port, m.recipients) == ("mailpit", 1025, ["ops@example.test", "it@example.test"])
