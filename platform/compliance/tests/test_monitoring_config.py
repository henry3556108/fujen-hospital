"""監控設定的靜態檢查（TC-C02-01、TC-C02-04）：平台 manifest、覆蓋政策、kind 的 Prometheus 設定三者一致。

抓取宣告只寫在平台 manifest（Pod 註記 prometheus.io/*）；Prometheus 以一個通用的註記探索工作抓取；
其餘服務必須列在 policy/monitoring.yaml 的 container_metrics_only。這裡確保新增服務時不會漏掉其中一邊。
"""
import os
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
    # kind 與 production 都算（ollama 只在 production）
    deployed = {f"{NAMESPACE}/{d['metadata']['name']}" for o in ("kind", "production") for d in services(build(o))}
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


# --- 告警規則與路由（TC-C02-04）：以 Prometheus／Alertmanager 映像內的 promtool、amtool 驗證 ---
PROMETHEUS_IMAGE = "quay.io/prometheus/prometheus:v3.15.0"
ALERTMANAGER_IMAGE = "quay.io/prometheus/alertmanager:v0.34.1"


def run_tool(tool: str, image: str, workdir: Path, *args: str) -> subprocess.CompletedProcess:
    """本機有工具就直接執行，否則用與叢集相同版本的映像（docker）；都沒有就略過。"""
    if shutil.which(tool):
        return subprocess.run([tool, *args], cwd=workdir, capture_output=True, text=True, timeout=120)
    if shutil.which("docker") is None:
        pytest.skip(f"需要 {tool} 或 docker")
    probe = subprocess.run(["docker", "image", "inspect", image], capture_output=True)
    if probe.returncode != 0:
        pytest.skip(f"需要 {tool} 或本機已有映像 {image}")
    return subprocess.run(["docker", "run", "--rm", "--user", f"{os.getuid()}", "-v", f"{workdir}:/w", "-w", "/w",
                           "--entrypoint", tool, image, *args], capture_output=True, text=True, timeout=120)


def promtool_rules(tmp_path: Path, tests: list[dict]) -> subprocess.CompletedProcess:
    (tmp_path / "rules.yml").write_text(prometheus_config()["rules.yml"], encoding="utf-8")
    spec = {"rule_files": ["rules.yml"], "evaluation_interval": "10s", "tests": tests}
    (tmp_path / "test.yml").write_text(yaml.safe_dump(spec, allow_unicode=True), encoding="utf-8")
    return run_tool("promtool", PROMETHEUS_IMAGE, tmp_path, "test", "rules", "test.yml")


FAILED = 'kube_job_status_failed{namespace="platform-jobs",job_name="%s",reason="BackoffLimitExceeded"}'


def job_failed_alert(job: str) -> dict:
    return {"exp_labels": {"alertname": "PlatformJobFailed", "severity": "warning", "category": "job-failure",
                           "namespace": "platform-jobs", "job_name": job, "reason": "BackoffLimitExceeded"},
            "exp_annotations": {"summary": f"平台工作 {job} 失敗"}}


def test_platform_job_failed_fires_once_per_failure_and_ignores_old_failures(tmp_path):
    # 時間軸（30 秒一點）：job-old 從一開始就是失敗（舊的、TTL 未到）；job-new 在第 20 分鐘才出現失敗序列
    # （kube-state-metrics 的 reason 序列在失敗時才出現）；job-flip 同一序列 0→1（舊版 kube-state-metrics 的寫法）
    tests = [{
        "interval": "30s",
        "input_series": [
            {"series": FAILED % "job-old", "values": "1x120"},
            {"series": FAILED % "job-new", "values": "_x40 1x80"},
            {"series": 'kube_job_status_failed{namespace="platform-jobs",job_name="job-flip"}', "values": "0x40 1x80"},
        ],
        "alert_rule_test": [
            {"eval_time": "21m", "alertname": "PlatformJobFailed",
             "exp_alerts": [job_failed_alert("job-new"),
                            {"exp_labels": {"alertname": "PlatformJobFailed", "severity": "warning",
                                            "category": "job-failure", "namespace": "platform-jobs", "job_name": "job-flip"},
                             "exp_annotations": {"summary": "平台工作 job-flip 失敗"}}]},
            # 15 分鐘後自動解除：Alertmanager 只寄過一次（不寄已解除），不會每 4 小時重寄
            {"eval_time": "36m", "alertname": "PlatformJobFailed", "exp_alerts": []},
            {"eval_time": "59m", "alertname": "PlatformJobFailed", "exp_alerts": []},
        ],
    }]
    result = promtool_rules(tmp_path, tests)
    assert result.returncode == 0, result.stdout + result.stderr


# 合約：「定義告警事件分類 3 類、告警發送規則 3 條並各觸發測試 1 次」。一類事件一條發送路由（Alertmanager route），
# 由告警規則的 category 標籤對應；每條路由寄到維運信箱，各自設定分組與重寄間隔。
CATEGORIES = {"PlatformJobFailed": "job-failure", "HighPodCpu": "resource", "NodeNotReady": "node"}


def alertmanager_config() -> dict:
    docs = list(yaml.safe_load_all((MONITORING / "alertmanager.yaml").read_text(encoding="utf-8")))
    [cm] = [d for d in docs if d and d["kind"] == "ConfigMap" and d["metadata"]["name"] == "alertmanager-config"]
    return yaml.safe_load(cm["data"]["alertmanager.yml"])


def test_three_alert_rules_in_three_categories():
    rules = [r for g in yaml.safe_load(prometheus_config()["rules.yml"])["groups"] for r in g["rules"]]
    assert {r["alert"]: r["labels"].get("category") for r in rules} == CATEGORIES


def test_three_mail_routes_one_per_category():
    config = alertmanager_config()
    routes = config["route"]["routes"]
    assert [r["matchers"] for r in routes] == [[f"category = {c}"] for c in CATEGORIES.values()]
    mail = {r["name"] for r in config["receivers"] if r.get("email_configs")}
    for r in routes:
        assert r["receiver"] in mail
        assert r.get("continue", False) is False   # 一則告警只走一條路由，只寄一封
        for key in ("group_by", "group_wait", "group_interval", "repeat_interval"):
            assert key in r, (r["matchers"], key)


def test_amtool_routes_each_category_to_its_own_route(tmp_path):
    (tmp_path / "alertmanager.yml").write_text(yaml.safe_dump(alertmanager_config(), allow_unicode=True),
                                               encoding="utf-8")
    check = run_tool("amtool", ALERTMANAGER_IMAGE, tmp_path, "check-config", "alertmanager.yml")
    assert check.returncode == 0, check.stdout + check.stderr
    for alert, category in CATEGORIES.items():
        result = run_tool("amtool", ALERTMANAGER_IMAGE, tmp_path, "config", "routes", "test",
                          "--config.file=alertmanager.yml", "--tree", f"alertname={alert}", f"category={category}")
        assert result.returncode == 0, result.stdout + result.stderr
        assert f'{{category="{category}"}}' in result.stdout, result.stdout
