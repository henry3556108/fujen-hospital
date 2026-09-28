from sqlalchemy import select

from app.models import AuditLog

BASE = "/api/admin/gpu-groups"


def names(client, admin):
    return [g["name"] for g in client.get(BASE, headers=admin).json()]


def test_default_groups_match_seed_baseline(client, backend, admin):
    groups = {g["name"]: g for g in client.get(BASE, headers=admin).json()}
    assert groups["gpu-exclusive"] == {"name": "gpu-exclusive", "pool": "gpu-exclusive", "gpu_count": 2,
                                       "mode": "exclusive", "queue": "gpu-exclusive"}
    assert groups["gpu-shared"]["mode"] == "shared" and groups["gpu-shared"]["gpu_count"] == 1


def test_tc_c01_02_create_two_groups_then_reload(client, backend, admin):
    created = [
        client.post(BASE, headers=admin, json={"name": "img-train", "pool": "gpu-exclusive", "gpu_count": 1,
                                               "mode": "exclusive"}),
        client.post(BASE, headers=admin, json={"name": "tab-small", "pool": "gpu-shared", "gpu_count": 1,
                                               "mode": "shared"}),
    ]
    assert [r.status_code for r in created] == [201, 201]
    reloaded = {g["name"]: g for g in client.get(BASE, headers=admin).json()}
    for r in created:
        assert reloaded[r.json()["name"]] == r.json()


def test_deleted_default_groups_are_not_recreated(client, backend, admin):
    names(client, admin)
    assert client.delete(f"{BASE}/gpu-shared", headers=admin).status_code == 204
    assert "gpu-shared" not in names(client, admin)


def test_group_validation(client, backend, admin):
    bad = [
        {"name": "x", "pool": "gpu-exclusive", "gpu_count": 1, "mode": "timeslice"},
        {"name": "x", "pool": "gpu-nowhere", "gpu_count": 1, "mode": "exclusive"},
        {"name": "x", "pool": "gpu-exclusive", "gpu_count": 0, "mode": "exclusive"},
        {"name": "x", "pool": "gpu-shared", "gpu_count": 1, "mode": "exclusive"},
        {"name": "", "pool": "gpu-shared", "gpu_count": 1, "mode": "shared"},
    ]
    assert [client.post(BASE, headers=admin, json=b).status_code for b in bad] == [422] * 5


def test_duplicate_group_is_409(client, backend, admin):
    body = {"name": "gpu-exclusive", "pool": "gpu-exclusive", "gpu_count": 2, "mode": "exclusive"}
    response = client.post(BASE, headers=admin, json=body)
    assert response.status_code == 409 and "已存在" in response.json()["detail"]


def test_patch_group(client, backend, admin):
    response = client.patch(f"{BASE}/gpu-exclusive", headers=admin, json={"gpu_count": 1})
    assert response.status_code == 200 and response.json()["gpu_count"] == 1
    assert client.patch(f"{BASE}/nope", headers=admin, json={"gpu_count": 1}).status_code == 404
    assert client.patch(f"{BASE}/gpu-exclusive", headers=admin, json={"gpu_count": None}).status_code == 422


def test_cannot_delete_group_bound_to_project(client, backend, admin, make_project):
    make_project("P1", gpu_group="gpu-exclusive")
    response = client.delete(f"{BASE}/gpu-exclusive", headers=admin)
    assert response.status_code == 409 and "P1" in response.json()["detail"]


def test_non_admin_denied(client, backend, add_user):
    _, headers = add_user("user01")
    assert client.get(BASE, headers=headers).status_code == 403
    assert client.post(BASE, headers=headers, json={"name": "x", "pool": "gpu-shared", "gpu_count": 1,
                                                    "mode": "shared"}).status_code == 403


def test_group_changes_are_audited(client, backend, admin, session):
    client.post(BASE, headers=admin, json={"name": "g2", "pool": "gpu-shared", "gpu_count": 1, "mode": "shared"})
    client.delete(f"{BASE}/g2", headers=admin)
    rows = session.scalars(select(AuditLog).where(AuditLog.target == "gpu_group:g2")).all()
    assert [(r.category, r.action, r.actor) for r in rows] == [("project", "gpu_group.create", "admin01"),
                                                               ("project", "gpu_group.delete", "admin01")]
