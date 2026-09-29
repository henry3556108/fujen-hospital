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
