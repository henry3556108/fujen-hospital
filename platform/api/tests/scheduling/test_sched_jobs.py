import pytest
from sqlalchemy import select

from app.models import AuditLog
from app.permissions import Role
from app.scheduling.backend import BackendJob
from app.scheduling.states import JobStatus


def jobs_url(project, job_id=None):
    base = f"/api/projects/{project.id}/jobs"
    return base if job_id is None else f"{base}/{job_id}"


@pytest.fixture
def p1(make_project):
    return make_project("P1-lung-ct", "gpu-exclusive")


@pytest.fixture
def ra(p1, member):
    return member(p1, "ra01")


def submit(client, project, headers, **body):
    response = client.post(jobs_url(project), headers=headers, json={"kind": "training", **body})
    assert response.status_code == 201, response.text
    return response.json()


def status(client, project, headers, job):
    return client.get(jobs_url(project, job["id"]), headers=headers).json()["status"]


def test_tc_a02_05_exclusive_job_goes_queued_running_succeeded(client, backend, p1, ra):
    job = submit(client, p1, ra, duration_seconds=10)
    assert job["status"] == "queued" and job["queue"] == "gpu-exclusive" and job["gpu_group"] == "gpu-exclusive"
    seen = [job["status"], status(client, p1, ra, job)]
    backend.advance(10)
    seen.append(status(client, p1, ra, job))
    assert seen == ["queued", "running", "succeeded"]
    final = client.get(jobs_url(p1, job["id"]), headers=ra).json()
    assert final["started_at"] and final["finished_at"]


def test_job_carries_platform_labels(client, backend, p1, ra):
    job = submit(client, p1, ra)
    (row,) = backend.allocations()
    assert row.job_name == job["k8s_name"]
    assert row.labels == {"platform/project-id": str(p1.id), "platform/job-id": str(job["id"]),
                          "platform/training-id": str(job["id"]), "platform/user": "ra01"}


def test_tc_a02_06_shared_three_jobs_run_concurrently(client, backend, make_project, member):
    p2 = make_project("P2-tabular", "gpu-shared")
    headers = member(p2, "ra02")
    jobs = [submit(client, p2, headers, duration_seconds=5) for _ in range(3)]
    assert [j["status"] for j in jobs] == ["queued"] * 3
    assert [status(client, p2, headers, j) for j in jobs] == ["running"] * 3
    assert {(r.node, r.gpu_index) for r in backend.allocations()} == {("gpu-shared-1", 0)}
    backend.advance(5)
    assert [status(client, p2, headers, j) for j in jobs] == ["succeeded"] * 3


def test_tc_c01_03_project_group_binding_decides_queue(client, backend, admin, member):
    client.post("/api/admin/gpu-groups", headers=admin,
                json={"name": "img-train", "pool": "gpu-exclusive", "gpu_count": 1, "mode": "exclusive"})
    expected = {"C3-a": ("gpu-exclusive", "gpu-exclusive"), "C3-b": ("gpu-shared", "gpu-shared"),
                "C3-c": ("img-train", "gpu-exclusive")}
    for name, (group, queue) in expected.items():
        created = client.post("/api/admin/projects", headers=admin, json={"name": name, "gpu_group": group}).json()
        assert created["gpu_group"] == group
        job = client.post(f"/api/projects/{created['id']}/jobs", headers=admin, json={"kind": "training"}).json()
        assert (job["gpu_group"], job["queue"]) == (group, queue)
        assert backend.get(job["k8s_name"]).node.startswith(queue)


def test_training_without_group_is_409(client, backend, make_project, member):
    p = make_project("no-group", None)
    headers = member(p, "ra03")
    response = client.post(jobs_url(p), headers=headers, json={"kind": "training"})
    assert response.status_code == 409 and "GPU 群組" in response.json()["detail"]


def test_training_with_missing_group_is_409(client, backend, make_project, member):
    p = make_project("ghost", "deleted-group")
    headers = member(p, "ra04")
    assert client.post(jobs_url(p), headers=headers, json={"kind": "training"}).status_code == 409


