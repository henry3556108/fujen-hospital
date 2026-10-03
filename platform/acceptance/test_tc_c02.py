"""TC-C02：系統監控（Prometheus、Grafana、Alertmanager → Mailpit），kind 叢集。"""
import subprocess
import time
from pathlib import Path

import httpx
import pytest
import yaml

from kind_harness import (ALERTMANAGER, GRAFANA, GRAFANA_AUTH, MAILPIT, PROMETHEUS, build_platform, clear_jobs,
                          kube_or_skip, wait_for)

pytestmark = pytest.mark.kind

# 平台本身（ai-platform）也在內：只看 monitoring 等 3 個命名空間時，平台的 18 個服務沒有監控也會通過
MONITORED_NAMESPACES = ["monitoring", "kueue-system", "platform-web", "ai-platform"]
# 覆蓋政策（與 compliance monitoring 相同）：container_metrics_only 的服務沒有 /metrics，以 cAdvisor 的容器指標覆蓋
POLICY = Path(__file__).resolve().parents[1] / "compliance/policy/monitoring.yaml"


def container_metrics_only() -> set[str]:
    return set(yaml.safe_load(POLICY.read_text(encoding="utf-8"))["container_metrics_only"])


@pytest.fixture
def kube():
    k = kube_or_skip()
    try:
        httpx.get(f"{PROMETHEUS}/-/ready", timeout=3).raise_for_status()
    except httpx.HTTPError as exc:
        pytest.skip(f"監控堆疊連不上：{exc}")

    def scraped_once():
        active = httpx.get(f"{PROMETHEUS}/api/v1/targets", params={"state": "active"}, timeout=10).json()
        return all(t["health"] != "unknown" for t in active["data"]["activeTargets"])

    wait_for(scraped_once, timeout=90, interval=3, message="Prometheus 還沒抓過所有目標")
    return k


def prom(query: str) -> list[dict]:
    response = httpx.get(f"{PROMETHEUS}/api/v1/query", params={"query": query}, timeout=10)
    response.raise_for_status()
    return response.json()["data"]["result"]


def prom_value(query: str) -> float:
    result = prom(query)
    assert len(result) == 1, f"{query} → {result}"
    return float(result[0]["value"][1])


def test_tc_c02_01_prometheus_targets_cover_deployed_services(kube):
    services = {(ns, w.metadata.name) for ns in MONITORED_NAMESPACES
                for w in [*kube.apps.list_namespaced_deployment(ns).items,
                          *kube.apps.list_namespaced_stateful_set(ns).items]}
    assert any(ns == "ai-platform" for ns, _ in services), "平台沒有部署在 ai-platform"
    targets = httpx.get(f"{PROMETHEUS}/api/v1/targets", params={"state": "active"}, timeout=10).json()["data"]
    active = targets["activeTargets"]
    down = [(t["labels"]["job"], t["labels"].get("instance"), t.get("lastError")) for t in active if t["health"] != "up"]
    assert down == []
    jobs = {t["labels"]["job"] for t in active}
    only = container_metrics_only()
    scraped = {name for ns, name in services if f"{ns}/{name}" not in only}
    assert scraped | {"kubelet", "cadvisor"} == jobs, f"缺抓取目標：{sorted(scraped - jobs)}；多出：{sorted(jobs - scraped - {'kubelet', 'cadvisor'})}"
    # 平台服務的目標來自 ai-platform 的 Pod（註記探索），每個執行中的 Pod 一個
    for ns, name in sorted(services):
        if ns == "ai-platform" and name in scraped:
            pods = {t["labels"].get("pod") for t in active if t["labels"]["job"] == name}
            assert all(t["labels"].get("namespace") == "ai-platform" for t in active if t["labels"]["job"] == name), name
            assert pods and None not in pods, (name, pods)
    nodes = {n.metadata.name for n in kube.core.list_node().items}
    for job in ("kubelet", "cadvisor"):
        assert {t["labels"]["node"] for t in active if t["labels"]["job"] == job} == nodes
    # 每個已部署服務（含沒有 /metrics 的）都要有容器層指標
    for ns in MONITORED_NAMESPACES:
        pods = {p.metadata.name for p in kube.core.list_namespaced_pod(ns).items if p.status.phase == "Running"}
        seen = {r["metric"]["pod"] for r in prom(f'container_memory_working_set_bytes{{namespace="{ns}",container!=""}}')}
        assert pods <= seen, f"{ns} 缺少容器指標：{pods - seen}"


