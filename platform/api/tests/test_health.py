def test_healthz(client):
    response = client.get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_testclient_uses_httpx2():
    """Starlette 的 TestClient 改用 httpx2；裝回 httpx 會出現棄用警告（pyproject 已設為錯誤）。"""
    import starlette.testclient as tc

    assert tc.httpx.__name__ == "httpx2"
