import httpx
import pytest

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
