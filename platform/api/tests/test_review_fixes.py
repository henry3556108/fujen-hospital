"""WP1a 全分支 review 發現的問題的回歸測試。"""
import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app import admin_service
from app.models import AuditLog, Project, User
from app.permissions import AccountType


@pytest.fixture
def admin(add_user):
    return add_user("admin01", AccountType.ADMIN)[1]


# Important 1：PATCH null 或空名稱不能變成 500
@pytest.mark.parametrize("body", [{"name": None}, {"description": None}, {"name": ""}])
def test_project_patch_rejects_null_and_empty(client, admin, session, body):
    session.add(Project(name="P1"))
    session.commit()
    pid = session.scalar(select(Project.id))
    assert client.patch(f"/api/admin/projects/{pid}", headers=admin, json=body).status_code == 422


def test_project_create_rejects_empty_name(client, admin):
    assert client.post("/api/admin/projects", headers=admin, json={"name": ""}).status_code == 422


def test_user_create_rejects_empty_username(client, admin):
    body = {"username": "", "password": "Init-Passw0rd!", "account_type": "user"}
    assert client.post("/api/admin/users", headers=admin, json=body).status_code == 422


# Important 2：併發造成的唯一鍵衝突回 409，不是 500
def test_integrity_error_maps_to_409(app, client):
    def boom():
        raise IntegrityError("INSERT", {}, Exception("UNIQUE constraint failed: projects.name"))
    app.add_api_route("/__test/integrity", boom)
    response = client.get("/__test/integrity")
    assert response.status_code == 409


# Important 4：身分提供者只在資料庫變更（含稽核）都準備好後才呼叫
def test_delete_user_keeps_idp_account_when_db_side_fails(client, admin, add_user, idp, monkeypatch):
    victim, _ = add_user("ra01")
    def fail(*args, **kwargs):
        raise RuntimeError("audit write failed")
    monkeypatch.setattr(admin_service, "record", fail)
    with pytest.raises(RuntimeError):
        client.delete(f"/api/admin/users/{victim.id}", headers=admin)
    assert idp.find_subject("ra01") is not None


def test_reset_password_keeps_old_password_when_db_side_fails(client, admin, add_user, idp, monkeypatch):
    victim, _ = add_user("ra01")
    def fail(*args, **kwargs):
        raise RuntimeError("audit write failed")
    monkeypatch.setattr(admin_service, "record", fail)
    with pytest.raises(RuntimeError):
        client.post(f"/api/admin/users/{victim.id}/reset-password", headers=admin, json={"new_password": "X-Passw0rd!"})
    assert idp.check_password("ra01", "Dev-Passw0rd!")


# Important 5：稽核來源 IP 取 Gateway 附加的最右邊一筆，不信任用戶端自帶的值
def test_audit_source_ip_uses_rightmost_forwarded_entry(client, admin, session):
    headers = {**admin, "X-Forwarded-For": "6.6.6.6, 10.0.0.9"}
    client.post("/api/admin/projects", headers=headers, json={"name": "P-ip"})
    entry = session.scalar(select(AuditLog).where(AuditLog.category == "project"))
    assert entry.source_ip == "10.0.0.9"


# Important 6：ID token 不能當 access token 用
@pytest.mark.parametrize("typ", ["ID", "Refresh", None])
def test_non_access_tokens_are_401(client, add_user, make_token, typ):
    user, _ = add_user("pi01")
    token = make_token(user.idp_subject, "pi01", typ=typ)
    assert client.get("/api/me", headers={"Authorization": f"Bearer {token}"}).status_code == 401
