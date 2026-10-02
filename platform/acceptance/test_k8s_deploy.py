"""平台部署在 Kubernetes（platform/deploy/k8s）時的檢查：TC-SS-05 的叢集版本、ServiceAccount 與 RBAC、對外連接埠。

需要 K8S_NAMESPACE（例：ai-platform）與 kubectl；GATEWAY_URL、KEYCLOAK_URL 指向叢集內的 Gateway 與 Keycloak。
    cd platform/acceptance && K8S_NAMESPACE=ai-platform GATEWAY_URL=http://localhost:38980 \\
      KEYCLOAK_URL=http://localhost:38180 uv run pytest -q test_k8s_deploy.py
"""
import json
import time

import pytest

import platform_exec as pe

pytestmark = pytest.mark.skipif(not pe.K8S_NAMESPACE, reason="設定 K8S_NAMESPACE 才檢查 Kubernetes 部署")
NS = pe.K8S_NAMESPACE
SA = f"system:serviceaccount:{NS}:platform-api"
# TC-SS-05：平台 API、推論服務、HAPI FHIR、Orthanc，另加資料庫、物件儲存、MLflow、Wiki.js、掃毒
INTERNAL = {"api": 8000, "inference": 8000, "hapi": 8080, "orthanc": 8042, "postgres": 5432, "minio": 9000,
            "mlflow": 5000, "wiki": 3000, "clamav": 3310}
ATTEMPTS = 10


def probe_script(targets: list[tuple[str, str, int]]) -> str:
    """每個目標連 ATTEMPTS 次（nc -z，逾時 2 秒），每行印「名稱 成功次數」。"""
    lines = []
    for name, host, port in targets:   # 各目標同時進行（被擋的連線要等逾時）
        lines.append(f'(ok=0; for i in $(seq {ATTEMPTS}); do nc -z -w 2 {host} {port} 2>/dev/null && ok=$((ok+1)); '
                     f'done; echo "{name} $ok") &')
    return "\n".join(lines + ["wait"])


def run_probe(namespace: str, script: str, labels: dict[str, str] | None = None) -> dict[str, int]:
    import subprocess

    overrides = json.dumps({"spec": {"nodeSelector": {"platform/pool": "cpu-web"},
                                     "automountServiceAccountToken": False}})
    cmd = ["kubectl", "-n", namespace, "run", f"ss05-{int(time.time() * 1000) % 10**9}", "--rm", "-i",
           "--restart=Never", "--quiet", "--image=busybox:1.36", "--image-pull-policy=IfNotPresent",
           f"--overrides={overrides}"]
    if labels:
        cmd.append("--labels=" + ",".join(f"{k}={v}" for k, v in labels.items()))
    out = subprocess.run(cmd + ["--", "sh", "-c", script], capture_output=True, text=True, timeout=900)
    result = {}
    for line in out.stdout.splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[1].isdigit():
            result[parts[0]] = int(parts[1])
    assert result, out.stdout + out.stderr
    return result


@pytest.fixture(scope="module")
def targets() -> list[tuple[str, str, int]]:
    """每個內部服務：Service 名稱與第一份 Pod 的 IP（直接連 Pod，不經 Service）。"""
    rows = []
    for service, port in INTERNAL.items():
        rows.append((f"{service}-svc", f"{service}.{NS}.svc.cluster.local", port))
        addresses = pe.pod_addresses(service)
        assert addresses, f"{service} 沒有執行中的 Pod"
        rows.append((f"{service}-pod", addresses[0], port))
    return rows


def test_tc_ss_05_internal_services_unreachable_from_other_namespaces(targets):
    seen = run_probe("default", probe_script(targets))
    assert set(seen) == {name for name, _, _ in targets}
    assert {name: count for name, count in seen.items() if count} == {}, "命名空間外連得到內部服務"


def test_tc_ss_05_control_backend_pods_can_reach_them(targets):
    """對照組：同一命名空間、NetworkPolicy 允許的平台後端連得到，代表位址與連接埠沒有寫錯。"""
    seen = run_probe(NS, probe_script(targets), labels={"platform/backend": "true", "platform/db-client": "true"})
    assert all(count == ATTEMPTS for count in seen.values()), seen


