"""TC-C01：多台 GPU／CPU 伺服器管理（kind 叢集、假 GPU）。"""
import subprocess
import time
from datetime import datetime

import pytest

from kind_harness import (KIND_DIR, build_platform, clear_jobs, kube_or_skip, kubectl, node_pool, pods_of,
                          status_trace, wait_for, workload_for)

pytestmark = pytest.mark.kind


@pytest.fixture
def kube():
    k = kube_or_skip()
    clear_jobs(k)
    yield k
    clear_jobs(k)


@pytest.fixture
def platform(kube, tmp_path):
    return build_platform(tmp_path / "platform.db", kube)


def api_nodes(platform) -> dict:
    response = platform.client.get("/api/admin/cluster/nodes", headers=platform.as_("admin01"))
    assert response.status_code == 200, response.text
    return {n["name"]: n for n in response.json()}


def test_tc_c01_01_node_list_matches_kubectl(platform):
    kubectl_nodes = {line.split("/", 1)[1] for line in kubectl("get", "nodes", "-o", "name").split()}
    nodes = api_nodes(platform)
    assert set(nodes) == kubectl_nodes
    for name in kubectl_nodes:
        pool = kubectl("get", "node", name, "-o", "jsonpath={.metadata.labels.platform/pool}") or None
        assert nodes[name]["pool"] == pool
    assert nodes["ai-platform-worker3"]["gpu_capacity"] == 2
    assert nodes["ai-platform-worker4"]["gpu_physical"] == 1


def test_tc_c01_02_gpu_groups_survive_reload(kube, tmp_path):
    db = tmp_path / "platform.db"
    first = build_platform(db, kube)
    admin = first.as_("admin01")
    for body in [{"name": "img-train", "pool": "gpu-exclusive", "gpu_count": 1, "mode": "exclusive"},
                 {"name": "tab-small", "pool": "gpu-shared", "gpu_count": 1, "mode": "shared"}]:
        assert first.client.post("/api/admin/gpu-groups", headers=admin, json=body).status_code == 201
    before = first.client.get("/api/admin/gpu-groups", headers=admin).json()
    # 重新載入 = 另一個平台 API 程序讀同一個資料庫
    from app.main import create_app
    reloaded = create_app(database_url=f"sqlite:///{db}", verifier=first.app.state.verifier)
    from fastapi.testclient import TestClient
    after = TestClient(reloaded).get("/api/admin/gpu-groups", headers=admin).json()
    assert after == before and {"img-train", "tab-small"} <= {g["name"] for g in after}


def test_tc_c01_03_project_binding_enters_group_queue(platform, kube):
    admin = platform.as_("admin01")
    stamp = time.time_ns()
    for i, group in enumerate(["gpu-exclusive", "gpu-shared", "gpu-exclusive"]):
        created = platform.client.post("/api/admin/projects", headers=admin,
                                       json={"name": f"c01-03-{stamp}-{i}", "gpu_group": group}).json()
        assert created["gpu_group"] == group
        job = platform.client.post(f"/api/projects/{created['id']}/jobs", headers=admin,
                                   json={"kind": "training", "duration_seconds": 2}).json()
        k8s_job = kube.batch.read_namespaced_job(job["k8s_name"], "platform-jobs")
        assert k8s_job.metadata.labels["kueue.x-k8s.io/queue-name"] == group
        assert k8s_job.metadata.labels["platform/project-id"] == str(created["id"])
        workload = wait_for(lambda: (w := workload_for(kube, job["k8s_name"])) and w.get("status", {}).get("admission") and w,
                            timeout=60, message="Kueue 沒有放行")
        assert workload["spec"]["queueName"] == group
        assert workload["status"]["admission"]["clusterQueue"] == group


def test_tc_c01_04_dashboard_matches_running_jobs(platform, kube):
    jobs = [platform.submit("P1-lung-ct", "ra01", duration_seconds=45),
            platform.submit("P2-tabular", "ca02", duration_seconds=45),
            platform.submit("P2-tabular", "pi02", duration_seconds=45)]
    users = ["ra01", "ca02", "pi02"]
    wait_for(lambda: all(platform.job(j, u)["status"] == "running" for j, u in zip(jobs, users)),
             timeout=180, message="3 件工作沒有同時進入執行")
    rows = platform.client.get("/api/admin/cluster/gpu-dashboard", headers=platform.as_("admin01")).json()
    actual = {r["job_id"]: (r["project_id"], r["training_id"], r["user"], r["node"]) for r in rows}
    for job in jobs:
        (pod,) = pods_of(kube, job["k8s_name"])
        expected = (job["project_id"], job["id"], job["user"], pod.spec.node_name)
        assert actual[job["id"]] == expected
    assert len(rows) == 3