def test_data_cleaning_job_uses_cpu_data_queue(client, backend, p1, ra):
    job = submit(client, p1, ra, kind="data-cleaning")
    assert (job["queue"], job["gpu_group"]) == ("cpu-data", None)
    assert backend.get(job["k8s_name"]).node == "cpu-data-1"
    assert backend.allocations() == []


@pytest.mark.parametrize("body", [{"kind": "mining"}, {"kind": "training", "duration_seconds": 0},
                                  {"kind": "training", "duration_seconds": 3601},
                                  {"kind": "training", "memory_mb": 1024}])
def test_invalid_job_body_is_422(client, backend, p1, ra, body):
    assert client.post(jobs_url(p1), headers=ra, json=body).status_code == 422


def test_requires_training_permission(client, backend, p1, member, add_user):
    viewer = member(p1, "vw01", Role.VIEWER)
    _, outsider = add_user("user01")
    for headers in (viewer, outsider):
        assert client.post(jobs_url(p1), headers=headers, json={"kind": "training"}).status_code == 403
        assert client.get(jobs_url(p1), headers=headers).status_code == 403


def test_list_only_shows_project_jobs(client, backend, p1, ra, make_project, member):
    other = make_project("other", "gpu-shared")
    other_headers = member(other, "ra05")
    mine = submit(client, p1, ra)
    theirs = submit(client, other, other_headers)
    assert [j["id"] for j in client.get(jobs_url(p1), headers=ra).json()] == [mine["id"]]
    assert client.get(jobs_url(p1, theirs["id"]), headers=ra).status_code == 404
    assert client.post(f"{jobs_url(p1, theirs['id'])}/cancel", headers=ra).status_code == 404


def test_submit_and_cancel_are_audited(client, backend, p1, ra, session):
    job = submit(client, p1, ra)
    client.post(f"{jobs_url(p1, job['id'])}/cancel", headers=ra)
    rows = session.scalars(select(AuditLog).where(AuditLog.target == f"job:{job['id']}")).all()
    assert [(r.category, r.action, r.actor) for r in rows] == [("training", "job.submit", "ra01"),
                                                               ("training", "job.cancel", "ra01")]
    assert rows[0].detail["queue"] == "gpu-exclusive"


def test_tc_c01_05_exclusive_pool_three_jobs_fifo_no_loss(client, backend, p1, ra):
    jobs = [submit(client, p1, ra, duration_seconds=10) for _ in range(3)]
    assert [status(client, p1, ra, j) for j in jobs] == ["running", "running", "queued"]
    backend.advance(10)
    assert [status(client, p1, ra, j) for j in jobs] == ["succeeded", "succeeded", "running"]
    backend.advance(10)
    assert backend.start_order() == [j["k8s_name"] for j in jobs]
    assert [j["status"] for j in client.get(jobs_url(p1), headers=ra).json()] == ["succeeded"] * 3


def test_tc_c01_08_cancel_queued_and_failure_keep_queue_moving(client, backend, p1, ra):
    long = submit(client, p1, ra, duration_seconds=20)
    bad = submit(client, p1, ra, duration_seconds=2, fail=True)
    cancel_me = submit(client, p1, ra)
    nxt = submit(client, p1, ra, duration_seconds=5)
    assert status(client, p1, ra, cancel_me) == "queued"
    response = client.post(f"{jobs_url(p1, cancel_me['id'])}/cancel", headers=ra)
    assert response.status_code == 200 and response.json()["status"] == "cancelled"
    backend.advance(2)
    assert status(client, p1, ra, bad) == "failed"
    assert status(client, p1, ra, nxt) == "running"
    backend.advance(20)
    assert [status(client, p1, ra, j) for j in (long, bad, cancel_me, nxt)] == [
        "succeeded", "failed", "cancelled", "succeeded"]


