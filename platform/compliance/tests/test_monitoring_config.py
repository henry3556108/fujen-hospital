"""監控設定的靜態檢查（TC-C02-01、TC-C02-04）：平台 manifest、覆蓋政策、kind 的 Prometheus 設定三者一致。

抓取宣告只寫在平台 manifest（Pod 註記 prometheus.io/*）；Prometheus 以一個通用的註記探索工作抓取；
其餘服務必須列在 policy/monitoring.yaml 的 container_metrics_only。這裡確保新增服務時不會漏掉其中一邊。
"""
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

from compliance.monitoring_coverage import Policy

PLATFORM = Path(__file__).resolve().parents[2]
K8S = PLATFORM / "deploy/k8s"
MONITORING = PLATFORM / "deploy/kind/monitoring"
NAMESPACE = "ai-platform"
SCRAPE = "prometheus.io/scrape"


def build(overlay: str) -> list[dict]:
    out = subprocess.run(["kubectl", "kustomize", str(K8S / "overlays" / overlay)], check=True, capture_output=True,
                         text=True).stdout
    return [d for d in yaml.safe_load_all(out) if d]


@pytest.fixture(scope="module", params=["kind", "production"])
def rendered(request):
    if shutil.which("kubectl") is None:
        pytest.skip("需要 kubectl")
    return request.param, build(request.param)


def services(docs: list[dict]) -> list[dict]:
    return [d for d in docs if d["kind"] in ("Deployment", "StatefulSet")]


def annotations(doc: dict) -> dict:
    return doc["spec"]["template"]["metadata"].get("annotations") or {}


def prometheus_config() -> dict:
    docs = list(yaml.safe_load_all((MONITORING / "prometheus.yaml").read_text(encoding="utf-8")))
    [cm] = [d for d in docs if d and d["kind"] == "ConfigMap" and d["metadata"]["name"] == "prometheus-config"]
    return cm["data"]


def test_every_platform_service_is_scraped_or_covered_by_container_metrics(rendered):
    _, docs = rendered
    policy = Policy.load()
    for d in services(docs):
        key = f"{NAMESPACE}/{d['metadata']['name']}"
        scraped = annotations(d).get(SCRAPE) == "true"
        assert scraped != (key in policy.container_only), \
            f"{key}：要嘛在 Pod 註記 {SCRAPE}，要嘛列在 container_metrics_only（只能其一）"
        if scraped:
            # Prometheus 的 job 取 Pod 的 app 標籤；覆蓋檢查以服務名稱比對
            assert d["spec"]["template"]["metadata"]["labels"]["app"] == d["metadata"]["name"], key


def test_scraped_ports_exist_and_are_open_to_the_monitoring_namespace(rendered):
    _, docs = rendered
    policies = [d for d in docs if d["kind"] == "NetworkPolicy"]
    scraped = [d for d in services(docs) if annotations(d).get(SCRAPE) == "true"]
    assert scraped, "平台至少要有一個服務提供 /metrics（平台 API）"
    for d in scraped:
        app = d["spec"]["template"]["metadata"]["labels"]["app"]
        port = int(annotations(d)["prometheus.io/port"])
        assert annotations(d)["prometheus.io/path"].startswith("/"), app
        ports = {p["containerPort"] for c in d["spec"]["template"]["spec"]["containers"] for p in c.get("ports", [])}
        assert port in ports, (app, port, ports)
        allowed = [p for p in policies
                   if p["spec"]["podSelector"].get("matchLabels", {}).get("app") == app
                   for rule in p["spec"].get("ingress", [])
                   if any(f.get("namespaceSelector", {}).get("matchLabels", {}).get("kubernetes.io/metadata.name")
                          == "monitoring" for f in rule.get("from", []))
                   and any(rp.get("port") == port for rp in rule.get("ports", []))]
        assert allowed, f"{app}：網路政策沒有讓 monitoring 命名空間連到 {port}"


def test_platform_api_minio_keycloak_and_gateway_are_scraped(rendered):
    _, docs = rendered
    scraped = sorted(d["metadata"]["name"] for d in services(docs) if annotations(d).get(SCRAPE) == "true")
    assert scraped == ["api", "apisix", "keycloak", "minio"]


def test_policy_names_only_services_that_exist():
    if shutil.which("kubectl") is None:
        pytest.skip("需要 kubectl")
    deployed = {f"{NAMESPACE}/{d['metadata']['name']}" for d in services(build("kind"))}
    for path in [*MONITORING.glob("*.yaml"), *(PLATFORM / "deploy/kind/workloads").glob("*.yaml")]:
        for d in yaml.safe_load_all(path.read_text(encoding="utf-8")):
            if d and d["kind"] in ("Deployment", "StatefulSet", "DaemonSet"):
                deployed.add(f"{d['metadata']['namespace']}/{d['metadata']['name']}")
    stale = sorted(Policy.load().container_only - deployed)
    assert stale == [], f"政策列了不存在的服務：{stale}"


def test_kind_prometheus_discovers_annotated_platform_pods():
    config = yaml.safe_load(prometheus_config()["prometheus.yml"])
    [job] = [j for j in config["scrape_configs"] if j["job_name"] == "ai-platform-pods"]
    [sd] = job["kubernetes_sd_configs"]
    assert sd["role"] == "pod" and sd["namespaces"]["names"] == [NAMESPACE]
    relabel = job["relabel_configs"]
    keep = [r for r in relabel if r.get("action") == "keep"]
    assert any(r["source_labels"] == ["__meta_kubernetes_pod_annotation_prometheus_io_scrape"] and r["regex"] == "true"
               for r in keep)
    # job 標籤＝Pod 的 app 標籤（與 Deployment／StatefulSet 同名）
    assert any(r.get("source_labels") == ["__meta_kubernetes_pod_label_app"] and r.get("target_label") == "job"
               for r in relabel)
    for label in ("__metrics_path__", "__address__"):
        assert any(r.get("target_label") == label for r in relabel), label
