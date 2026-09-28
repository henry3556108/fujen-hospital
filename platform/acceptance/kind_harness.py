"""WP4 叢集測試共用工具：偵測 kind 叢集、在同一個程序裡啟動平台 API（接 Kubernetes 後端）、輪詢。

執行方式（在 platform/api 下，用平台 API 的虛擬環境）：
    uv run pytest ../acceptance/test_tc_a02_gpu.py ../acceptance/test_tc_c01.py ../acceptance/test_tc_c02.py -m kind
叢集不存在時這些測試會自動略過。compose 堆疊的 API 目前沒有接叢集，所以這裡直接在程序內組裝平台 API。
"""
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1] / "api"
KIND_DIR = Path(__file__).resolve().parents[1] / "deploy" / "kind"
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

CONTEXT = "kind-ai-platform"
NAMESPACE = "platform-jobs"
PROMETHEUS = "http://127.0.0.1:39090"
ALERTMANAGER = "http://127.0.0.1:39093"
GRAFANA = "http://127.0.0.1:33000"
MAILPIT = "http://127.0.0.1:38025"
GRAFANA_AUTH = ("admin", "Grafana-dev-01!")  # 與 deploy/kind/monitoring/grafana.yaml 的開發用值相同

_clients = None


@dataclass
class Kube:
    core: object
    batch: object
    custom: object
    apps: object
    api_client: object


def kube_or_skip() -> Kube:
    global _clients
    if _clients is None:
        try:
            from kubernetes import client, config

            api_client = config.new_client_from_config(context=CONTEXT)
            core = client.CoreV1Api(api_client)
            core.list_node(_request_timeout=5)
            _clients = Kube(core=core, batch=client.BatchV1Api(api_client),
                            custom=client.CustomObjectsApi(api_client), apps=client.AppsV1Api(api_client),
                            api_client=api_client)
        except Exception as exc:  # noqa: BLE001 — 任何連不上的原因都是「叢集不在」
            _clients = exc
    if isinstance(_clients, Exception):
        pytest.skip(f"kind 叢集 ai-platform 不存在或連不上：{_clients}")
    return _clients


def wait_for(predicate, *, timeout: float, interval: float = 1.0, message: str = "等待逾時"):
    deadline = time.monotonic() + timeout
    while True:
        value = predicate()
        if value:
            return value
        if time.monotonic() > deadline:
            raise AssertionError(message)
        time.sleep(interval)


def clear_jobs(kube: Kube) -> None:
    """清掉上一個案例留下的工作，避免佔住佇列。"""
    kube.batch.delete_collection_namespaced_job(NAMESPACE, propagation_policy="Background")
    wait_for(lambda: not kube.core.list_namespaced_pod(NAMESPACE).items and
             not kube.custom.list_namespaced_custom_object("kueue.x-k8s.io", "v1beta2", NAMESPACE,
                                                           "workloads")["items"],
             timeout=90, message="舊工作沒有清乾淨")


def kubectl(*args: str, timeout: float = 60) -> str:
    return subprocess.run(["kubectl", "--context", CONTEXT, *args], check=True, capture_output=True, text=True,
                          timeout=timeout).stdout


@dataclass
class Platform:
    client: object
    app: object
    headers: dict = field(default_factory=dict)
    projects: dict = field(default_factory=dict)

    def as_(self, username: str) -> dict:
        return self.headers[username]

    def submit(self, project: str, username: str, **body) -> dict:
        response = self.client.post(f"/api/projects/{self.projects[project]}/jobs", headers=self.as_(username),
                                    json={"kind": "training", **body})
        assert response.status_code == 201, response.text
        return response.json()

    def job(self, job: dict, username: str) -> dict:
        response = self.client.get(f"/api/projects/{job['project_id']}/jobs/{job['id']}", headers=self.as_(username))
        assert response.status_code == 200, response.text
        return response.json()


