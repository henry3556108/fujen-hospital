"""暫存訓練、稍後恢復排隊；把訓練用的設定另存成訓練設定。"""
import pytest

from app.models import AuditLog
from app.permissions import Role
from app.scheduling.models import Job, JobHold
from conftest_training import batch, finish, ok, setting_body, start


def runs(pid):
    return f"/api/projects/{pid}/training/runs"


def fill(client, headers, pid, kind="training", count=2):
    """先把池佔滿，後面送出的工作只能排隊。"""
    return [ok(client.post(f"/api/projects/{pid}/jobs", headers=headers,
                           json={"kind": kind, "duration_seconds": 30}), 201) for _ in range(count)]


@pytest.fixture
def queued_run(client, pi, project, backend, table):
    fill(client, pi, project.id)
    run = start(client, pi, project.id, setting_body("tabular_classification", dataset_id=table))
    assert run["status"] == "queued"
    return run


def test_hold_then_resume_and_the_resumed_job_still_trains(client, pi, project, backend, tracker, queued_run,
                                                            session, tmp_path):
    run = queued_run
    held = ok(client.post(f"{runs(project.id)}/{run['id']}/hold", headers=pi))
    assert held["status"] == "held"
    job = session.get(Job, run["job_id"])
    assert job.status == "held" and session.get(JobHold, job.id) is not None
    assert not any(dict(j.spec.env).get("RUN_ID") == str(run["id"]) for j in backend._jobs.values())

    # 前面的工作跑完、卡空出來，暫存的訓練不會開始；清單與報表都把它當成未完成
    backend.advance(60)
    listed = {r["id"]: r for r in ok(client.get(runs(project.id), headers=pi))}
    assert listed[run["id"]]["status"] == "held" and listed[run["id"]]["finished_at"] is None
    report = client.get(f"{runs(project.id)}/{run['id']}/report", headers=pi)
    assert report.status_code == 409 and "尚未完成" in report.json()["detail"]
    assert tracker.runs[run["tracking_run_id"]]["status"] == "RUNNING"

    resumed = ok(client.post(f"{runs(project.id)}/{run['id']}/resume", headers=pi))
    assert resumed["status"] in ("queued", "running")
    session.expire_all()
    assert session.get(JobHold, run["job_id"]) is None
    # 工作憑證沒有時效，恢復後的 Job 仍能下載資料包、上傳模型、回報完成
    done = finish(client, backend, pi, run, tmp_path)
    assert done["status"] == "succeeded" and done["model_id"]
    actions = [a.action for a in session.query(AuditLog).filter(AuditLog.target == f"job:{run['job_id']}")]
    assert actions == ["job.submit", "job.hold", "job.resume"]


def test_running_run_cannot_be_held(client, pi, project, backend, table):
    run = start(client, pi, project.id, setting_body("tabular_classification", dataset_id=table))
    assert run["status"] == "running"
    response = client.post(f"{runs(project.id)}/{run['id']}/hold", headers=pi)
    assert response.status_code == 409 and "無法暫存" in response.json()["detail"]
    assert client.post(f"{runs(project.id)}/{run['id']}/resume", headers=pi).status_code == 409


def test_only_owner_or_admin_holds_a_run(client, pi, member, admin, project, backend, queued_run):
    other = member("pi02")
    denied = client.post(f"{runs(project.id)}/{queued_run['id']}/hold", headers=other)
    assert denied.status_code == 403
    # Admin 在後台佇列頁暫存：訓練清單跟著顯示已暫存
    ok(client.post(f"/api/admin/jobs/{queued_run['job_id']}/hold", headers=admin))
    listed = {r["id"]: r for r in ok(client.get(runs(project.id), headers=pi))}
    assert listed[queued_run["id"]]["status"] == "held"
    queue = next(q for q in ok(client.get("/api/admin/queues", headers=admin)) if q["queue"] == "gpu-exclusive")
    (row,) = queue["held"]
    assert row["training_run"] == {"id": queued_run["id"], "name": queued_run["name"]} and row["held_by"] == "admin01"
    assert ok(client.post(f"{runs(project.id)}/{queued_run['id']}/resume", headers=pi))["status"] == "queued"