def test_tc_c02_02_five_metric_classes_match_source(kube):
    for _ in range(3):
        nodes = kube.core.list_node().items
        # 節點
        assert prom_value("count(kube_node_info)") == len(nodes)
        # Pod
        pods = [p for p in kube.core.list_namespaced_pod("monitoring").items]
        assert prom_value('count(kube_pod_info{namespace="monitoring"})') == len(pods)
        # CPU（請求量，與 Pod 規格逐一比對）與記憶體（上限）
        for pod in pods:
            c = pod.spec.containers[0]
            name = pod.metadata.name
            cpu = prom_value(f'kube_pod_container_resource_requests{{namespace="monitoring",pod="{name}",resource="cpu"}}')
            mem = prom_value(f'kube_pod_container_resource_limits{{namespace="monitoring",pod="{name}",resource="memory"}}')
            assert cpu == _cpu(c.resources.requests["cpu"])
            assert mem == _bytes(c.resources.limits["memory"])
            # 實際使用量：cAdvisor 有值
            assert prom_value(f'sum(container_memory_working_set_bytes{{namespace="monitoring",pod="{name}",container!=""}})') > 0
        # GPU（Mac 上是假 GPU 的宣告份數；DCGM 使用率在甲方驗）
        for node in nodes:
            capacity = (node.status.capacity or {}).get("nvidia.com/gpu")
            result = prom(f'kube_node_status_capacity{{node="{node.metadata.name}",resource="nvidia_com_gpu"}}')
            if capacity is None:
                assert result == []
            else:
                assert float(result[0]["value"][1]) == float(capacity)
        time.sleep(5)


def _cpu(value: str) -> float:
    return float(value[:-1]) / 1000 if value.endswith("m") else float(value)


def _bytes(value: str) -> float:
    units = {"Ki": 1024, "Mi": 1024 ** 2, "Gi": 1024 ** 3}
    for suffix, factor in units.items():
        if value.endswith(suffix):
            return float(value[:-2]) * factor
    return float(value)


def test_tc_c02_03_custom_dashboard_survives_reload(kube):
    with httpx.Client(base_url=GRAFANA, auth=GRAFANA_AUTH, timeout=10) as g:
        assert g.get("/api/dashboards/uid/platform-cluster").status_code == 200  # 預設儀表板已佈建
        uid = f"tc-c02-03-{time.time_ns()}"
        panels = [
            {"id": 1, "type": "timeseries", "title": "Pod 記憶體", "gridPos": {"x": 0, "y": 0, "w": 12, "h": 8},
             "datasource": {"type": "prometheus", "uid": "prometheus"},
             "targets": [{"refId": "A", "expr": "sum by (namespace) (container_memory_working_set_bytes{container!=\"\"})"}]},
            {"id": 2, "type": "gauge", "title": "假 GPU 可用份數", "gridPos": {"x": 12, "y": 0, "w": 12, "h": 8},
             "datasource": {"type": "prometheus", "uid": "prometheus"},
             "targets": [{"refId": "A", "expr": "sum(kube_node_status_allocatable{resource=\"nvidia_com_gpu\"})"}]},
        ]
        dashboard = {"uid": uid, "title": f"TC-C02-03 {uid}", "refresh": "10s", "panels": panels, "schemaVersion": 39}
        assert g.post("/api/dashboards/db", json={"dashboard": dashboard, "overwrite": False}).status_code == 200
        saved = g.get(f"/api/dashboards/uid/{uid}").json()["dashboard"]
        saved["refresh"] = "1m"
        assert g.post("/api/dashboards/db", json={"dashboard": saved, "overwrite": True}).status_code == 200
        try:
            reloaded = g.get(f"/api/dashboards/uid/{uid}").json()["dashboard"]
            assert reloaded["refresh"] == "1m"
            assert [(p["type"], p["title"]) for p in reloaded["panels"]] == [(p["type"], p["title"]) for p in panels]
        finally:
            g.delete(f"/api/dashboards/uid/{uid}")


