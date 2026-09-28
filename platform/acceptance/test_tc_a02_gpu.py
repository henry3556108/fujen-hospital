"""TC-A02-05／06：GPU 獨占與共享模式（kind 叢集、假 GPU；數字需在甲方環境重跑）。"""
import pytest

from kind_harness import build_platform, clear_jobs, kube_or_skip, node_pool, pods_of, status_trace

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


def test_tc_a02_05_exclusive_single_job(platform, kube):
    job = platform.submit("P1-lung-ct", "ra01", duration_seconds=12)
    assert job["queue"] == "gpu-exclusive"
    card_checks = []

    def check_card(current):
        if current[0]["status"] != "running":
            return
        rows = platform.client.get("/api/admin/cluster/gpu-dashboard", headers=platform.as_("admin01")).json()
        if [p.status.phase for p in pods_of(kube, job["k8s_name"])] != ["Running"]:
            return  # 讀 Dashboard 的瞬間容器剛好結束，這一輪不算
        mine = [r for r in rows if r["job_id"] == job["id"]]
        assert len(mine) == 1
        same_card = [r for r in rows if (r["node"], r["gpu_index"]) == (mine[0]["node"], mine[0]["gpu_index"])]
        card_checks.append(same_card == mine)

    (trace,) = status_trace(platform, [job], "ra01", timeout=240, on_poll=check_card)
    assert trace == ["queued", "running", "succeeded"]
    assert card_checks and all(card_checks), "執行期間該卡出現其他工作"
    (pod,) = pods_of(kube, job["k8s_name"])
    assert node_pool(kube, pod.spec.node_name) == "gpu-exclusive"


def test_tc_a02_06_shared_three_jobs(platform, kube):
    jobs = [platform.submit("P2-tabular", "ca02", duration_seconds=15) for _ in range(3)]
    assert {j["queue"] for j in jobs} == {"gpu-shared"}
    max_parallel = []
    traces = status_trace(platform, jobs, "ca02", timeout=240,
                          on_poll=lambda cur: max_parallel.append(sum(j["status"] == "running" for j in cur)))
    assert traces == [["queued", "running", "succeeded"]] * 3
    assert max(max_parallel) >= 2, "共享卡上沒有同時執行"
    for job in jobs:
        (pod,) = pods_of(kube, job["k8s_name"])
        assert node_pool(kube, pod.spec.node_name) == "gpu-shared"