def test_cancel_finished_job_is_409(client, backend, p1, ra):
    job = submit(client, p1, ra, duration_seconds=1)
    backend.advance(1)
    response = client.post(f"{jobs_url(p1, job['id'])}/cancel", headers=ra)
    assert response.status_code == 409 and "已結束" in response.json()["detail"]


def test_backend_regression_is_ignored(client, backend, p1, ra, monkeypatch, caplog):
    job = submit(client, p1, ra)
    assert status(client, p1, ra, job) == "running"
    monkeypatch.setattr(backend, "get", lambda name: BackendJob(state=JobStatus.QUEUED))
    with caplog.at_level("INFO", logger="app.scheduling.service"):
        got = client.get(jobs_url(p1, job["id"]), headers=ra).json()
        listed = client.get(jobs_url(p1), headers=ra).json()
    assert got["status"] == "running"
    # 內部狀態判斷只寫 log，不顯示在使用者看到的「訊息」欄
    assert got["message"] == "" and listed[0]["message"] == ""
    assert "忽略後端回報的狀態 queued" in caplog.text and job["k8s_name"] in caplog.text


def test_legacy_internal_message_is_not_shown(client, backend, p1, ra, session):
    from app.scheduling.models import Job
    job = submit(client, p1, ra)
    row = session.get(Job, job["id"])
    row.message = "忽略後端回報的狀態 queued（目前 running）"   # 舊版本寫進資料庫的內部訊息
    session.commit()
    assert client.get(jobs_url(p1), headers=ra).json()[0]["message"] == ""


def test_job_vanished_from_cluster_is_failed(client, backend, p1, ra, monkeypatch):
    job = submit(client, p1, ra)
    monkeypatch.setattr(backend, "get", lambda name: None)
    got = client.get(jobs_url(p1, job["id"]), headers=ra).json()
    assert got["status"] == "failed" and "叢集" in got["message"]


def test_backend_submit_failure_is_503_and_not_saved(client, backend, p1, ra, monkeypatch):
    def boom(spec):
        raise RuntimeError("apiserver down")
    monkeypatch.setattr(backend, "submit", boom)
    response = client.post(jobs_url(p1), headers=ra, json={"kind": "training"})
    assert response.status_code == 503 and "排程" in response.json()["detail"]
    assert client.get(jobs_url(p1), headers=ra).json() == []


def test_no_backend_configured_is_503(client, p1, ra, monkeypatch):
    monkeypatch.delenv("JOB_BACKEND", raising=False)
    response = client.post(jobs_url(p1), headers=ra, json={"kind": "training"})
    assert response.status_code == 503 and "尚未設定" in response.json()["detail"]


def test_label_values_are_sanitised(client, backend, p1, member):
    headers = member(p1, "Dr.Wang@hospital")
    submit(client, p1, headers)
    (row,) = backend.allocations()
    assert row.labels["platform/user"] == "Dr.Wang-hospital"


def test_tc_c01_05_times_come_from_the_backend_not_from_polling(client, backend, p1, ra):
    """開始與結束時間是後端（叢集）回報的時間：輪詢晚了也不會變。"""
    from datetime import datetime
    first = submit(client, p1, ra, duration_seconds=10)
    second = submit(client, p1, ra, duration_seconds=10)
    third = submit(client, p1, ra, duration_seconds=10)   # 獨占池 2 張卡：第 3 件排隊
    backend.advance(25)                                   # 平台這段時間都沒輪詢
    got = {j["id"]: j for j in client.get(jobs_url(p1), headers=ra).json()}
    at = lambda j, key: datetime.fromisoformat(got[j["id"]][key])  # noqa: E731
    assert (at(second, "started_at") - at(first, "started_at")).total_seconds() == 0
    assert (at(first, "finished_at") - at(first, "started_at")).total_seconds() == 10
    assert (at(third, "started_at") - at(first, "started_at")).total_seconds() == 10   # 第 1 件結束才輪到
    assert (at(third, "finished_at") - at(third, "started_at")).total_seconds() == 10
