"""TC-C02-01：平台 API 的 /metrics（Prometheus 文字格式），叢集內由 Prometheus 以 Pod 註記探索抓取。"""


def _samples(text: str, name: str) -> dict[str, float]:
    return {line.split(" ")[0]: float(line.split(" ")[1]) for line in text.splitlines()
            if line.startswith(name + "{") or line.startswith(name + " ")}


def test_metrics_endpoint_is_prometheus_text(client):
    response = client.get("/metrics")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/plain")
    assert "# TYPE platform_api_http_requests_total counter" in response.text
    assert "process_cpu_seconds_total" in response.text or "python_info" in response.text


def test_requests_are_counted_by_route_template_not_raw_path(client):
    client.get("/healthz")
    client.get("/api/projects/12345/imaging/studies")   # 未登入：401，路徑含 ID
    client.get("/no/such/path")
    text = client.get("/metrics").text
    counts = _samples(text, "platform_api_http_requests_total")
    assert counts['platform_api_http_requests_total{method="GET",route="/healthz",status="200"}'] == 1
    assert any('route="/api/projects/{project_id}/imaging/studies"' in k and 'status="401"' in k for k in counts)
    assert not any("12345" in k for k in counts)
    # 不存在的路徑合併成一個標籤值，避免任意網址撐大序列數
    assert any('route="(unmatched)"' in k and 'status="404"' in k for k in counts)
    assert "platform_api_http_request_duration_seconds_bucket" in text
    # /metrics 自己不計入
    assert not any('route="/metrics"' in k for k in counts)


def test_each_app_has_its_own_registry(client):
    from app.main import create_app

    other = create_app()
    from fastapi.testclient import TestClient

    with TestClient(other) as c:
        assert c.get("/metrics").status_code == 200
