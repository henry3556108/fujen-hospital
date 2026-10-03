"""標註群組（A-03：Admin 可建立標註群組）。群組屬於專案，成員必須是專案成員；稽核歸 project 類。"""
from sqlalchemy import select

from app.models import AuditLog, LabelGroup, LabelGroupMember, Project
from app.permissions import AccountType


def _url(pid, gid=None):
    base = f"/api/admin/projects/{pid}/labeling-groups"
    return base if gid is None else f"{base}/{gid}"


def _setup(client, add_user, session):
    _, admin = add_user("admin01", AccountType.ADMIN)
    project = Project(name="P1-lung-ct")
    session.add(project)
    session.commit()
    members = {}
    for name, role in [("md01", "medical_doctor"), ("ra01", "research_assistant"), ("vw01", "viewer")]:
        user, headers = add_user(name)
        assert client.put(f"/api/admin/projects/{project.id}/members/{user.id}", headers=admin,
                          json={"role": role}).status_code == 200
        members[name] = (user, headers)
    return admin, project, members


def _audit(session, action):
    return session.scalars(select(AuditLog).where(AuditLog.action == action).order_by(AuditLog.id)).all()


def test_admin_creates_lists_updates_and_deletes_a_group(client, add_user, session):
    admin, project, m = _setup(client, add_user, session)
    md, ra = m["md01"][0], m["ra01"][0]
    created = client.post(_url(project.id), headers=admin,
                          json={"name": "肺結節標註組", "description": "第一輪", "member_ids": [md.id, ra.id]})
    assert created.status_code == 201, created.text
    group = created.json()
    assert group["name"] == "肺結節標註組" and group["description"] == "第一輪"
    assert group["project_id"] == project.id and group["created_by"] == "admin01"
    assert [x["username"] for x in group["members"]] == ["md01", "ra01"]

    listed = client.get(_url(project.id), headers=admin).json()
    assert [g["id"] for g in listed] == [group["id"]]

    patched = client.patch(_url(project.id, group["id"]), headers=admin,
                           json={"name": "肺結節第二輪", "member_ids": [ra.id]})
    assert patched.status_code == 200, patched.text
    assert patched.json()["name"] == "肺結節第二輪"
    assert patched.json()["description"] == "第一輪"
    assert [x["username"] for x in patched.json()["members"]] == ["ra01"]

    assert client.delete(_url(project.id, group["id"]), headers=admin).status_code == 204
    assert client.get(_url(project.id), headers=admin).json() == []
    assert session.scalars(select(LabelGroupMember)).all() == []


def test_each_change_writes_one_project_audit_row_with_details(client, add_user, session):
    admin, project, m = _setup(client, add_user, session)
    md, ra = m["md01"][0], m["ra01"][0]
    gid = client.post(_url(project.id), headers=admin, json={"name": "G1", "member_ids": [md.id]}).json()["id"]
    client.patch(_url(project.id, gid), headers=admin, json={"member_ids": [md.id, ra.id]})
    client.delete(_url(project.id, gid), headers=admin)

    target = f"project:{project.id}/labeling_group:{gid}"
    (create,) = _audit(session, "labeling_group.create")
    (update,) = _audit(session, "labeling_group.update")
    (delete,) = _audit(session, "labeling_group.delete")
    for row in (create, update, delete):
        assert row.category == "project" and row.target == target and row.actor == "admin01"
        assert row.result == "success" and row.source_ip
    assert create.detail == {"name": "G1", "description": "", "members": ["md01"]}
    assert update.detail == {"members": {"from": ["md01"], "to": ["md01", "ra01"]}}
    assert delete.detail == {"name": "G1", "members": ["md01", "ra01"]}


def test_members_must_belong_to_the_project(client, add_user, session):
    admin, project, _ = _setup(client, add_user, session)
    outsider, _ = add_user("user01")
    response = client.post(_url(project.id), headers=admin, json={"name": "G", "member_ids": [outsider.id]})
    assert response.status_code == 409
    assert "user01" in response.json()["detail"] and "不是專案" in response.json()["detail"]
    assert session.scalars(select(LabelGroup)).all() == []
    assert _audit(session, "labeling_group.create") == []


def test_unknown_member_id_is_404(client, add_user, session):
    admin, project, _ = _setup(client, add_user, session)
    assert client.post(_url(project.id), headers=admin, json={"name": "G", "member_ids": [9999]}).status_code == 404


