"""後台調整佇列順序、暫存與恢復排隊（記憶體版後端，語意與 Kueue StrictFIFO 相同）。"""
import pytest
from sqlalchemy import select

from app.models import AuditLog
from app.scheduling.models import Job, JobHold
from app.scheduling.states import JobStatus

QUEUES = "/api/admin/queues"


@pytest.fixture
def p1(make_project):
    return make_project("P1-lung-ct", "gpu-exclusive")


@pytest.fixture
def ra(p1, member):
    return member(p1, "ra01")


def submit(client, project, headers, **body):
    response = client.post(f"/api/projects/{project.id}/jobs", headers=headers,
                           json={"kind": "training", "duration_seconds": 10, **body})
    assert response.status_code == 201, response.text
    return response.json()


def queue(client, admin, name="gpu-exclusive"):
    response = client.get(QUEUES, headers=admin)
    assert response.status_code == 200, response.text
    return next(q for q in response.json() if q["queue"] == name)


def reorder(client, admin, job_ids, name="gpu-exclusive"):
    return client.put(f"{QUEUES}/{name}/order", headers=admin, json={"job_ids": job_ids})


def fill_and_queue(client, p1, ra, waiting=3):
    """獨占池 2 張卡先佔滿，再排 waiting 件。"""
    running = [submit(client, p1, ra) for _ in range(2)]
    queued = [submit(client, p1, ra) for _ in range(waiting)]
    return running, queued


def test_overview_lists_running_waiting_and_all_queues(client, backend, admin, p1, ra):
    running, queued = fill_and_queue(client, p1, ra)
    data = client.get(QUEUES, headers=admin).json()
    assert [q["queue"] for q in data] == ["gpu-exclusive", "gpu-shared", "cpu-data"]
    q = queue(client, admin)
    assert [j["id"] for j in q["running"]] == [j["id"] for j in running]
    assert [j["id"] for j in q["waiting"]] == [j["id"] for j in queued]
    assert [j["position"] for j in q["waiting"]] == [1, 2, 3]
    assert q["held"] == []
    first = q["waiting"][0]
    assert first["project_name"] == "P1-lung-ct" and first["user"] == "ra01" and first["kind"] == "training"
    assert first["training_run"] is None and first["inference_id"] is None


def test_queue_endpoints_are_admin_only(client, backend, p1, ra):
    assert client.get(QUEUES, headers=ra).status_code == 403
    assert reorder(client, ra, []).status_code == 403
    assert client.post("/api/admin/jobs/1/hold", headers=ra).status_code == 403


def test_reorder_changes_actual_start_order_and_audits(client, backend, session, admin, p1, ra):
    running, queued = fill_and_queue(client, p1, ra)
    a, b, c = (j["id"] for j in queued)
    response = reorder(client, admin, [c, a, b])
    assert response.status_code == 200, response.text
    assert response.json() == {"queue": "gpu-exclusive", "job_ids": [c, a, b]}
    assert [j["id"] for j in queue(client, admin)["waiting"]] == [c, a, b]
    names = {j.id: j.k8s_name for j in session.scalars(select(Job)).all()}
    # 每件只佔一張卡、跑 10 秒：依新順序開始
    backend.advance(10)
    backend.advance(10)
    started = backend.start_order()
    assert started[2:] == [names[c], names[a], names[b]]
    (log,) = session.scalars(select(AuditLog).where(AuditLog.action == "queue.reorder")).all()
    assert log.category == "project" and log.actor == "admin01" and log.target == "queue:gpu-exclusive"
    assert log.detail["before"] == [a, b, c] and log.detail["after"] == [c, a, b]
    assert log.detail["moved"] == [c, a, b]


def test_reorder_keeps_jobs_already_in_place(client, backend, session, admin, p1, ra):
    _, queued = fill_and_queue(client, p1, ra)
    a, b, c = (j["id"] for j in queued)
    before = {j.id: j.k8s_name for j in session.scalars(select(Job)).all()}
    assert reorder(client, admin, [a, c, b]).status_code == 200
    session.expire_all()
    after = {j.id: j.k8s_name for j in session.scalars(select(Job)).all()}
    assert after[a] == before[a]                       # 排頭沒動
    assert after[b] != before[b] and after[c] != before[c]
    assert after[c].startswith(f"job-{c}-")
    log = session.scalars(select(AuditLog).where(AuditLog.action == "queue.reorder")).one()
    assert log.detail["moved"] == [c, b]


def test_reorder_rejects_list_that_does_not_match_waiting_jobs(client, backend, admin, p1, ra):
    running, queued = fill_and_queue(client, p1, ra)
    a, b, c = (j["id"] for j in queued)
    missing = reorder(client, admin, [b, a])
    assert missing.status_code == 409 and "請重新整理" in missing.json()["detail"]
    with_running = reorder(client, admin, [running[0]["id"], a, b, c])
    assert with_running.status_code == 409
    assert reorder(client, admin, [a, a, b, c]).status_code == 422
    assert reorder(client, admin, [a, b, c], name="no-such-queue").status_code == 404
    assert [j["id"] for j in queue(client, admin)["waiting"]] == [a, b, c]


