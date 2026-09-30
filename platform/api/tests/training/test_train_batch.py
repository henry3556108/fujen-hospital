"""批次推論改為背景工作：送出（202）→ 排程 Job（trainer.batch）→ 回報 → 定案。TC-B06-01、03 的非同步行為。"""
import io
import tarfile

import pytest
from sqlalchemy import delete

from app.models import AuditLog
from app.permissions import Role
from app.scheduling.models import Job
from app.training.models import InferenceBatch, InferenceRecord
from conftest_training import (batch, batch_env, batch_headers, batch_job, finish, ok, run_batch, setting_body,
                               start)


def models(pid):
    return f"/api/projects/{pid}/models"


@pytest.fixture
def tabular_model(client, pi, project, backend, inference, table, tmp_path):
    run = finish(client, backend, pi, start(client, pi, project.id,
                                            setting_body("tabular_classification", dataset_id=table)), tmp_path / "t")
    return ok(client.get(f"{models(project.id)}/{run['model_id']}", headers=pi))


@pytest.fixture
def image_model(client, pi, project, backend, inference, images, tmp_path):
    run = finish(client, backend, pi, start(client, pi, project.id,
                                            setting_body("image_classification", synth=images)), tmp_path / "i")
    return ok(client.get(f"{models(project.id)}/{run['model_id']}", headers=pi))


def audits(session, action):
    return session.query(AuditLog).filter_by(action=action).order_by(AuditLog.id).all()


def test_tc_b06_01_submit_returns_at_once_and_the_job_does_the_work(client, pi, project, backend, tabular_model,
                                                                     inference, session, tmp_path):
    before = list(inference.calls)
    record = batch(client, pi, project.id, tabular_model["id"], "test")
    assert (record["status"], record["mode"], record["count"]) == ("queued", "batch", 20)
    assert record["job_id"] and record["result"] is None and not record["has_result"]
    assert inference.calls == before, "批次推論不經過推論服務"

    spec = batch_job(backend, record).spec
    assert (spec.queue, spec.gpus) == ("cpu-data", 0), "結構式模型不占 GPU"
    assert spec.command == ("python", "-m", "trainer.batch") and spec.image == "platform-trainer:dev"
    env = batch_env(backend, record)
    assert set(env) == {"INFERENCE_ID", "JOB_IO_URL", "JOB_IO_TOKEN", "TRAIN_THREADS"}, "容器沒有平台憑證"
    assert env["JOB_IO_URL"].endswith(f"/api/job-io/inference/{record['id']}")

    assert ok(client.get(f"/api/projects/{project.id}/inference/{record['id']}", headers=pi))["status"] == "running"
    done = run_batch(client, backend, pi, record, tmp_path / "job")
    assert done["status"] == "succeeded" and done["count"] == 20 and done["started_at"] and done["finished_at"]
    result = done["result"]
    assert result["columns"][-2:] == ["prediction", "prediction_note"] and len(result["rows"]) == 20
    assert "diagnosis" not in result["columns"], "不把答案送進推論"
    assert all(r[-2] != "" or r[-1] for r in result["rows"])

    submitted, finished = audits(session, "inference.batch"), audits(session, "inference.batch.finish")
    assert [(a.category, a.result) for a in submitted] == [("inference", "success")]
    assert [(a.category, a.result) for a in finished] == [("inference", "success")]
    assert finished[0].detail["count"] == 20 and finished[0].target == f"inference:{record['id']}"
    job_audit = [a for a in audits(session, "job.submit") if a.detail["kind"] == "inference-cpu"]
    assert [a.category for a in job_audit] == ["inference"]


def test_tc_b06_01_image_batch_runs_on_the_project_gpu_group(client, pi, project, backend, image_model, tmp_path):
    record = batch(client, pi, project.id, image_model["id"], "all")
    spec = batch_job(backend, record).spec
    assert (spec.queue, spec.gpus) == ("gpu-exclusive", 1)
    done = run_batch(client, backend, pi, record, tmp_path / "job")
    assert done["status"] == "succeeded" and done["count"] == 100
    assert all(r["label"] in ("CT", "MR") and r["preview"] for r in done["result"]["results"])


def test_tc_b06_03_download_waits_for_the_result(client, pi, project, backend, tabular_model, tmp_path):
    record = batch(client, pi, project.id, tabular_model["id"], "all")
    early = client.get(f"/api/projects/{project.id}/inference/{record['id']}/download", headers=pi)
    assert early.status_code == 409 and "尚未完成" in early.json()["detail"]
    run_batch(client, backend, pi, record, tmp_path / "job")
    response = client.get(f"/api/projects/{project.id}/inference/{record['id']}/download", headers=pi)
    assert response.status_code == 200 and len(response.text.strip().splitlines()) == 101


