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


def test_create_user_compensation_failure_keeps_original_error(client, add_user, idp, session, monkeypatch, caplog):
    """資料庫寫入失敗、補償（刪除身分提供者帳號）也失敗時：往外拋的是原本的錯誤，補償失敗另外留下紀錄。"""
    import logging

    import pytest

    from app import admin_service

    _, admin = add_user("admin01", AccountType.ADMIN)

    class DatabaseDown(Exception):
        pass

    def failing_record(*args, **kwargs):
        raise DatabaseDown("資料庫寫入失敗")

    def failing_delete(subject):
        raise RuntimeError("idp down")

    monkeypatch.setattr(admin_service, "record", failing_record)
    monkeypatch.setattr(idp, "delete_user", failing_delete)

    with caplog.at_level(logging.ERROR, logger="app.admin_service"), pytest.raises(DatabaseDown) as raised:
        client.post("/api/admin/users", headers=admin,
                    json={"username": "orphan01", "password": "Init-Passw0rd!", "account_type": "user"})

    subject = idp.find_subject("orphan01")
    assert subject is not None                                   # 孤兒帳號還在身分提供者裡
    assert any("補償失敗" in r.getMessage() and subject in r.getMessage() for r in caplog.records)
    assert any("補償" in note for note in getattr(raised.value, "__notes__", []))

    monkeypatch.undo()
    session.expire_all()
    failed = session.scalars(select(AuditLog).where(AuditLog.action == "create.compensation_failed")).all()
    assert [(e.category, e.result, e.actor, e.detail["username"], e.detail["idp_subject"]) for e in failed] == [
        ("account", "failed", "admin01", "orphan01", subject)]
    assert client.get("/api/admin/users", headers=admin).json() == [
        {"id": 1, "username": "admin01", "account_type": "admin"}]   # 資料庫沒有留下半筆帳號


def test_create_user_compensation_success_leaves_no_trace(client, add_user, idp, session, monkeypatch):
    import pytest

    from app import admin_service

    _, admin = add_user("admin01", AccountType.ADMIN)

    def failing_record(*args, **kwargs):
        raise RuntimeError("資料庫寫入失敗")
    monkeypatch.setattr(admin_service, "record", failing_record)
    with pytest.raises(RuntimeError, match="資料庫寫入失敗"):
        client.post("/api/admin/users", headers=admin,
                    json={"username": "u1", "password": "Init-Passw0rd!", "account_type": "user"})
    assert idp.find_subject("u1") is None


def test_deleted_user_old_token_gets_401(client, add_user):
    """回歸：經 API 刪除帳號後，仍在有效期內的舊 token 不能再用。"""
    _, admin = add_user("admin01", AccountType.ADMIN)
    ra, ra_headers = add_user("ra01")
    assert client.get("/api/me", headers=ra_headers).status_code == 200
    assert client.delete(f"/api/admin/users/{ra.id}", headers=admin).status_code == 204
    for path in ("/api/me", "/api/admin/users", "/api/projects/1/imaging/studies"):
        response = client.get(path, headers=ra_headers)
        assert response.status_code == 401, path
        assert response.json()["detail"] == "帳號不存在或已停用"
