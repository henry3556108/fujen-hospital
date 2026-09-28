from sqlalchemy import select

from app.models import AuditLog
from app.permissions import AccountType


def test_tc_a03_01_project_crud_three_times_with_audit(client, add_user, session):
    _, admin = add_user("admin01", AccountType.ADMIN)
    for i in range(3):
        created = client.post("/api/admin/projects", headers=admin, json={"name": f"P-{i}", "gpu_group": "gpu-exclusive"})
        assert created.status_code == 201
        pid = created.json()["id"]
        updated = client.patch(f"/api/admin/projects/{pid}", headers=admin, json={"description": "改過"})
        assert updated.status_code == 200 and updated.json()["description"] == "改過"
        assert client.delete(f"/api/admin/projects/{pid}", headers=admin).status_code == 204

    actions = [e.action for e in session.scalars(select(AuditLog).where(AuditLog.category == "project"))]
    assert actions.count("create") == 3 and actions.count("update") == 3 and actions.count("delete") == 3


def test_tc_a03_03_non_admin_cannot_manage_projects(client, add_user):
    _, pi = add_user("pi01")
    for _ in range(5):
        response = client.post("/api/admin/projects", headers=pi, json={"name": "偷建"})
        assert response.status_code == 403
        assert response.json()["detail"] == "需要 Admin 權限"


def test_duplicate_project_name_is_409(client, add_user):
    _, admin = add_user("admin01", AccountType.ADMIN)
    assert client.post("/api/admin/projects", headers=admin, json={"name": "P1"}).status_code == 201
    assert client.post("/api/admin/projects", headers=admin, json={"name": "P1"}).status_code == 409


def test_missing_project_is_404(client, add_user):
    _, admin = add_user("admin01", AccountType.ADMIN)
    response = client.patch("/api/admin/projects/999", headers=admin, json={"description": "x"})
    assert response.status_code == 404
    assert "找不到" in response.json()["detail"]