def test_container_failure_is_recorded_with_its_reason(client, pi, project, backend, tabular_model, session):
    record = batch(client, pi, project.id, tabular_model["id"])
    headers = batch_headers(backend, record)
    ok(client.post(f"/api/job-io/inference/{record['id']}/complete", headers=headers,
                   json={"status": "failed", "message": "資料缺少特徵欄位：age"}))
    view = ok(client.get(f"/api/projects/{project.id}/inference/{record['id']}", headers=pi))
    assert view["status"] == "failed" and view["message"] == "資料缺少特徵欄位：age" and view["result"] is None
    assert client.get(f"/api/projects/{project.id}/inference/{record['id']}/download", headers=pi).status_code == 404
    assert [a.result for a in audits(session, "inference.batch.finish")] == ["failure"]
    again = client.post(f"/api/job-io/inference/{record['id']}/complete", headers=headers,
                        json={"status": "succeeded", "answer": {"predictions": []}})
    assert again.status_code == 401, "定案後 token 失效"


def test_job_that_fails_without_reporting_is_failed(client, pi, project, backend, tabular_model, tmp_path):
    from dataclasses import replace

    record = batch(client, pi, project.id, tabular_model["id"])
    job = batch_job(backend, record)
    job.spec = replace(job.spec, fail=True)
    backend.advance(60)
    view = ok(client.get(f"/api/projects/{project.id}/inference/{record['id']}", headers=pi))
    assert view["status"] == "failed" and "非 0" in view["message"]


def test_job_that_ends_without_a_result_is_failed(client, pi, project, backend, tabular_model):
    record = batch(client, pi, project.id, tabular_model["id"])
    backend.advance(60)
    history = ok(client.get(f"{models(project.id)}/{tabular_model['id']}/inference", headers=pi))
    assert history[0]["id"] == record["id"] and history[0]["status"] == "failed"
    assert "沒有回報推論結果" in history[0]["message"], "查歷史時同步狀態"


def test_answer_that_does_not_match_the_input_is_failed(client, pi, project, backend, tabular_model):
    record = batch(client, pi, project.id, tabular_model["id"])
    ok(client.post(f"/api/job-io/inference/{record['id']}/complete", headers=batch_headers(backend, record),
                   json={"status": "succeeded", "answer": {"predictions": ["1"], "notes": [None]}}))
    view = ok(client.get(f"/api/projects/{project.id}/inference/{record['id']}", headers=pi))
    assert view["status"] == "failed" and "1 筆" in view["message"] and "20 筆" in view["message"]


def test_cancel_queued_and_running_batches(client, pi, member, project, backend, image_model, session):
    viewer = member("vw01", Role.VIEWER)
    records = [batch(client, pi, project.id, image_model["id"]) for _ in range(3)]
    states = [ok(client.get(f"/api/projects/{project.id}/inference/{r['id']}", headers=pi))["status"]
              for r in records]
    assert states == ["running", "running", "queued"], "獨占池 2 張卡"
    for record in (records[2], records[0]):
        headers = batch_headers(backend, record)
        out = ok(client.post(f"/api/projects/{project.id}/inference/{record['id']}/cancel", headers=viewer))
        assert out["status"] == "cancelled" and out["finished_at"] and "vw01" in out["message"]
        assert session.get(Job, out["job_id"]).status == "cancelled"
        assert client.get(f"/api/job-io/inference/{record['id']}/bundle", headers=headers).status_code == 401
    cancelled = audits(session, "inference.batch.cancel")
    assert [(a.category, a.result, a.actor) for a in cancelled] == [("inference", "cancelled", "vw01")] * 2
    assert {a.category for a in audits(session, "job.cancel")} == {"inference"}
    again = client.post(f"/api/projects/{project.id}/inference/{records[0]['id']}/cancel", headers=pi)
    assert again.status_code == 409 and "已結束" in again.json()["detail"]
    assert client.post(f"/api/projects/{project.id}/inference/999/cancel", headers=pi).status_code == 404


def test_upload_inference_cannot_be_cancelled(client, pi, project, tabular_model, synth):
    upload = ok(client.post(f"{models(project.id)}/{tabular_model['id']}/inference/upload", headers=pi,
                            files=[("files", ("c.csv", (synth / "tabular" / "cohort_02.csv").read_bytes()))]), 201)
    response = client.post(f"/api/projects/{project.id}/inference/{upload['id']}/cancel", headers=pi)
    assert response.status_code == 409 and "批次推論" in response.json()["detail"]


def test_token_is_scoped_to_one_batch(client, pi, project, backend, tabular_model):
    first, second = (batch(client, pi, project.id, tabular_model["id"]) for _ in range(2))
    token = batch_headers(backend, first)
    assert client.get(f"/api/job-io/inference/{second['id']}/bundle", headers=token).status_code == 401
    assert client.get(f"/api/job-io/inference/{first['id']}/bundle",
                      headers={"X-Job-Token": "nope"}).status_code == 401
    assert client.get(f"/api/job-io/inference/{first['id']}/bundle").status_code == 401
    assert client.get("/api/job-io/inference/999/bundle", headers=token).status_code == 401
    bad = client.post(f"/api/job-io/inference/{first['id']}/complete", headers=token, json={"status": "done"})
    assert bad.status_code == 422
    # 訓練的 token 不能拿來讀推論，反之亦然
    assert client.get(f"/api/job-io/runs/{tabular_model['run_id']}/bundle", headers=token).status_code == 401