def build_platform(db_path: Path, kube: Kube) -> Platform:
    import jwt
    from cryptography.hazmat.primitives.asymmetric import rsa
    from fastapi.testclient import TestClient

    from app.identity import JwtVerifier
    from app.main import create_app
    from app.models import Membership, Project, User
    from app.permissions import DEFAULT_ROLE_PERMISSIONS, AccountType, Role
    from app.scheduling.kube import KubernetesJobBackend

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    issuer, audience = "http://kind-harness/realms/ai-platform", "ai-platform"
    app = create_app(database_url=f"sqlite:///{db_path}",
                     verifier=JwtVerifier(issuer=issuer, audience=audience, key_resolver=lambda t: key.public_key()))
    app.state.job_backend = KubernetesJobBackend(core=kube.core, batch=kube.batch, custom=kube.custom,
                                                 namespace=NAMESPACE, image="busybox:1.36")
    platform = Platform(client=TestClient(app), app=app)

    def token(username):
        now = int(time.time())
        return jwt.encode({"sub": f"sub-{username}", "preferred_username": username, "iss": issuer,
                           "aud": audience, "iat": now, "exp": now + 3600, "typ": "Bearer"}, key, algorithm="RS256")

    with app.state.sessionmaker() as s:
        s.add(User(username="admin01", account_type=AccountType.ADMIN.value, idp_subject="sub-admin01"))
        for name, group in [("P1-lung-ct", "gpu-exclusive"), ("P2-tabular", "gpu-shared")]:
            s.add(Project(name=name, gpu_group=group))
        s.flush()
        projects = {p.name: p.id for p in s.query(Project)}
        members = [("P1-lung-ct", "ra01", Role.RESEARCH_ASSISTANT), ("P1-lung-ct", "pi01", Role.PRINCIPAL_INVESTIGATOR),
                   ("P2-tabular", "ca02", Role.CODER_ASSISTANT), ("P2-tabular", "pi02", Role.PRINCIPAL_INVESTIGATOR)]
        for project, username, role in members:
            user = User(username=username, account_type=AccountType.USER.value, idp_subject=f"sub-{username}")
            s.add(user)
            s.flush()
            s.add(Membership(user_id=user.id, project_id=projects[project], role=role.value,
                             permissions=sorted(p.value for p in DEFAULT_ROLE_PERMISSIONS[role])))
        s.commit()
    platform.projects = projects
    for username in ["admin01", "ra01", "pi01", "ca02", "pi02"]:
        platform.headers[username] = {"Authorization": f"Bearer {token(username)}"}
    return platform


def status_trace(platform: Platform, jobs: list[dict], username: str, *, timeout: float,
                 on_poll=None) -> list[list[str]]:
    """輪詢到全部結束，回傳每件工作觀察到的狀態序列（去掉連續重複）。"""
    traces = [[j["status"]] for j in jobs]
    deadline = time.monotonic() + timeout
    while True:
        current = [platform.job(j, username) for j in jobs]
        for trace, job in zip(traces, current):
            if trace[-1] != job["status"]:
                trace.append(job["status"])
        if on_poll:
            on_poll(current)
        if all(j["status"] in {"succeeded", "failed", "cancelled"} for j in current):
            return traces
        if time.monotonic() > deadline:
            raise AssertionError(f"工作沒有在 {timeout} 秒內結束：{traces}")
        time.sleep(0.5)


def workload_for(kube: Kube, job_name: str) -> dict | None:
    items = kube.custom.list_namespaced_custom_object("kueue.x-k8s.io", "v1beta2", NAMESPACE, "workloads")["items"]
    return next((w for w in items if any(o.get("name") == job_name for o in w["metadata"].get("ownerReferences", []))),
                None)


def pods_of(kube: Kube, job_name: str) -> list:
    return kube.core.list_namespaced_pod(NAMESPACE, label_selector=f"job-name={job_name}").items


def node_pool(kube: Kube, node_name: str) -> str | None:
    return (kube.core.read_node(node_name).metadata.labels or {}).get("platform/pool")
