"""platform/deploy/k8s 的靜態檢查：兩個 overlay 都能產生、設定與 compose 同步、ConfigMap 不含密碼、
所有平台 Pod 在 cpu-web 且有資源限制與探針、每個服務都有 NetworkPolicy、對外只有 Gateway 與 Keycloak、
映像清單與 compose 一致、production 沒有開發用的東西。需要 kubectl（內建 kustomize）；沒有就略過。"""
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

from compliance.discover import parse_image

PLATFORM = Path(__file__).resolve().parents[2]
K8S = PLATFORM / "deploy/k8s"
LOCAL = PLATFORM / "deploy/local"
NEEDS_KUBECTL = pytest.mark.skipif(shutil.which("kubectl") is None, reason="需要 kubectl")
# create-secrets.sh --dev 的值（與 compose 相同）：不可出現在任何 ConfigMap
DEV_SECRETS = ["platform-dev", "kcadmin-dev", "api-secret-dev", "Admin01-dev!", "orthanc-api-dev", "orthanc-gw-dev",
               "Z2F0ZXdheTpvcnRoYW5jLWd3LWRldg==", "pacs-dev", "minio-dev-secret", "platform-api-dev-secret",
               "inference-admin-dev", "wiki-svc-dev"]
WORKLOADS = ("Deployment", "StatefulSet", "CronJob")


def build(overlay: str) -> list[dict]:
    out = subprocess.run(["kubectl", "kustomize", str(K8S / "overlays" / overlay)], check=True, capture_output=True,
                         text=True).stdout
    return [d for d in yaml.safe_load_all(out) if d]


def pod_spec(doc: dict) -> dict:
    spec = doc["spec"]
    if doc["kind"] == "CronJob":
        spec = spec["jobTemplate"]["spec"]
    return spec["template"]["spec"]


def pod_labels(doc: dict) -> dict:
    spec = doc["spec"]["jobTemplate"]["spec"] if doc["kind"] == "CronJob" else doc["spec"]
    return spec["template"]["metadata"]["labels"]


@pytest.fixture(scope="module", params=["kind", "production"])
def rendered(request):
    if shutil.which("kubectl") is None:
        pytest.skip("需要 kubectl")
    return request.param, build(request.param)


