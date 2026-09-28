from sqlalchemy import select

from app.models import AuditLog
from app.permissions import AccountType


def test_tc_a03_02_user_crud_three_times_synced_with_idp(client, add_user, idp, session):
    _, admin = add_user("admin01", AccountType.ADMIN)
    for i in range(3):
        created = client.post("/api/admin/users", headers=admin,
                              json={"username": f"u{i}", "password": "Init-Passw0rd!", "account_type": "user"})
        assert created.status_code == 201
        uid = created.json()["id"]
        assert idp.find_subject(f"u{i}") is not None
        assert client.patch(f"/api/admin/users/{uid}", headers=admin, json={"account_type": "admin"}).status_code == 200
        assert client.delete(f"/api/admin/users/{uid}", headers=admin).status_code == 204
        assert idp.find_subject(f"u{i}") is None

    actions = [e.action for e in session.scalars(select(AuditLog).where(AuditLog.category == "account"))]
    assert actions.count("create") == 3 and actions.count("update") == 3 and actions.count("delete") == 3


def test_tc_a03_08_reset_password_three_times(client, add_user, idp):
    _, admin = add_user("admin01", AccountType.ADMIN)
    ra, _ = add_user("ra01")
    previous = "Dev-Passw0rd!"
    for i in range(3):
        new = f"New-Passw0rd-{i}!"
        response = client.post(f"/api/admin/users/{ra.id}/reset-password", headers=admin, json={"new_password": new})
        assert response.status_code == 204
        assert idp.check_password("ra01", new)
        assert not idp.check_password("ra01", previous)
        previous = new


def test_tc_a03_03_non_admin_cannot_create_users(client, add_user):
    _, user01 = add_user("user01")
    for _ in range(5):
        response = client.post("/api/admin/users", headers=user01,
                               json={"username": "x", "password": "Init-Passw0rd!", "account_type": "admin"})
        assert response.status_code == 403


def test_duplicate_username_is_409(client, add_user):
    _, admin = add_user("admin01", AccountType.ADMIN)
    body = {"username": "dup", "password": "Init-Passw0rd!", "account_type": "user"}
    assert client.post("/api/admin/users", headers=admin, json=body).status_code == 201
    assert client.post("/api/admin/users", headers=admin, json=body).status_code == 409


def test_admin_cannot_delete_self(client, add_user):
    admin_user, admin = add_user("admin01", AccountType.ADMIN)
    assert client.delete(f"/api/admin/users/{admin_user.id}", headers=admin).status_code == 409


def test_last_admin_cannot_be_demoted(client, add_user):
    admin_user, admin = add_user("admin01", AccountType.ADMIN)
    response = client.patch(f"/api/admin/users/{admin_user.id}", headers=admin, json={"account_type": "user"})
    assert response.status_code == 409


def test_invalid_account_type_is_422(client, add_user):
    _, admin = add_user("admin01", AccountType.ADMIN)
    response = client.post("/api/admin/users", headers=admin,
                           json={"username": "x", "password": "Init-Passw0rd!", "account_type": "root"})
    assert response.status_code == 422
