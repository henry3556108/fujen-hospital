from urllib.parse import unquote, urlsplit

import httpx
import pytest

import platform_exec as pe

SEEDED = ["admin01", "pi01", "md01", "ra01", "ca01", "vw01", "user01", "user02"]


def test_tc_ss_01_all_seeded_accounts_can_login(api, auth):
    for username in SEEDED:
        assert api.get("/api/me", headers=auth(username)).status_code == 200


def test_tc_ss_02_no_token_ten_times(api):
    paths = ["/api/me", "/api/admin/users", "/api/admin/projects"] * 3 + ["/api/admin/projects/1/members"]
    assert all(api.get(p).status_code == 401 for p in paths)


@pytest.mark.parametrize("url", ["http://localhost:8000/api/me", "http://localhost:5432"])
def test_tc_ss_05_internal_services_not_reachable_from_host(url):
    for _ in range(10):
        with pytest.raises(httpx.TransportError):
            httpx.get(url, timeout=2)


def test_cors_preflight_allows_web_origin_only(api):
    ok = api.options("/api/me", headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "GET",
                                          "Access-Control-Request-Headers": "authorization"})
    assert ok.headers.get("access-control-allow-origin") == "http://localhost:5173"
    evil = api.options("/api/me", headers={"Origin": "http://evil.test", "Access-Control-Request-Method": "GET"})
    assert evil.headers.get("access-control-allow-origin") != "http://evil.test"


def _app_db_account() -> tuple[str, str]:
    url = urlsplit(pe.env_of("api", "DATABASE_URL").replace("postgresql+psycopg://", "postgresql://"))
    return unquote(url.username or ""), unquote(url.password or "")


def _as_app(sql: str):
    user, password = _app_db_account()
    return pe.exec_in("postgres", "env", f"PGPASSWORD={password}", "psql", "-h", "127.0.0.1", "-U", user,
                      "-d", "platform", "-v", "ON_ERROR_STOP=1", "-qtAc", sql, check=False, timeout=60)


@pytest.mark.skipif(not pe.AVAILABLE, reason=pe.REASON)
def test_tc_ss_07_api_database_account_can_only_insert_and_select_audit_log():
    """TC-SS-07 第 2 部分：平台 API 的資料庫帳號（DATABASE_URL）對稽核表只有 INSERT 與 SELECT。"""
    user, _ = _app_db_account()
    assert user and user != "platform", f"平台 API 仍以擁有者 {user!r} 連線"
    assert pe.sql(f"select rolsuper or rolcreatedb or rolcreaterole from pg_roles where rolname = '{user}'") == "f"
    rights = pe.sql(f"select string_agg(p, ',' order by p) from unnest(array['SELECT','INSERT','UPDATE','DELETE',"
                    f"'TRUNCATE','REFERENCES','TRIGGER']) p where has_table_privilege('{user}', 'audit_log', p)")
    assert rights == "INSERT,SELECT"

    before = pe.sql("select count(*) || ':' || max(id) from audit_log")
    for sql in ("update audit_log set actor = 'tampered' where id = (select max(id) from audit_log)",
                "delete from audit_log where id = (select max(id) from audit_log)",
                "truncate audit_log"):
        out = _as_app(sql)
        assert out.returncode != 0 and "permission denied" in out.stderr, (sql, out.stderr)
    assert pe.sql("select count(*) || ':' || max(id) from audit_log") == before
    assert pe.sql("select count(*) from audit_log where actor = 'tampered'") == "0"

    ok = _as_app("select count(*) from audit_log")
    assert ok.returncode == 0 and int(ok.stdout.strip()) >= 1
    marker = f"tc-ss-07-{before.replace(':', '-')}"
    ok = _as_app("insert into audit_log (at, actor, category, action, target, result, source_ip, detail) "
                 f"values (now(), 'tc-ss-07', 'account', 'acceptance.insert_check', '{marker}', 'success', "
                 "'local:acceptance', '{}')")
    assert ok.returncode == 0, ok.stderr
    assert pe.sql(f"select count(*) from audit_log where target = '{marker}'") == "1"