def test_config_is_in_sync_with_compose_sources():
    result = subprocess.run([sys.executable, str(K8S / "render-config.py"), "--check"], capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr


def test_every_resource_is_in_the_platform_namespace(rendered):
    _, docs = rendered
    cluster_scoped = {"Namespace", "ClusterRole", "ClusterRoleBinding"}
    for d in docs:
        if d["kind"] in cluster_scoped:
            continue
        expected = "platform-jobs" if d["kind"] in ("Role", "RoleBinding") else "ai-platform"
        assert d["metadata"].get("namespace") == expected, (d["kind"], d["metadata"]["name"])


def test_configmaps_hold_no_secrets(rendered):
    _, docs = rendered
    for d in docs:
        if d["kind"] != "ConfigMap":
            continue
        text = yaml.safe_dump(d.get("data", {}), allow_unicode=True)
        leaked = [s for s in DEV_SECRETS if s in text]
        assert leaked == [], (d["metadata"]["name"], leaked)


def test_secret_values_only_come_from_the_platform_secret(rendered):
    _, docs = rendered
    assert not [d for d in docs if d["kind"] == "Secret"], "Secret 不進版控，由 create-secrets.sh 建立"
    for d in docs:
        if d["kind"] not in WORKLOADS:
            continue
        for c in pod_spec(d)["containers"]:
            for e in c.get("env", []):
                value = str(e.get("value", ""))
                assert not any(s in value for s in DEV_SECRETS), (d["metadata"]["name"], e["name"])


def test_platform_pods_run_on_cpu_web_with_limits(rendered):
    _, docs = rendered
    for d in docs:
        if d["kind"] not in WORKLOADS:
            continue
        spec = pod_spec(d)
        name = d["metadata"]["name"]
        assert spec.get("nodeSelector") == {"platform/pool": "cpu-web"}, name
        assert spec.get("enableServiceLinks") is False, name   # 服務連結的環境變數會蓋掉 MLFLOW_PORT 之類的設定
        for c in spec["containers"]:
            limits = c.get("resources", {}).get("limits", {})
            assert "memory" in limits and "cpu" in limits, (name, c["name"])
            # 監控的 HighPodCpu 告警門檻是 0.8 核：平台 Pod 的 CPU 上限不超過它
            cpu = limits["cpu"]
            assert (int(cpu[:-1]) / 1000 if cpu.endswith("m") else float(cpu)) <= 0.8, (name, cpu)


def test_long_running_services_have_probes(rendered):
    _, docs = rendered
    for d in docs:
        if d["kind"] not in ("Deployment", "StatefulSet") or d["metadata"]["name"] == "fhir-worker":
            continue
        for c in pod_spec(d)["containers"]:
            assert "readinessProbe" in c and "livenessProbe" in c, d["metadata"]["name"]


def test_only_the_api_and_its_jobs_get_a_service_account_token(rendered):
    _, docs = rendered
    for d in docs:
        if d["kind"] not in WORKLOADS:
            continue
        spec = pod_spec(d)
        if spec.get("serviceAccountName") == "platform-api":
            assert d["metadata"]["name"] in ("api", "seed", "bootstrap-admin"), d["metadata"]["name"]
        else:
            assert spec.get("automountServiceAccountToken") is False, d["metadata"]["name"]


def test_every_service_has_an_ingress_allow_list(rendered):
    _, docs = rendered
    policies = [d for d in docs if d["kind"] == "NetworkPolicy"]
    assert any(p["metadata"]["name"] == "default-deny-ingress" and p["spec"]["podSelector"] == {} for p in policies)

    def selects(policy: dict, app: str) -> bool:
        sel = policy["spec"]["podSelector"]
        if sel.get("matchLabels", {}).get("app") == app:
            return True
        return any(e["key"] == "app" and e["operator"] == "In" and app in e["values"]
                   for e in sel.get("matchExpressions", []))

    apps = {d["spec"]["selector"]["app"] for d in docs if d["kind"] == "Service"}
    missing = [a for a in sorted(apps) if not any(selects(p, a) and p["spec"].get("ingress") for p in policies)]
    assert missing == []
    open_to_all = sorted({p["spec"]["podSelector"].get("matchLabels", {}).get("app") for p in policies
                          for rule in p["spec"].get("ingress", []) if "from" not in rule})
    overlay = rendered[0]
    assert open_to_all == (["apisix", "keycloak", "mailpit", "orthanc-pacs"] if overlay == "kind" else ["apisix", "keycloak"])


def test_only_gateway_and_keycloak_are_exposed(rendered):
    overlay, docs = rendered
    exposed = sorted(d["spec"]["selector"]["app"] for d in docs
                     if d["kind"] == "Service" and d["spec"].get("type") in ("NodePort", "LoadBalancer"))
    if overlay == "kind":
        assert exposed == ["apisix", "keycloak", "mailpit", "orthanc-pacs"]   # 後兩個是開發與驗收用
    else:
        assert exposed == []
        backends = sorted(p["backend"]["service"]["name"] for d in docs if d["kind"] == "Ingress"
                          for r in d["spec"]["rules"] for p in r["http"]["paths"])
        assert backends == ["apisix", "apisix", "keycloak"]


def test_api_rbac_is_least_privilege(rendered):
    overlay, docs = rendered
    rules = [(d["kind"], d["metadata"]["name"], r) for d in docs if d["kind"] in ("Role", "ClusterRole")
             for r in d["rules"]]
    for _, _, r in rules:
        assert "*" not in r["verbs"] and "*" not in r["resources"]
        assert "secrets" not in r["resources"]
    resources = sorted(res for _, _, r in rules for res in r["resources"])
    expected = ["clusterqueues", "jobs", "nodes", "pods"] + (["nodes/status"] if overlay == "kind" else [])
    assert resources == sorted(expected)
    [cq] = [r for _, _, r in rules if r["resources"] == ["clusterqueues"]]
    assert cq["resourceNames"] == ["gpu-shared"] and sorted(cq["verbs"]) == ["get", "patch"]


def test_api_uses_in_cluster_config(rendered):
    _, docs = rendered
    [api] = [d for d in docs if d["kind"] == "Deployment" and d["metadata"]["name"] == "api"]
    env_names = {e["name"] for c in pod_spec(api)["containers"] for e in c.get("env", [])}
    [api_env] = [d for d in docs if d["kind"] == "ConfigMap" and d["metadata"]["name"].startswith("api-env")]
    assert "KUBECONFIG" not in env_names and "KUBECONFIG" not in api_env["data"]
    assert api_env["data"]["JOB_BACKEND"] == "kubernetes"
    issuer = next(e["value"] for e in pod_spec(api)["containers"][0]["env"] if e["name"] == "OIDC_ISSUER")
    assert issuer == "$(KC_HOSTNAME)/realms/ai-platform"


def test_production_has_no_development_parts():
    if shutil.which("kubectl") is None:
        pytest.skip("需要 kubectl")
    docs = build("production")
    names = {(d["kind"], d["metadata"]["name"]) for d in docs}
    for dev in ["fake-llm", "autolabel", "mailpit", "orthanc-pacs", "seed"]:
        assert not [n for n in names if n[1] == dev], dev
    images = [c["image"] for d in docs if d["kind"] in WORKLOADS for c in pod_spec(d)["containers"]]
    assert not [i for i in images if "fakes" in i or "mailpit" in i]
    [realm] = [d for d in docs if d["kind"] == "ConfigMap" and d["metadata"]["name"].startswith("keycloak-realm")]
    clients = yaml.safe_load(realm["data"]["realm-ai-platform.json"])["clients"]
    assert all(not c.get("directAccessGrantsEnabled") for c in clients if c.get("publicClient"))
    [api_env] = [d for d in docs if d["kind"] == "ConfigMap" and d["metadata"]["name"].startswith("api-env")]
    assert "LLM_MODEL_SOURCE" not in api_env["data"]          # fake 模型來源只在 kind


def test_upstream_images_match_compose():
    """映像版本只改 components/images；compose 換了版本而這裡沒跟上（或反過來）就失敗。"""
    component = yaml.safe_load((K8S / "components/images/kustomization.yaml").read_text(encoding="utf-8"))
    k8s = {str(parse_image(e["newName"] + (f":{e['newTag']}" if e.get("newTag") else "")
                           + (f"@{e['digest']}" if e.get("digest") else "")))
           for e in component["images"] if not e["newName"].startswith("platform-")}
    compose = set()
    for path in LOCAL.glob("compose*.yaml"):
        for svc in (yaml.safe_load(path.read_text(encoding="utf-8")).get("services") or {}).values():
            if "image" in svc and not str(svc["image"]).startswith("platform-"):
                compose.add(str(parse_image(svc["image"])))
    # compose 的 postgres:16-alpine 只用在沒有 LLM 疊加檔時與 fhir-db-init；叢集一律用 pgvector（含 LLM）
    assert k8s == compose - {"docker.io/library/postgres:16-alpine"}