def test_cancel_held_run(client, pi, project, backend, tracker, queued_run, session):
    ok(client.post(f"{runs(project.id)}/{queued_run['id']}/hold", headers=pi))
    cancelled = ok(client.post(f"{runs(project.id)}/{queued_run['id']}/cancel", headers=pi))
    assert cancelled["status"] == "cancelled" and cancelled["finished_at"]
    assert session.get(JobHold, queued_run["job_id"]) is None
    assert tracker.runs[queued_run["tracking_run_id"]]["status"] == "KILLED"


def test_held_batch_inference_waits_and_resumes(client, pi, project, backend, inference, table, tmp_path):
    run = finish(client, backend, pi, start(client, pi, project.id,
                                            setting_body("tabular_classification", dataset_id=table)), tmp_path)
    fill(client, pi, project.id, kind="data-cleaning", count=8)
    record = batch(client, pi, project.id, run["model_id"], "test")
    assert record["status"] == "queued"
    ok(client.post(f"/api/projects/{project.id}/jobs/{record['job_id']}/hold", headers=pi))
    url = f"/api/projects/{project.id}/inference/{record['id']}"
    assert ok(client.get(url, headers=pi))["status"] == "held"
    early = client.get(f"{url}/download", headers=pi)
    assert early.status_code == 409 and "已暫存" in early.json()["detail"]
    ok(client.post(f"/api/projects/{project.id}/jobs/{record['job_id']}/resume", headers=pi))
    assert ok(client.get(url, headers=pi))["status"] == "queued"
    cancelled = ok(client.post(f"{url}/cancel", headers=pi))
    assert cancelled["status"] == "cancelled"


@pytest.mark.parametrize("kind", ["tabular_classification", "image_classification"])
def test_save_run_as_setting(kind, client, pi, project, backend, session, request):
    data = request.getfixturevalue("table" if kind.startswith("tabular") else "images")
    body = setting_body(kind, dataset_id=data) if kind.startswith("tabular") else setting_body(kind, synth=data)
    original = ok(client.post(f"/api/projects/{project.id}/training/settings", headers=pi, json=body), 201)
    run = ok(client.post(f"/api/projects/{project.id}/training/settings/{original['id']}/runs", headers=pi,
                         json={"executor": "fake"}), 201)
    saved = ok(client.post(f"{runs(project.id)}/{run['id']}/save-setting", headers=pi,
                           json={"name": "另存的設定"}), 201)
    assert saved["name"] == "另存的設定" and saved["kind"] == kind and saved["id"] != original["id"]
    assert saved["config"] == original["config"]
    dup = client.post(f"{runs(project.id)}/{run['id']}/save-setting", headers=pi, json={"name": "另存的設定"})
    assert dup.status_code == 409
    assert client.post(f"{runs(project.id)}/{run['id']}/save-setting", headers=pi, json={"name": " "}).status_code == 422
    again = ok(client.post(f"/api/projects/{project.id}/training/settings/{saved['id']}/runs", headers=pi,
                           json={"executor": "fake"}), 201)
    assert again["config"] == run["config"] and again["dataset_version_id"] == run["dataset_version_id"]
    log = session.query(AuditLog).filter_by(action="training_setting.create").order_by(AuditLog.id.desc()).first()
    assert log.detail["from_run_id"] == run["id"]


def test_save_setting_requires_training_permission(client, member, pi, project, backend, table):
    run = start(client, pi, project.id, setting_body("tabular_classification", dataset_id=table))
    viewer = member("vw01", Role.VIEWER)
    for action in ("save-setting", "hold", "resume"):
        response = client.post(f"{runs(project.id)}/{run['id']}/{action}", headers=viewer, json={"name": "x"})
        assert response.status_code == 403
