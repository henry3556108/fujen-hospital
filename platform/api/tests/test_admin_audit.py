"""唯讀稽核檢視（A-03 第 6 項、D-01「抽查 20 筆」；TC-SS-07 沒有修改或刪除稽核的 API）。"""
from datetime import datetime, timedelta, timezone

from app.audit import AuditCategory, record
from app.main import create_app
from app.models import AuditLog
from app.permissions import AccountType

T0 = datetime(2026, 10, 1, 8, 0, tzinfo=timezone.utc)


def _seed_rows(session):
    rows = [
        ("admin01", AuditCategory.PROJECT, "create", "project:1", "10.0.0.5", 0),
        ("admin01", AuditCategory.ACCOUNT, "create", "user:2", "local:seed", 1),
        ("admin01", AuditCategory.ROLE, "assign", "project:1/user:2", "local:seed", 2),
        ("ra01", AuditCategory.DATASET, "imaging.import_dicom", "project:1", "10.0.0.9", 3),
        ("ra01", AuditCategory.DATASET, "imaging.import_files", "project:1", "10.0.0.9", 4),
        ("fhir-scheduler", AuditCategory.DATA_EXCHANGE, "etl.run", "project:1", None, 5),
    ]
    for actor, category, action, target, ip, hours in rows:
        entry = record(session, actor=actor, category=category, action=action, target=target, source_ip=ip,
                       detail={"n": hours}, result="failed" if hours == 5 else "success")
        entry.at = T0 + timedelta(hours=hours)
    session.commit()


def _get(client, headers, **params):
    response = client.get("/api/admin/audit", headers=headers, params=params)
    assert response.status_code == 200, response.text
    return response.json()


def test_lists_newest_first_with_every_required_field(client, add_user, session):
    _, admin = add_user("admin01", AccountType.ADMIN)
    _seed_rows(session)
    page = _get(client, admin)
    assert page["total"] == 6 and page["page"] == 1 and page["page_size"] == 50
    first = page["items"][0]
    assert set(first) == {"id", "at", "actor", "category", "action", "target", "result", "source_ip", "detail"}
    assert (first["actor"], first["category"], first["action"], first["result"], first["source_ip"]) == (
        "fhir-scheduler", "data_exchange", "etl.run", "failed", None)
    assert [i["detail"]["n"] for i in page["items"]] == [5, 4, 3, 2, 1, 0]
    assert page["items"][-1]["at"].startswith("2026-10-01T08:00:00")


def test_filters_by_category_actor_action_prefix_and_time(client, add_user, session):
    _, admin = add_user("admin01", AccountType.ADMIN)
    _seed_rows(session)
    assert _get(client, admin, category="dataset")["total"] == 2
    assert _get(client, admin, actor="ra01")["total"] == 2
    assert _get(client, admin, action="imaging.")["total"] == 2
    assert _get(client, admin, action="imaging.import_dicom")["total"] == 1
    assert _get(client, admin, action="%")["total"] == 0          # 萬用字元當一般字元
    window = _get(client, admin, since="2026-10-01T09:00:00Z", until="2026-10-01T11:00:00Z")
    assert [i["detail"]["n"] for i in window["items"]] == [2, 1]   # 迄不含
    both = _get(client, admin, category="role", actor="admin01")
    assert [i["action"] for i in both["items"]] == ["assign"]
    assert _get(client, admin, result="failed")["total"] == 1


def test_paginates(client, add_user, session):
    _, admin = add_user("admin01", AccountType.ADMIN)
    for i in range(45):
        record(session, actor="admin01", category=AuditCategory.PROJECT, action="update", target=f"project:{i}")
    session.commit()
    p1 = _get(client, admin, page_size=20)
    p3 = _get(client, admin, page_size=20, page=3)
    assert p1["total"] == 45 and len(p1["items"]) == 20 and len(p3["items"]) == 5
    ids = [i["id"] for i in p1["items"]] + [i["id"] for i in _get(client, admin, page_size=20, page=2)["items"]]
    assert len(set(ids)) == 40
    assert _get(client, admin, page_size=20, page=9)["items"] == []


def test_bad_parameters_are_422(client, add_user):
    _, admin = add_user("admin01", AccountType.ADMIN)
    for params in ({"category": "nope"}, {"page": 0}, {"page_size": 201}, {"since": "yesterday"},
                   {"since": "2026-10-02T00:00:00Z", "until": "2026-10-01T00:00:00Z"}):
        response = client.get("/api/admin/audit", headers=admin, params=params)
        assert response.status_code == 422, params
    assert "早於" in client.get("/api/admin/audit", headers=admin,
                               params={"since": "2026-10-02T00:00:00Z", "until": "2026-10-01T00:00:00Z"}).text


def test_admin_only(client, add_user):
    _, user = add_user("pi01")
    assert client.get("/api/admin/audit", headers=user).status_code == 403
    assert client.get("/api/admin/audit").status_code == 401


def test_tc_ss_07_no_route_writes_audit_records():
    app = create_app()
    for route in app.routes:
        path = getattr(route, "path", "")
        if "audit" in path:
            assert getattr(route, "methods", set()) <= {"GET", "HEAD"}, (path, route.methods)


def test_tc_ss_07_admin_cannot_modify_or_delete_audit(client, add_user, session):
    _, admin = add_user("admin01", AccountType.ADMIN)
    _seed_rows(session)
    audit_id = session.query(AuditLog.id).first()[0]
    for method in ("PUT", "PATCH", "DELETE", "POST"):
        for path in (f"/api/admin/audit/{audit_id}", "/api/admin/audit"):
            assert client.request(method, path, headers=admin, json={}).status_code in (404, 405), (method, path)
    assert session.query(AuditLog).count() == 6