def test_bundle_contains_the_model_and_only_the_picked_rows(client, pi, project, backend, tabular_model):
    record = batch(client, pi, project.id, tabular_model["id"], "validation")
    response = client.get(f"/api/job-io/inference/{record['id']}/bundle", headers=batch_headers(backend, record))
    assert response.status_code == 200
    with tarfile.open(fileobj=io.BytesIO(response.content)) as archive:
        names = set(archive.getnames())
        csv_text = archive.extractfile("input.csv").read().decode()
    assert {"batch.json", "model.pkl", "preprocess.pkl", "schema.json", "input.csv"} <= names
    assert len(csv_text.strip().splitlines()) == 21 and "diagnosis" not in csv_text.splitlines()[0]


def test_record_deleted_while_queued_leaves_the_job_nothing(client, pi, project, backend, tabular_model, session):
    """刪除專案時推論紀錄、批次列、工作列都 ON DELETE CASCADE；之後 Job 開始也拿不到資料。"""
    record = batch(client, pi, project.id, tabular_model["id"])
    headers = batch_headers(backend, record)
    session.execute(delete(InferenceBatch).where(InferenceBatch.record_id == record["id"]))
    session.execute(delete(InferenceRecord).where(InferenceRecord.id == record["id"]))
    session.commit()
    assert client.get(f"/api/job-io/inference/{record['id']}/bundle", headers=headers).status_code == 401
    assert client.post(f"/api/job-io/inference/{record['id']}/complete", headers=headers,
                       json={"status": "failed"}).status_code == 401


def test_invalid_requests_create_nothing(client, pi, project, backend, tabular_model, image_model, session):
    base = f"{models(project.id)}"
    assert client.post(f"{base}/{tabular_model['id']}/inference/batch", headers=pi,
                       json={"subset": "everything"}).status_code == 422
    assert client.post(f"{base}/999/inference/batch", headers=pi, json={}).status_code == 404
    project.gpu_group = None
    session.commit()
    response = client.post(f"{base}/{image_model['id']}/inference/batch", headers=pi, json={})
    assert response.status_code == 409 and "GPU 群組" in response.json()["detail"]
    assert session.query(InferenceRecord).filter_by(mode="batch").count() == 0
    assert session.query(InferenceBatch).count() == 0
    assert not audits(session, "inference.batch")


def test_scheduler_unavailable_is_503_and_leaves_nothing(client, pi, project, backend, tabular_model, session,
                                                         monkeypatch):
    def down(spec):
        raise ConnectionError("kube-apiserver 無回應")

    monkeypatch.setattr(backend, "submit", down)
    response = client.post(f"{models(project.id)}/{tabular_model['id']}/inference/batch", headers=pi, json={})
    assert response.status_code == 503 and "排程系統" in response.json()["detail"]
    assert session.query(InferenceRecord).filter_by(mode="batch").count() == 0


def test_history_shows_batches_in_every_state(client, pi, project, backend, tabular_model, tmp_path):
    done = run_batch(client, backend, pi, batch(client, pi, project.id, tabular_model["id"]), tmp_path / "a")
    waiting = batch(client, pi, project.id, tabular_model["id"])
    history = ok(client.get(f"{models(project.id)}/{tabular_model['id']}/inference", headers=pi))
    assert [(h["id"], h["status"], h["has_result"]) for h in history] == [
        (waiting["id"], "running", False), (done["id"], "succeeded", True)]
    assert all(h["job_id"] for h in history)


def test_permissions(client, member, project, backend, tabular_model, add_user):
    viewer, outsider = member("vw01", Role.VIEWER), add_user("user01")[1]
    record = batch(client, viewer, project.id, tabular_model["id"])
    assert client.get(f"/api/projects/{project.id}/inference/{record['id']}", headers=outsider).status_code == 403
    assert client.post(f"/api/projects/{project.id}/inference/{record['id']}/cancel",
                       headers=outsider).status_code == 403


def test_start_time_is_known_even_when_the_job_finishes_between_polls(client, pi, project, backend, tabular_model,
                                                                      tmp_path):
    """Job 下載輸入包就表示已在執行：即使沒有人在執行中查詢過，也記得開始時間。"""
    record = batch(client, pi, project.id, tabular_model["id"])
    done = run_batch(client, backend, pi, record, tmp_path / "job", advance=False)   # 送出後第一次查詢就已完成
    assert done["status"] == "succeeded" and done["started_at"] and done["started_at"] <= done["finished_at"]


def test_bundle_download_marks_the_batch_running(client, pi, project, backend, tabular_model):
    record = batch(client, pi, project.id, tabular_model["id"])
    assert client.get(f"/api/job-io/inference/{record['id']}/bundle",
                      headers=batch_headers(backend, record)).status_code == 200
    row = client.app.state.sessionmaker().get(InferenceRecord, record["id"])
    assert row.status == "running" and row.batch.started_at is not None
