import time

from conftest import DEV_PASSWORD


def _user_id(api, admin, username):
    return next(u["id"] for u in api.get("/api/admin/users", headers=admin).json() if u["username"] == username)


def _project_id(api, admin, name):
    return next(p["id"] for p in api.get("/api/admin/projects", headers=admin).json() if p["name"] == name)


def test_tc_a03_01_project_crud(api, auth):
    admin = auth("admin01")
    for i in range(3):
        pid = api.post("/api/admin/projects", headers=admin, json={"name": f"acc-{time.time_ns()}-{i}"}).json()["id"]
        assert api.patch(f"/api/admin/projects/{pid}", headers=admin, json={"description": "改"}).status_code == 200
        assert api.delete(f"/api/admin/projects/{pid}", headers=admin).status_code == 204


def test_tc_a03_02_user_crud_and_login(api, auth):
    admin = auth("admin01")
    for i in range(3):
        name = f"acc{time.time_ns()}{i}"
        uid = api.post("/api/admin/users", headers=admin,
                       json={"username": name, "password": "Init-Passw0rd!", "account_type": "user"}).json()["id"]
        assert api.get("/api/me", headers=auth(name, "Init-Passw0rd!")).status_code == 200
        assert api.delete(f"/api/admin/users/{uid}", headers=admin).status_code == 204


def test_tc_a03_03_non_admin_denied(api, auth):
    for username in ["pi01", "user01"]:
        headers = auth(username)
        for _ in range(5):
            assert api.post("/api/admin/users", headers=headers,
                            json={"username": "x", "password": "Init-Passw0rd!", "account_type": "admin"}).status_code == 403


def test_tc_a03_06_permission_change_within_10_seconds(api, auth):
    admin = auth("admin01")
    ra_headers = auth("ra01")
    pid = _project_id(api, admin, "P1-lung-ct")
    uid = _user_id(api, admin, "ra01")
    api.put(f"/api/admin/projects/{pid}/members/{uid}", headers=admin,
            json={"role": "research_assistant", "permissions": ["project", "labeling", "prediction"]})
    start = time.monotonic()
    perms = api.get("/api/me", headers=ra_headers).json()["projects"][0]["permissions"]
    assert "training" not in perms and time.monotonic() - start < 10
    api.put(f"/api/admin/projects/{pid}/members/{uid}", headers=admin, json={"role": "research_assistant"})
    assert "training" in api.get("/api/me", headers=ra_headers).json()["projects"][0]["permissions"]


def test_tc_a03_08_reset_password(api, auth):
    admin = auth("admin01")
    uid = _user_id(api, admin, "user02")
    try:
        for i in range(3):
            new = f"Reset-Passw0rd-{i}!"
            assert api.post(f"/api/admin/users/{uid}/reset-password", headers=admin,
                            json={"new_password": new}).status_code == 204
            assert api.get("/api/me", headers=auth("user02", new)).status_code == 200
    finally:  # 還原成種子密碼，讓其他案例可獨立重跑
        api.post(f"/api/admin/users/{uid}/reset-password", headers=admin, json={"new_password": DEV_PASSWORD})


def test_members_list_matches_seed(api, auth):
    admin = auth("admin01")
    pid = _project_id(api, admin, "P1-lung-ct")
    members = api.get(f"/api/admin/projects/{pid}/members", headers=admin).json()
    assert sorted(m["username"] for m in members) == ["ca01", "md01", "pi01", "ra01", "vw01"]