def test_duplicate_name_in_same_project_is_409_but_allowed_in_another(client, add_user, session):
    admin, project, _ = _setup(client, add_user, session)
    other = Project(name="P2")
    session.add(other)
    session.commit()
    assert client.post(_url(project.id), headers=admin, json={"name": "G"}).status_code == 201
    dup = client.post(_url(project.id), headers=admin, json={"name": "G"})
    assert dup.status_code == 409 and "已存在" in dup.json()["detail"]
    assert client.post(_url(other.id), headers=admin, json={"name": "G"}).status_code == 201
    gid = client.post(_url(project.id), headers=admin, json={"name": "H"}).json()["id"]
    assert client.patch(_url(project.id, gid), headers=admin, json={"name": "G"}).status_code == 409


def test_validation_and_not_found(client, add_user, session):
    admin, project, _ = _setup(client, add_user, session)
    assert client.post(_url(project.id), headers=admin, json={"name": ""}).status_code == 422
    assert client.post(_url(project.id), headers=admin, json={"name": "   "}).status_code == 422
    assert client.post(_url(9999), headers=admin, json={"name": "G"}).status_code == 404
    assert client.get(_url(9999), headers=admin).status_code == 404
    assert client.patch(_url(project.id, 9999), headers=admin, json={"name": "X"}).status_code == 404
    assert client.delete(_url(project.id, 9999), headers=admin).status_code == 404
    other = Project(name="P2")
    session.add(other)
    session.commit()
    gid = client.post(_url(project.id), headers=admin, json={"name": "G"}).json()["id"]
    assert client.delete(_url(other.id, gid), headers=admin).status_code == 404   # 群組不屬於該專案


def test_non_admin_is_403_and_anonymous_401(client, add_user, session):
    _, project, m = _setup(client, add_user, session)
    pi, pi_headers = add_user("pi01")
    assert client.get(_url(project.id), headers=pi_headers).status_code == 403
    assert client.post(_url(project.id), headers=m["md01"][1], json={"name": "G"}).status_code == 403
    assert client.get(_url(project.id)).status_code == 401


def test_removing_member_from_project_removes_them_from_groups(client, add_user, session):
    admin, project, m = _setup(client, add_user, session)
    md, ra = m["md01"][0], m["ra01"][0]
    gid = client.post(_url(project.id), headers=admin, json={"name": "G", "member_ids": [md.id, ra.id]}).json()["id"]
    assert client.delete(f"/api/admin/projects/{project.id}/members/{md.id}", headers=admin).status_code == 204
    group = client.get(_url(project.id), headers=admin).json()[0]
    assert [x["username"] for x in group["members"]] == ["ra01"]
    (row,) = _audit(session, "labeling_group.member_removed")
    assert row.category == "project" and row.target == f"project:{project.id}/labeling_group:{gid}"
    assert row.detail == {"username": "md01", "reason": "membership_revoked"}


def test_deleting_user_or_project_cleans_up_groups(client, add_user, session):
    admin, project, m = _setup(client, add_user, session)
    md, ra = m["md01"][0], m["ra01"][0]
    gid = client.post(_url(project.id), headers=admin, json={"name": "G", "member_ids": [md.id, ra.id]}).json()["id"]
    assert client.delete(f"/api/admin/users/{md.id}", headers=admin).status_code == 204
    assert [x["username"] for x in client.get(_url(project.id), headers=admin).json()[0]["members"]] == ["ra01"]

    assert client.delete(f"/api/admin/projects/{project.id}", headers=admin).status_code == 204
    assert session.scalars(select(LabelGroup)).all() == []
    assert session.scalars(select(LabelGroupMember)).all() == []
    deleted = _audit(session, "labeling_group.delete")
    assert [(r.target, r.detail["reason"]) for r in deleted] == [
        (f"project:{project.id}/labeling_group:{gid}", "project_deleted")]


def test_project_members_with_labeling_permission_can_read_groups(client, add_user, session):
    admin, project, m = _setup(client, add_user, session)
    md, ra = m["md01"][0], m["ra01"][0]
    client.post(_url(project.id), headers=admin, json={"name": "G", "member_ids": [md.id]})
    url = f"/api/projects/{project.id}/labeling-groups"
    got = client.get(url, headers=m["ra01"][1])
    assert got.status_code == 200
    assert [(g["name"], [x["username"] for x in g["members"]]) for g in got.json()] == [("G", ["md01"])]
    assert client.get(url, headers=m["vw01"][1]).status_code == 403   # Viewer 沒有 Labeling 權限