def test_hold_skips_job_and_resume_puts_it_last(client, backend, session, admin, p1, ra):
    _, queued = fill_and_queue(client, p1, ra)
    a, b, c = queued
    response = client.post(f"/api/projects/{p1.id}/jobs/{a['id']}/hold", headers=ra)
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "held" and "暫存" in response.json()["message"]
    assert session.get(JobHold, a["id"]).held_by == "ra01"
    q = queue(client, admin)
    assert [j["id"] for j in q["waiting"]] == [b["id"], c["id"]]
    assert [(j["id"], j["held_by"]) for j in q["held"]] == [(a["id"], "ra01")]
    # 暫存中不會同步叢集（叢集裡已經沒有這件）
    backend.advance(10)
    assert client.get(f"/api/projects/{p1.id}/jobs/{a['id']}", headers=ra).json()["status"] == "held"
    resumed = client.post(f"/api/projects/{p1.id}/jobs/{a['id']}/resume", headers=ra)
    assert resumed.status_code == 200, resumed.text
    body = resumed.json()
    assert body["status"] == "queued" and body["k8s_name"] != a["k8s_name"] and body["message"] == ""
    session.expire_all()
    assert session.get(JobHold, a["id"]) is None
    backend.advance(10)
    backend.advance(10)
    assert backend.start_order()[2:] == [b["k8s_name"], c["k8s_name"], body["k8s_name"]]
    actions = [log.action for log in session.scalars(select(AuditLog).where(AuditLog.target == f"job:{a['id']}"))]
    assert actions == ["job.submit", "job.hold", "job.resume"]
    logs = session.scalars(select(AuditLog).where(AuditLog.action.in_(["job.hold", "job.resume"]))).all()
    assert {log.category for log in logs} == {"training"}


def test_running_job_cannot_be_held(client, backend, p1, ra):
    running, _ = fill_and_queue(client, p1, ra, waiting=0)
    response = client.post(f"/api/projects/{p1.id}/jobs/{running[0]['id']}/hold", headers=ra)
    assert response.status_code == 409 and "執行中" in response.json()["detail"]


def test_hold_and_resume_wrong_states(client, backend, p1, ra):
    _, (job,) = fill_and_queue(client, p1, ra, waiting=1)
    assert client.post(f"/api/projects/{p1.id}/jobs/{job['id']}/resume", headers=ra).status_code == 409
    assert client.post(f"/api/projects/{p1.id}/jobs/{job['id']}/hold", headers=ra).status_code == 200
    assert client.post(f"/api/projects/{p1.id}/jobs/{job['id']}/hold", headers=ra).status_code == 409


def test_only_owner_or_admin_can_hold(client, backend, admin, p1, ra, member):
    other = member(p1, "ra09")
    _, (job,) = fill_and_queue(client, p1, ra, waiting=1)
    denied = client.post(f"/api/projects/{p1.id}/jobs/{job['id']}/hold", headers=other)
    assert denied.status_code == 403 and "ra01" in denied.json()["detail"]
    held = client.post(f"/api/admin/jobs/{job['id']}/hold", headers=admin)
    assert held.status_code == 200 and held.json()["status"] == "held"
    assert client.post(f"/api/projects/{p1.id}/jobs/{job['id']}/resume", headers=other).status_code == 403
    resumed = client.post(f"/api/admin/jobs/{job['id']}/resume", headers=admin)
    assert resumed.status_code == 200 and resumed.json()["status"] == "queued"
    assert client.post("/api/admin/jobs/9999/hold", headers=admin).status_code == 404


def test_cancel_held_job_marks_cancelled(client, backend, session, p1, ra):
    _, (job,) = fill_and_queue(client, p1, ra, waiting=1)
    client.post(f"/api/projects/{p1.id}/jobs/{job['id']}/hold", headers=ra)
    response = client.post(f"/api/projects/{p1.id}/jobs/{job['id']}/cancel", headers=ra)
    assert response.status_code == 200 and response.json()["status"] == "cancelled"
    session.expire_all()
    assert session.get(JobHold, job["id"]) is None
    assert client.post(f"/api/projects/{p1.id}/jobs/{job['id']}/resume", headers=ra).status_code == 409


def test_held_jobs_count_on_admin_dashboard(client, backend, admin, p1, ra):
    _, (job,) = fill_and_queue(client, p1, ra, waiting=1)
    client.post(f"/api/projects/{p1.id}/jobs/{job['id']}/hold", headers=ra)
    data = client.get("/api/admin/dashboard", headers=admin).json()
    assert data["jobs"]["by_status"][JobStatus.HELD.value] == 1


def test_admitted_job_is_listed_as_running_not_reorderable(client, backend, admin, p1, ra, monkeypatch):
    """Kubernetes 上 Kueue 放行後到容器起來之前狀態仍是 queued；它不在等待清單，不能移動。"""
    _, queued = fill_and_queue(client, p1, ra, waiting=2)
    a, b = queued
    real_order = backend.order
    monkeypatch.setattr(backend, "order", lambda q: [n for n in real_order(q) if n != a["k8s_name"]])
    q = queue(client, admin)
    assert [(j["id"], j["admitted"]) for j in q["running"] if j["status"] == "queued"] == [(a["id"], True)]
    assert [j["id"] for j in q["waiting"]] == [b["id"]]
    assert reorder(client, admin, [b["id"], a["id"]]).status_code == 409
