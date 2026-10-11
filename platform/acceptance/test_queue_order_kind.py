"""後台調整佇列順序、暫存與恢復排隊：在 kind 叢集（Kueue StrictFIFO、假 GPU）上確認實際開始的先後。

    cd platform/api && uv run pytest -m kind ../acceptance/test_queue_order_kind.py
"""
import pytest

from kind_harness import NAMESPACE, build_platform, clear_jobs, kube_or_skip, pods_of, status_trace, wait_for

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


def exclusive_queue(platform) -> dict:
    response = platform.client.get("/api/admin/queues", headers=platform.as_("admin01"))
    assert response.status_code == 200, response.text
    return next(q for q in response.json() if q["queue"] == "gpu-exclusive")


def start_time(kube, name):
    (pod,) = pods_of(kube, name)
    return pod.status.start_time


def test_reorder_hold_and_resume_follow_the_new_order(platform, kube):
    # 獨占池 2 張卡：先用兩件長度不同的工作佔滿，之後每空出一張卡只放行排頭一件
    short = platform.submit("P1-lung-ct", "ra01", duration_seconds=40)
    long = platform.submit("P1-lung-ct", "ra01", duration_seconds=100)
    wait_for(lambda: all(platform.job(j, "ra01")["status"] == "running" for j in (short, long)),
             timeout=180, message="佔卡的兩件工作沒有開始")
    a, b, c = (platform.submit("P1-lung-ct", "ra01", duration_seconds=5) for _ in range(3))
    queue = exclusive_queue(platform)
    assert [j["id"] for j in queue["waiting"]] == [a["id"], b["id"], c["id"]]
    assert {j["id"] for j in queue["running"]} == {short["id"], long["id"]}

    admin = platform.as_("admin01")
    response = platform.client.put("/api/admin/queues/gpu-exclusive/order", headers=admin,
                                   json={"job_ids": [c["id"], a["id"], b["id"]]})
    assert response.status_code == 200, response.text
    queue = exclusive_queue(platform)
    assert [j["id"] for j in queue["waiting"]] == [c["id"], a["id"], b["id"]]
    # 移動＝以新名稱重建；平台標籤不變，Job 仍是 suspend、由 Kueue 管理
    moved = {j["id"]: j["k8s_name"] for j in queue["waiting"]}
    assert moved[c["id"]] != c["k8s_name"] and moved[b["id"]] != b["k8s_name"]
    clone = kube.batch.read_namespaced_job(moved[c["id"]], NAMESPACE)
    assert clone.spec.suspend is True and clone.metadata.labels["platform/job-id"] == str(c["id"])
    assert clone.spec.template.metadata.labels["platform/job-id"] == str(c["id"])

    # 暫存 a：叢集中的 Job 刪除，b 跳過 a 先開始
    held = platform.client.post(f"/api/projects/{a['project_id']}/jobs/{a['id']}/hold", headers=platform.as_("ra01"))
    assert held.status_code == 200 and held.json()["status"] == "held", held.text
    assert kube.batch.list_namespaced_job(NAMESPACE, label_selector=f"platform/job-id={a['id']}").items == []
    wait_for(lambda: platform.job(b, "ra01")["status"] in ("running", "succeeded"), timeout=240,
             message="暫存一件後，後面的工作沒有接著開始")
    assert platform.job(a, "ra01")["status"] == "held"

    # 恢復排隊：排到最後，在 b 之後才開始
    resumed = platform.client.post(f"/api/admin/jobs/{a['id']}/resume", headers=admin)
    assert resumed.status_code == 200 and resumed.json()["status"] == "queued", resumed.text
    jobs = [short, long, c, a, b]
    traces = status_trace(platform, jobs, "ra01", timeout=300)
    assert all(t[-1] == "succeeded" for t in traces), traces
    assert traces[3][-2:] == ["running", "succeeded"]
    final = {j["id"]: platform.job(j, "ra01")["k8s_name"] for j in jobs}
    assert final[a["id"]] not in (a["k8s_name"], moved[a["id"]])
    starts = {k: start_time(kube, name) for k, name in final.items()}
    assert starts[c["id"]] < starts[b["id"]] < starts[a["id"]], starts
    assert starts[a["id"]] <= kube.batch.read_namespaced_job(final[long["id"]], NAMESPACE).status.completion_time