def test_tc_ss_05_unlabelled_pod_in_namespace_is_blocked_too(targets):
    """同一命名空間內、沒有平台後端標籤的 Pod 也連不到（預設拒絕）。"""
    picked = [t for t in targets if t[0] in ("api-svc", "postgres-svc", "orthanc-pod", "inference-svc")]
    seen = run_probe(NS, probe_script(picked))
    assert {name: count for name, count in seen.items() if count} == {}


def test_only_gateway_and_keycloak_have_node_ports():
    services = json.loads(pe.kubectl("get", "service", "-o", "json").stdout)["items"]
    exposed = sorted((s["spec"].get("selector") or {}).get("app") for s in services
                     if s["spec"].get("type") in ("NodePort", "LoadBalancer"))
    # kind overlay 另有模擬 PACS（驗收放入研究）與 Mailpit（告警信），甲方沒有這兩個服務
    assert set(exposed) <= {"apisix", "keycloak", "orthanc-pacs", "mailpit"}
    assert {"apisix", "keycloak"} <= set(exposed)


def test_api_uses_in_cluster_service_account():
    assert pe.env_of("api", "KUBECONFIG") == ""
    assert pe.env_of("api", "JOB_BACKEND") == "kubernetes"
    token = pe.exec_in("api", "cat", "/var/run/secrets/kubernetes.io/serviceaccount/namespace").stdout.strip()
    assert token == NS
    spec = json.loads(pe.kubectl("get", "deployment", "api", "-o", "json").stdout)["spec"]["template"]["spec"]
    assert spec["serviceAccountName"] == "platform-api"


@pytest.mark.parametrize("verb,resource,namespace,allowed", [
    ("create", "jobs.batch", "platform-jobs", True),
    ("delete", "jobs.batch", "platform-jobs", True),
    ("list", "pods", "platform-jobs", True),
    ("list", "nodes", None, True),
    ("patch", "clusterqueues.kueue.x-k8s.io/gpu-shared", None, True),
    ("patch", "clusterqueues.kueue.x-k8s.io/gpu-exclusive", None, False),
    ("create", "jobs.batch", "default", False),
    ("create", "jobs.batch", "ai-platform", False),
    ("get", "secrets", "ai-platform", False),
    ("get", "secrets", "platform-jobs", False),
    ("create", "pods", "platform-jobs", False),
    ("delete", "nodes", None, False),
    ("patch", "deployments.apps", "ai-platform", False),
])
def test_api_rbac_is_least_privilege(verb, resource, namespace, allowed):
    import subprocess

    cmd = ["kubectl", "auth", "can-i", verb, resource, f"--as={SA}"]
    cmd += ["-n", namespace] if namespace else []
    out = subprocess.run(cmd, capture_output=True, text=True)
    assert out.stdout.strip() == ("yes" if allowed else "no"), (cmd, out.stdout, out.stderr)


def test_api_submits_a_job_with_its_service_account(api, auth):
    admin = auth("admin01")
    projects = {p["name"]: p["id"] for p in api.get("/api/admin/projects", headers=admin).json()}
    pid = projects["P2-tabular"]
    created = api.post(f"/api/projects/{pid}/jobs", headers=admin,
                       json={"kind": "data-cleaning", "duration_seconds": 2, "memory_mb": 16})
    assert created.status_code == 201, created.text
    job = created.json()
    try:
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            job = api.get(f"/api/projects/{pid}/jobs/{job['id']}", headers=admin).json()
            if job["status"] in ("succeeded", "failed", "cancelled"):
                break
            time.sleep(2)
        assert job["status"] == "succeeded", job
        k8s = json.loads(pe.kubectl("get", "job", job["k8s_name"], "-n", "platform-jobs", "-o", "json").stdout)
        assert k8s["metadata"]["labels"]["platform/project-id"] == str(pid)
    finally:
        pe.kubectl("delete", "job", job["k8s_name"], "-n", "platform-jobs", "--ignore-not-found", check=False)


def test_issuer_matches_keycloak_hostname(auth):
    import base64

    token = auth("admin01")["Authorization"].split()[1]
    payload = json.loads(base64.urlsafe_b64decode(token.split(".")[1] + "=="))
    configmaps = json.loads(pe.kubectl("get", "configmap", "-o", "json").stdout)["items"]
    [urls] = [c for c in configmaps if c["metadata"]["name"].startswith("platform-urls")]
    assert payload["iss"] == urls["data"]["KC_HOSTNAME"] + "/realms/ai-platform"
    assert pe.env_of("api", "OIDC_ISSUER") == payload["iss"]
