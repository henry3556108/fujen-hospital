from sqlalchemy import select

from app.models import AuditLog, Project
from app.permissions import AccountType


def _setup(client, add_user, session):
    _, admin = add_user("admin01", AccountType.ADMIN)
    project = Project(name="P1-lung-ct")
    session.add(project)
    session.commit()
    return admin, project


def test_member_gets_role_defaults(client, add_user, session):
    admin, project = _setup(client, add_user, session)
    md, md_headers = add_user("md01")
    response = client.put(f"/api/admin/projects/{project.id}/members/{md.id}", headers=admin, json={"role": "medical_doctor"})
    assert response.status_code == 200
    me = client.get("/api/me", headers=md_headers).json()
    assert me["projects"] == [{"id": project.id, "name": "P1-lung-ct", "role": "medical_doctor",
                               "permissions": ["labeling", "prediction", "project"]}]


def test_tc_a03_06_permission_takes_effect_immediately(client, add_user, session):
    admin, project = _setup(client, add_user, session)
    ra, ra_headers = add_user("ra01")
    client.put(f"/api/admin/projects/{project.id}/members/{ra.id}", headers=admin, json={"role": "research_assistant"})
    client.put(f"/api/admin/projects/{project.id}/members/{ra.id}", headers=admin,
               json={"role": "research_assistant", "permissions": ["project", "labeling", "prediction"]})
    perms = client.get("/api/me", headers=ra_headers).json()["projects"][0]["permissions"]
    assert "training" not in perms  # 同一個 token、下一個請求就看到變更


def test_tc_a03_07_removed_member_loses_access_immediately(client, add_user, session):
    admin, project = _setup(client, add_user, session)
    md, md_headers = add_user("md01")
    client.put(f"/api/admin/projects/{project.id}/members/{md.id}", headers=admin, json={"role": "medical_doctor"})
    assert client.delete(f"/api/admin/projects/{project.id}/members/{md.id}", headers=admin).status_code == 204
    assert client.get("/api/me", headers=md_headers).json()["projects"] == []


def test_role_and_permission_changes_are_audited_separately(client, add_user, session):
    admin, project = _setup(client, add_user, session)
    ca, _ = add_user("ca01")
    client.put(f"/api/admin/projects/{project.id}/members/{ca.id}", headers=admin, json={"role": "coder_assistant"})
    client.put(f"/api/admin/projects/{project.id}/members/{ca.id}", headers=admin, json={"role": "viewer"})
    categories = [e.category for e in session.scalars(select(AuditLog))]
    assert categories.count("role") == 2        # assign + change
    assert categories.count("permission") == 2  # grant + change


def test_unknown_permission_is_422(client, add_user, session):
    admin, project = _setup(client, add_user, session)
    vw, _ = add_user("vw01")
    response = client.put(f"/api/admin/projects/{project.id}/members/{vw.id}", headers=admin,
                          json={"role": "viewer", "permissions": ["project", "superuser"]})
    assert response.status_code == 422


def test_admin_me_lists_all_projects_with_all_permissions(client, add_user, session):
    admin, project = _setup(client, add_user, session)
    me = client.get("/api/me", headers=admin).json()
    assert me["projects"][0]["role"] is None
    assert me["projects"][0]["permissions"] == ["coding", "labeling", "prediction", "project", "training"]


def test_list_project_members(client, add_user, session):
    admin, project = _setup(client, add_user, session)
    md, _ = add_user("md01")
    vw, _ = add_user("vw01")
    client.put(f"/api/admin/projects/{project.id}/members/{md.id}", headers=admin, json={"role": "medical_doctor"})
    client.put(f"/api/admin/projects/{project.id}/members/{vw.id}", headers=admin, json={"role": "viewer"})
    response = client.get(f"/api/admin/projects/{project.id}/members", headers=admin)
    assert response.status_code == 200
    assert response.json() == [
        {"user_id": md.id, "username": "md01", "role": "medical_doctor", "permissions": ["labeling", "prediction", "project"]},
        {"user_id": vw.id, "username": "vw01", "role": "viewer", "permissions": ["prediction", "project"]},
    ]


def test_list_members_requires_admin_and_existing_project(client, add_user, session):
    admin, project = _setup(client, add_user, session)
    _, pi = add_user("pi01")
    assert client.get(f"/api/admin/projects/{project.id}/members", headers=pi).status_code == 403
    missing = client.get("/api/admin/projects/999/members", headers=admin)
    assert missing.status_code == 404 and "找不到" in missing.json()["detail"]


def _revokes(session):
    rows = session.scalars(select(AuditLog).where(AuditLog.category == "role", AuditLog.action == "revoke")
                           .order_by(AuditLog.id)).all()
    return [(e.actor, e.target, e.detail) for e in rows]


