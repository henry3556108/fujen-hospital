import time

import pytest

import platform_exec as pe
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


def test_deleted_account_old_token_rejected(api, auth):
    """回歸：經 API 刪除帳號後，仍在有效期內的舊 token 經 Gateway 呼叫得 401。"""
    admin = auth("admin01")
    name = f"gone{time.time_ns()}"
    uid = api.post("/api/admin/users", headers=admin,
                   json={"username": name, "password": "Init-Passw0rd!", "account_type": "user"}).json()["id"]
    old_token = auth(name, "Init-Passw0rd!")
    assert api.get("/api/me", headers=old_token).status_code == 200
    assert api.delete(f"/api/admin/users/{uid}", headers=admin).status_code == 204
    for _ in range(3):
        assert api.get("/api/me", headers=old_token).status_code == 401


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


def _member_ids(api, admin, pid, *usernames):
    members = api.get(f"/api/admin/projects/{pid}/members", headers=admin).json()
    return [m["user_id"] for m in members if m["username"] in usernames]


@pytest.mark.skipif(not pe.AVAILABLE, reason=pe.REASON)
def test_tc_a03_10_labeling_group_and_dashboard_match_database(api, auth):
    """TC-A03-10：admin01 建立標註群組（project 類稽核），Dashboard 的每個數字與資料庫一致。"""
    admin = auth("admin01")
    pid = _project_id(api, admin, "P1-lung-ct")
    name = f"acc-group-{time.time_ns()}"
    created = api.post(f"/api/admin/projects/{pid}/labeling-groups", headers=admin,
                       json={"name": name, "member_ids": _member_ids(api, admin, pid, "md01", "ra01")})
    assert created.status_code == 201, created.text
    gid = created.json()["id"]
    try:
        assert sorted(m["username"] for m in created.json()["members"]) == ["md01", "ra01"]
        audit = pe.sql("select category || ' ' || actor || ' ' || coalesce(source_ip, '') from audit_log "
                       f"where action = 'labeling_group.create' and target = 'project:{pid}/labeling_group:{gid}'")
        category, actor, source = audit.split(" ")
        assert (category, actor) == ("project", "admin01") and source

        board = api.get("/api/admin/dashboard", headers=admin).json()
        count = lambda table, where="": int(pe.sql(f"select count(*) from {table} {where}"))
        assert board["accounts"] == {"total": count("users"),
                                     "admin": count("users", "where account_type = 'admin'"),
                                     "user": count("users", "where account_type = 'user'")}
        assert board["projects"] == count("projects")
        assert board["memberships"] == count("memberships")
        assert board["labeling_groups"] == count("label_groups")
        assert board["labeling_group_members"] == count("label_group_members")
        assert board["tabular_datasets"] == count("tabular_datasets")
        assert board["imaging_studies"] == count("imaging_studies")
        assert board["gpu_groups"] == count("gpu_groups")
        by_status = dict(line.split("|") for line in
                         pe.sql("select status, count(*) from jobs group by status").splitlines() if line)
        assert {k: v for k, v in board["jobs"]["by_status"].items() if v} == {k: int(v) for k, v in by_status.items()}
        assert board["jobs"]["total"] == count("jobs")
        p1 = next(p for p in board["per_project"] if p["id"] == pid)
        assert p1["members"] == count("memberships", f"where project_id = {pid}")
        assert p1["labeling_groups"] == count("label_groups", f"where project_id = {pid}") >= 1
    finally:
        assert api.delete(f"/api/admin/projects/{pid}/labeling-groups/{gid}", headers=admin).status_code == 204