def mails() -> list[dict]:
    response = httpx.get(f"{MAILPIT}/api/v1/messages", params={"limit": 500}, timeout=10)
    response.raise_for_status()
    return response.json()["messages"] or []


def mails_about(alertname: str, marker: str) -> list[dict]:
    return [m for m in mails() if alertname in m["Subject"] and marker in m["Subject"]]


def node_alert_active(node: str) -> bool:
    alerts = httpx.get(f"{ALERTMANAGER}/api/v2/alerts", timeout=10).json()
    return any(a["labels"]["alertname"] == "NodeNotReady" and a["labels"].get("node") == node for a in alerts)


def test_tc_c02_04_alerts_delivered_once_each(kube, tmp_path):
    from kubernetes.client import V1Container, V1ObjectMeta, V1Pod, V1PodSpec, V1ResourceRequirements

    clear_jobs(kube)
    shared_node = kube.core.list_node(label_selector="platform/pool=gpu-shared").items[0].metadata.name
    # 上一輪的節點告警（keep_firing_for）還在時，這一輪的事件會被視為同一件而不重寄，先等它結束
    wait_for(lambda: not node_alert_active(shared_node), timeout=240, interval=5, message="上一輪的節點告警未結束")
    httpx.delete(f"{MAILPIT}/api/v1/messages", timeout=10).raise_for_status()
    platform = build_platform(tmp_path / "platform.db", kube)
    burner = f"cpu-burner-{time.time_ns() % 100000}"
    try:
        # 事件 1：平台工作失敗
        failed = platform.submit("P1-lung-ct", "ra01", duration_seconds=1, fail=True)
        # 事件 2：Pod CPU 過高（cpu-data 節點上的忙迴圈）
        kube.core.create_namespaced_pod("platform-web", V1Pod(
            metadata=V1ObjectMeta(name=burner),
            spec=V1PodSpec(node_selector={"platform/pool": "cpu-data"}, termination_grace_period_seconds=0,
                           containers=[V1Container(name="burn", image="busybox:1.36",
                                                   command=["sh", "-c", "while :; do :; done"],
                                                   resources=V1ResourceRequirements(requests={"cpu": "10m", "memory": "8Mi"},
                                                                                    limits={"cpu": "1", "memory": "16Mi"}))])))
        # 事件 3：節點失聯（暫停 gpu-shared 節點容器，kubelet 停止回報）
        subprocess.run(["docker", "pause", shared_node], check=True)
        expected = {"PlatformJobFailed": failed["k8s_name"], "HighPodCpu": burner, "NodeNotReady": shared_node}
        try:
            wait_for(lambda: all(mails_about(a, m) for a, m in expected.items()), timeout=240, interval=5)
        except AssertionError:
            raise AssertionError(f"Mailpit 沒有收齊 3 類告警：{[m['Subject'] for m in mails()]}")
        # 告警持續中，再等超過 group_interval（1 分鐘）＋評估週期：同一告警不可重寄
        alerts = httpx.get(f"{ALERTMANAGER}/api/v2/alerts", timeout=10).json()
        assert set(expected) <= {a["labels"]["alertname"] for a in alerts}
        # 3 類事件各走自己的發送規則（Alertmanager 依 category 分 3 條路由）
        categories = {a["labels"]["alertname"]: a["labels"].get("category") for a in alerts
                      if a["labels"]["alertname"] in expected}
        assert categories == {"PlatformJobFailed": "job-failure", "HighPodCpu": "resource", "NodeNotReady": "node"}
        time.sleep(90)
        counts = {a: len(mails_about(a, m)) for a, m in expected.items()}
        assert counts == {a: 1 for a in expected}, counts
    finally:
        subprocess.run(["docker", "unpause", shared_node], check=False)
        kube.core.delete_namespaced_pod(burner, "platform-web", grace_period_seconds=0)
        wait_for(lambda: any(c.type == "Ready" and c.status == "True"
                             for c in kube.core.read_node(shared_node).status.conditions),
                 timeout=180, interval=3, message="暫停的節點沒有恢復")
        clear_jobs(kube)
        wait_for(lambda: not node_alert_active(shared_node), timeout=240, interval=5, message="節點告警沒有解除")