def test_delete_project_audits_each_membership(client, add_user, session):
    admin, project = _setup(client, add_user, session)
    other = Project(name="P2-tabular")
    session.add(other)
    session.commit()
    md, _ = add_user("md01")
    ra, _ = add_user("ra01")
    client.put(f"/api/admin/projects/{project.id}/members/{md.id}", headers=admin, json={"role": "medical_doctor"})
    client.put(f"/api/admin/projects/{project.id}/members/{ra.id}", headers=admin, json={"role": "research_assistant"})
    client.put(f"/api/admin/projects/{other.id}/members/{ra.id}", headers=admin, json={"role": "viewer"})

    assert client.delete(f"/api/admin/projects/{project.id}", headers=admin).status_code == 204

    assert _revokes(session) == [
        ("admin01", f"project:{project.id}/user:{md.id}", {"role": "medical_doctor", "reason": "project_deleted"}),
        ("admin01", f"project:{project.id}/user:{ra.id}", {"role": "research_assistant", "reason": "project_deleted"}),
    ]   # 另一個專案的成員資格不受影響，也不寫稽核
    members = client.get(f"/api/admin/projects/{other.id}/members", headers=admin).json()
    assert [m["username"] for m in members] == ["ra01"]


def test_delete_user_audits_each_membership(client, add_user, session):
    admin, project = _setup(client, add_user, session)
    other = Project(name="P2-tabular")
    session.add(other)
    session.commit()
    ra, _ = add_user("ra01")
    md, _ = add_user("md01")
    client.put(f"/api/admin/projects/{project.id}/members/{ra.id}", headers=admin, json={"role": "research_assistant"})
    client.put(f"/api/admin/projects/{other.id}/members/{ra.id}", headers=admin, json={"role": "viewer"})
    client.put(f"/api/admin/projects/{project.id}/members/{md.id}", headers=admin, json={"role": "medical_doctor"})

    assert client.delete(f"/api/admin/users/{ra.id}", headers=admin).status_code == 204

    assert _revokes(session) == [
        ("admin01", f"project:{project.id}/user:{ra.id}", {"role": "research_assistant", "reason": "user_deleted"}),
        ("admin01", f"project:{other.id}/user:{ra.id}", {"role": "viewer", "reason": "user_deleted"}),
    ]


def test_delete_user_membership_audit_rolls_back_with_idp_failure(client, add_user, session, idp, monkeypatch):
    """成員資格稽核與刪除同一個交易：身分提供者失敗時一起回復。"""
    admin, project = _setup(client, add_user, session)
    ra, _ = add_user("ra01")
    client.put(f"/api/admin/projects/{project.id}/members/{ra.id}", headers=admin, json={"role": "research_assistant"})

    def boom(subject):
        raise RuntimeError("idp down")
    monkeypatch.setattr(idp, "delete_user", boom)
    import pytest
    with pytest.raises(RuntimeError):
        client.delete(f"/api/admin/users/{ra.id}", headers=admin)

    session.expire_all()
    assert _revokes(session) == []
    assert [m["username"] for m in client.get(f"/api/admin/projects/{project.id}/members", headers=admin).json()] == ["ra01"]


def _corrupt_membership(session, project, user, permissions):
    from app.models import Membership

    session.add(Membership(user_id=user.id, project_id=project.id, role="research_assistant", permissions=permissions))
    session.commit()


def test_unknown_permission_is_ignored_not_500(client, add_user, session, caplog):
    """資料庫存了不認得的權限字串（例如舊版本留下、手動改資料）：視為沒有該權限，不回 500，並留下 warning。"""
    import logging

    admin, project = _setup(client, add_user, session)
    ra, ra_headers = add_user("ra01")
    _corrupt_membership(session, project, ra, ["project", "superuser", "training"])

    from app.scheduling.backend import FakeJobBackend
    client.app.state.job_backend = FakeJobBackend()
    with caplog.at_level(logging.WARNING, logger="app.authz"):
        allowed = client.get(f"/api/projects/{project.id}/jobs", headers=ra_headers)          # 需 training
        denied = client.post(f"/api/projects/{project.id}/imaging/pacs/query", headers=ra_headers, json={})
    assert allowed.status_code == 200
    assert denied.status_code == 403                                                         # labeling 沒有被誤放行
    assert any("superuser" in r.getMessage() and "ra01" in r.getMessage() for r in caplog.records)

    me = client.get("/api/me", headers=ra_headers)
    assert me.status_code == 200
    assert me.json()["projects"][0]["permissions"] == ["project", "training"]

    check = client.get("/authz/check", headers={**ra_headers, "X-Forwarded-Uri": f"/api/projects/{project.id}/training/x",
                                                "X-Forwarded-Method": "GET"})
    assert check.status_code == 200


def test_members_list_reports_unknown_permissions(client, add_user, session):
    admin, project = _setup(client, add_user, session)
    ra, _ = add_user("ra01")
    md, _ = add_user("md01")
    _corrupt_membership(session, project, ra, ["project", "superuser"])
    client.put(f"/api/admin/projects/{project.id}/members/{md.id}", headers=admin, json={"role": "medical_doctor"})

    members = client.get(f"/api/admin/projects/{project.id}/members", headers=admin)
    assert members.status_code == 200
    by_name = {m["username"]: m for m in members.json()}
    assert by_name["ra01"]["permissions"] == ["project"]
    assert by_name["ra01"]["unknown_permissions"] == ["superuser"]
    assert "unknown_permissions" not in by_name["md01"]                                       # 正常資料的回應形狀不變

    # 管理者重新指派後，異常值被覆寫
    fixed = client.put(f"/api/admin/projects/{project.id}/members/{ra.id}", headers=admin,
                       json={"role": "research_assistant"})
    assert fixed.status_code == 200
    again = client.get(f"/api/admin/projects/{project.id}/members", headers=admin).json()
    assert all("unknown_permissions" not in m for m in again)