def _finish_time(kube, name) -> datetime:
    job = kube.batch.read_namespaced_job(name, "platform-jobs")
    return job.status.completion_time or next(c.last_transition_time for c in job.status.conditions
                                              if c.type in ("Complete", "Failed") and c.status == "True")


def _start_time(kube, name) -> datetime:
    (pod,) = pods_of(kube, name)
    return pod.status.start_time


def test_tc_c01_05_exclusive_pool_fifo_no_loss(platform, kube):
    jobs = [platform.submit("P1-lung-ct", "ra01", duration_seconds=10) for _ in range(3)]
    traces = status_trace(platform, jobs, "ra01", timeout=240)
    assert traces == [["queued", "running", "succeeded"]] * 3, "有工作遺失或狀態錯誤"
    names = [j["k8s_name"] for j in jobs]
    starts = [_start_time(kube, n) for n in names]
    finishes = [_finish_time(kube, n) for n in names]
    # 前兩件各佔一張卡；第三件必須等到有卡空出來才開始
    assert starts[0] <= starts[1] <= starts[2]
    assert starts[2] >= min(finishes[0], finishes[1])


def test_tc_c01_06_web_and_data_cleaning_routing(platform, kube):
    for _ in range(5):
        response = kube.core.connect_get_namespaced_service_proxy_with_path("web-echo:80", "platform-web", path="",
                                                                            _preload_content=False)
        pod_name = response.data.decode().strip()
        pod = kube.core.read_namespaced_pod(pod_name, "platform-web")
        assert node_pool(kube, pod.spec.node_name) == "cpu-web"
    jobs = [platform.submit("P1-lung-ct", "ra01", kind="data-cleaning", duration_seconds=3) for _ in range(5)]
    assert {j["queue"] for j in jobs} == {"cpu-data"}
    traces = status_trace(platform, jobs, "ra01", timeout=240)
    assert all(t[-1] == "succeeded" for t in traces)
    for job in jobs:
        (pod,) = pods_of(kube, job["k8s_name"])
        assert node_pool(kube, pod.spec.node_name) == "cpu-data"


def test_tc_c01_07_new_node_appears_in_platform(platform, kube):
    name = "ai-platform-extra-1"
    try:
        subprocess.run([str(KIND_DIR / "add-node.sh"), name, "cpu-data"], check=True, timeout=420)
        node = wait_for(lambda: api_nodes(platform).get(name, {}).get("ready") and api_nodes(platform)[name],
                        timeout=180, interval=3, message="新節點沒有出現在平台清單或未就緒")
        assert node["pool"] == "cpu-data"
        assert node_pool(kube, name) == "cpu-data"
    finally:
        subprocess.run([str(KIND_DIR / "remove-node.sh"), name], check=False, timeout=120)
    assert name not in api_nodes(platform)


def test_tc_c01_08_cancel_and_failure_keep_queue_moving(platform, kube):
    long = platform.submit("P1-lung-ct", "ra01", duration_seconds=40)
    bad = platform.submit("P1-lung-ct", "ra01", duration_seconds=8, fail=True)
    cancel_me = platform.submit("P1-lung-ct", "ra01", duration_seconds=5)
    nxt = platform.submit("P1-lung-ct", "ra01", duration_seconds=5)
    wait_for(lambda: platform.job(bad, "ra01")["status"] == "running", timeout=180, message="前兩件沒有開始")
    assert platform.job(cancel_me, "ra01")["status"] == "queued"
    response = platform.client.post(f"/api/projects/{cancel_me['project_id']}/jobs/{cancel_me['id']}/cancel",
                                    headers=platform.as_("ra01"))
    assert response.status_code == 200 and response.json()["status"] == "cancelled"
    traces = status_trace(platform, [long, bad, cancel_me, nxt], "ra01", timeout=240)
    assert traces == [["queued", "running", "succeeded"], ["queued", "running", "failed"],
                      ["queued", "cancelled"], ["queued", "running", "succeeded"]]
    assert pods_of(kube, cancel_me["k8s_name"]) == []
    # 失敗的那件讓出卡後，下一件照順序接上（沒有等到長工作結束）
    assert _start_time(kube, nxt["k8s_name"]) >= _finish_time(kube, bad["k8s_name"])
    assert _start_time(kube, nxt["k8s_name"]) < _finish_time(kube, long["k8s_name"])
