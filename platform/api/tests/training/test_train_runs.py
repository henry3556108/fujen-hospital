"""訓練執行：TC-B05-01（5 種訓練與狀態流轉）、TC-B05-04（重現）、TC-B05-07（訓練資料被刪除）、工作 I/O。"""
import hashlib
import io
import json
import tarfile

import pytest
from sqlalchemy import delete

from app.imaging.models import ImagingInstance, ImagingSeries, ImagingStudy
from app.models import AuditLog
from app.permissions import Role
from app.training import config as cfg
from conftest_training import (fetch_bundle, finish, io_headers, job_env, ok, setting_body, simulate_job, start,
                               upload_csv)


def runs(pid):
    return f"/api/projects/{pid}/training/runs"


@pytest.fixture
def everything(images, volumes, table):
    """5 種訓練需要的資料都在 P1。"""
    return {"synth": images, "dataset_id": table}


def body_for(kind, data):
    return setting_body(kind, synth=data["synth"], dataset_id=data["dataset_id"])


@pytest.mark.parametrize("kind", cfg.KINDS)
def test_tc_b05_01_five_kinds_create_and_transition(kind, client, pi, project, backend, tracker, everything,
                                                    tmp_path, session):
    """建立與狀態流轉 100%：排隊 → 執行 → 完成，完成後有模型與指標。"""
    run = start(client, pi, project.id, body_for(kind, everything))
    assert run["kind"] == kind and run["job_id"] and run["seed"] == 42
    assert run["status"] == "running", "獨占池有空卡，送出後立即執行"
    # 排程工作走專案綁定的 GPU 群組，Dashboard 的 Training ID 是訓練編號
    spec = next(j.spec for j in backend._jobs.values())
    assert spec.queue == "gpu-exclusive" and spec.labels["platform/training-id"] == str(run["id"])
    assert spec.command == ("python", "-m", "trainer.runner") and spec.image == "platform-trainer:dev"

    done = finish(client, backend, pi, run, tmp_path)
    assert done["status"] == "succeeded" and done["finished_at"] and done["started_at"]
    fmt = cfg.MODEL_FORMAT[kind]
    assert f"model.{fmt}" in done["artifacts"] and done["metrics"]["test"]
    model = ok(client.get(f"/api/projects/{project.id}/models/{done['model_id']}", headers=pi))
    assert model["format"] == fmt and model["kind"] == kind
    assert model["sha256"] == done["artifacts"][f"model.{fmt}"]["sha256"]
    assert model["card"]["dataset_content_hash"] == done["dataset_version"]["content_hash"]

    actions = [a.action for a in session.query(AuditLog).filter_by(category="training")]
    assert {"training.submit", "job.submit", "training.finish"} <= set(actions)
    tracked = tracker.runs[done["tracking_run_id"]]
    assert tracked["status"] == "FINISHED" and tracked["params"]["seed"] == "42"
    assert tracked["tags"]["platform.dataset_hash"] == done["dataset_version"]["content_hash"]
    assert tracked["metrics"], "指標已寫入訓練紀錄"


def test_tc_b05_01_queue_order_and_failure_states(client, pi, project, backend, everything, tmp_path):
    """獨占池 2 張卡：第 3 件排隊；失敗、沒交模型、取消都有明確狀態。"""
    body = body_for("tabular_classification", everything)
    first = start(client, pi, project.id, body)
    others = [ok(client.post(f"/api/projects/{project.id}/training/settings/{first['setting_id']}/runs",
                             headers=pi, json={"executor": "fake"}), 201) for _ in range(3)]
    states = [r["status"] for r in ok(client.get(runs(project.id), headers=pi))]
    assert states == ["running", "running", "queued", "queued"]

    # 第 1 件：程式失敗
    ok(client.post(f"/api/job-io/runs/{first['id']}/complete", headers=io_headers(backend, first),
                   json={"status": "failed", "message": "訓練資料去掉含缺值的列後不足 2 筆"}))
    # 第 2 件：Job 正常結束但沒有上傳模型
    simulate_job(client, backend, others[0], tmp_path / "b", skip=("model.pkl",))
    _fail(backend, first)       # 記憶體版排程的時間往前 60 秒：執行中的兩件同時結束
    out = {r["id"]: r for r in ok(client.get(runs(project.id), headers=pi))}
    assert out[first["id"]]["status"] == "failed" and "不足 2 筆" in out[first["id"]]["message"]
    assert out[others[0]["id"]]["status"] == "failed" and "沒有上傳模型" in out[others[0]["id"]]["message"]
    assert out[first["id"]]["model_id"] is None and out[others[0]["id"]]["model_id"] is None
    assert out[others[1]["id"]]["status"] == "running", "前面結束後，排隊的工作照順序開始"

    cancelled = ok(client.post(f"{runs(project.id)}/{others[2]['id']}/cancel", headers=pi))
    assert cancelled["status"] == "cancelled"
    assert client.post(f"{runs(project.id)}/{others[2]['id']}/cancel", headers=pi).status_code == 409
    assert finish(client, backend, pi, others[1], tmp_path / "c")["status"] == "succeeded"


def _name(backend, run):
    return next(name for name, j in backend._jobs.items() if dict(j.spec.env).get("RUN_ID") == str(run["id"]))


def _fail(backend, run):
    """讓記憶體版排程把這件工作記為失敗（等同容器以非 0 結束）。"""
    from dataclasses import replace

    job = backend._jobs[_name(backend, run)]
    job.spec = replace(job.spec, fail=True)
    backend.advance(60)


@pytest.mark.parametrize("kind", ["image_classification", "tabular_regression"])
def test_tc_b05_04_rerun_uses_same_data_config_and_seed(kind, client, pi, project, backend, everything, tmp_path):
    """以同一份設定重跑 3 筆：資料版本、設定、種子相同；評估指標差異 0。"""
    original = finish(client, backend, pi, start(client, pi, project.id, body_for(kind, everything)),
                      tmp_path / "0")
    # 重跑之前把設定改掉、再加新資料：重現不受影響
    setting = ok(client.get(f"/api/projects/{project.id}/training/settings/{original['setting_id']}", headers=pi))
    changed = setting["config"] | {"seed": 7}
    ok(client.put(f"/api/projects/{project.id}/training/settings/{setting['id']}", headers=pi,
                  json={"name": setting["name"], "config": changed}))
    upload_csv(client, pi, project.id, everything["synth"], "cohort_02")

    reruns = []
    for i in range(3):
        created = ok(client.post(f"{runs(project.id)}/{original['id']}/rerun", headers=pi), 201)
        reruns.append(finish(client, backend, pi, created, tmp_path / str(i + 1)))
    for r in reruns:
        assert r["status"] == "succeeded" and r["parent_run_id"] == original["id"]
        assert r["dataset_version_id"] == original["dataset_version_id"]
        assert r["config"] == original["config"] and r["seed"] == original["seed"] == 42
        assert r["metrics"] == original["metrics"], "評估指標差異 0"
        fmt = cfg.MODEL_FORMAT[kind]
        assert r["artifacts"][f"model.{fmt}"]["sha256"] == original["artifacts"][f"model.{fmt}"]["sha256"]
    # 從改過的設定重新送出則是另一回事：種子不同
    fresh = ok(client.post(f"/api/projects/{project.id}/training/settings/{setting['id']}/runs", headers=pi,
                           json={"executor": "fake"}), 201)
    assert fresh["seed"] == 7 and fresh["parent_run_id"] is None


def test_tc_b05_07_images_deleted_while_queued(client, pi, project, backend, orthanc, images, session, tmp_path):
    """訓練排隊中刪除來源影像：訓練仍用凍結的資料版本完成，不讀到新資料。"""
    body = setting_body("image_classification", synth=images)
    blockers = [start(client, pi, project.id, body)]
    blockers.append(ok(client.post(f"/api/projects/{project.id}/training/settings/{blockers[0]['setting_id']}/runs",
                                   headers=pi, json={"executor": "fake"}), 201))
    queued = ok(client.post(f"/api/projects/{project.id}/training/settings/{blockers[0]['setting_id']}/runs",
                            headers=pi, json={"executor": "fake"}), 201)
    assert queued["status"] == "queued"
    before = fetch_bundle(client, backend, queued, tmp_path / "before")
    expected = sorted(p.name for p in (before / "dataset" / "blobs").iterdir())
    assert len(expected) == 100

    # 刪除來源：平台索引與影像節點上的影像都清掉
    for table in (ImagingInstance, ImagingSeries, ImagingStudy):
        session.execute(delete(table))
    session.commit()
    orthanc.instances.clear()
    assert ok(client.get(f"/api/projects/{project.id}/imaging/studies", headers=pi)) == []

    for blocker in blockers:
        simulate_job(client, backend, blocker, tmp_path / f"blocker{blocker['id']}")
    backend.advance(60)         # 執行中的兩件同時結束，排隊的那件開始
    assert ok(client.get(f"{runs(project.id)}/{queued['id']}", headers=pi))["status"] == "running"
    after = fetch_bundle(client, backend, queued, tmp_path / "after")
    assert sorted(p.name for p in (after / "dataset" / "blobs").iterdir()) == expected
    for path in (after / "dataset" / "blobs").iterdir():
        assert hashlib.sha256(path.read_bytes()).hexdigest() == path.name
    done = finish(client, backend, pi, queued, tmp_path / "run")
    assert done["status"] == "succeeded" and done["dataset_version"]["item_count"] == 100

    # 來源沒了之後，新的訓練明確失敗（不會默默用空資料）
    response = client.post(f"/api/projects/{project.id}/training/settings/{queued['setting_id']}/runs",
                           headers=pi, json={"executor": "fake"})
    assert response.status_code == 409 and "沒有可用於訓練的資料" in response.json()["detail"]
    # 重現仍然可以，因為用的是凍結的版本
    again = ok(client.post(f"{runs(project.id)}/{done['id']}/rerun", headers=pi), 201)
    assert finish(client, backend, pi, again, tmp_path / "again")["metrics"] == done["metrics"]


def test_tc_b05_07_tabular_dataset_deleted_while_queued(client, pi, project, backend, table, tmp_path):
    run = start(client, pi, project.id, setting_body("tabular_classification", dataset_id=table))
    assert client.delete(f"/api/projects/{project.id}/tabular/datasets/{table}", headers=pi).status_code == 204
    done = finish(client, backend, pi, run, tmp_path)
    assert done["status"] == "succeeded"
    splits_rows = json.loads((tmp_path / "out" / "splits.json").read_text())
    assert len(splits_rows["train"]) + len(splits_rows["validation"]) + len(splits_rows["test"]) == 100


def test_bundle_holds_config_and_frozen_data_only(client, pi, project, backend, table, tmp_path):
    run = start(client, pi, project.id, setting_body("tabular_regression", dataset_id=table))
    response = client.get(f"/api/job-io/runs/{run['id']}/bundle", headers=io_headers(backend, run))
    names = tarfile.open(fileobj=io.BytesIO(response.content)).getnames()
    assert names[:2] == ["config.json", "dataset/manifest.json"]
    assert all(n.startswith("dataset/blobs/") for n in names[2:]) and len(names) == 4
    root = fetch_bundle(client, backend, run, tmp_path)
    config = json.loads((root / "config.json").read_text())
    assert config == run["config"] and config["executor"] == "fake" and "source" not in config
    manifest = json.loads((root / "dataset" / "manifest.json").read_text())
    assert manifest["content_hash"] == run["dataset_version"]["content_hash"]


def test_job_container_gets_only_run_scoped_values(client, pi, project, backend, table):
    """TC-B05-05：交給容器的環境變數只有這一次訓練的編號、I/O 位址、一次性 token。"""
    run = start(client, pi, project.id, setting_body("tabular_regression", dataset_id=table))
    env = job_env(backend, run)
    assert set(env) == {"RUN_ID", "JOB_IO_URL", "JOB_IO_TOKEN", "TRAIN_THREADS"}
    assert env["JOB_IO_URL"].endswith(f"/api/job-io/runs/{run['id']}")
    text = json.dumps(env)
    for secret in ("platform-dev", "api-secret-dev", "minio-dev-secret", "orthanc-api-dev", "Bearer",
                   pi["Authorization"].split()[1]):
        assert secret not in text


def test_job_io_token_is_scoped_to_one_run_and_expires(client, pi, project, backend, table, tmp_path, session):
    from app.training.models import TrainingRun

    body = setting_body("tabular_regression", dataset_id=table)
    a = start(client, pi, project.id, body)
    b = ok(client.post(f"/api/projects/{project.id}/training/settings/{a['setting_id']}/runs", headers=pi,
                       json={"executor": "fake"}), 201)
    token_a = io_headers(backend, a)
    # 沒有 token、錯的 token、別件訓練的 token、使用者的登入 token、不存在的訓練：一律 401
    for headers in ({}, {"X-Job-Token": "wrong"}, token_a, pi):
        assert client.get(f"/api/job-io/runs/{b['id']}/bundle", headers=headers).status_code == 401
    assert client.get("/api/job-io/runs/9999/bundle", headers=token_a).status_code == 401
    assert client.put(f"/api/job-io/runs/{b['id']}/artifacts/model.pkl", headers=token_a,
                      content=b"x").status_code == 401
    # 只能上傳約定的檔名；資料庫只存 token 的雜湊
    assert client.put(f"/api/job-io/runs/{a['id']}/artifacts/..%2Fevil", headers=token_a,
                      content=b"x").status_code in (404, 422)
    assert client.put(f"/api/job-io/runs/{a['id']}/artifacts/evil.sh", headers=token_a,
                      content=b"x").status_code == 422
    stored = session.get(TrainingRun, a["id"]).io_token_hash
    assert stored == hashlib.sha256(token_a["X-Job-Token"].encode()).hexdigest()
    assert token_a["X-Job-Token"] not in json.dumps(ok(client.get(f"{runs(project.id)}/{a['id']}", headers=pi)))
    # 回報完成後 token 立即失效
    finish(client, backend, pi, a, tmp_path)
    assert client.get(f"/api/job-io/runs/{a['id']}/bundle", headers=token_a).status_code == 401
    assert client.put(f"/api/job-io/runs/{a['id']}/artifacts/model.pkl", headers=token_a,
                      content=b"x").status_code == 401


def test_runs_need_training_permission_and_stay_in_their_project(client, pi, member, project, backend, table,
                                                                 session, add_user, tmp_path):
    from app.models import Project

    run = start(client, pi, project.id, setting_body("tabular_regression", dataset_id=table))
    viewer = member("vw01", Role.VIEWER)
    outsider = add_user("user01")[1]
    for headers in (viewer, outsider):
        assert client.get(runs(project.id), headers=headers).status_code == 403
        assert client.post(f"{runs(project.id)}/{run['id']}/rerun", headers=headers).status_code == 403
        assert client.post(f"/api/projects/{project.id}/training/settings/{run['setting_id']}/runs",
                           headers=headers, json={}).status_code == 403
    other = Project(name="P2-tabular", gpu_group="gpu-shared")
    session.add(other)
    session.commit()
    pi2 = member("pi02", target=other)
    assert client.get(f"{runs(other.id)}/{run['id']}", headers=pi2).status_code == 404
    assert client.post(f"{runs(other.id)}/{run['id']}/rerun", headers=pi2).status_code == 404
    assert client.get(f"/api/projects/{other.id}/training/dataset-versions/{run['dataset_version_id']}",
                      headers=pi2).status_code == 404


def test_project_without_gpu_group_cannot_train(client, member, session, backend, synth):
    from app.models import Project

    project = Project(name="P9-no-gpu")
    session.add(project)
    session.commit()
    headers = member("pi09", target=project)
    dataset = upload_csv(client, headers, project.id, synth)
    setting = ok(client.post(f"/api/projects/{project.id}/training/settings", headers=headers,
                             json=setting_body("tabular_regression", dataset_id=dataset)), 201)
    response = client.post(f"/api/projects/{project.id}/training/settings/{setting['id']}/runs", headers=headers,
                           json={"executor": "fake"})
    assert response.status_code == 409 and "尚未綁定 GPU 群組" in response.json()["detail"]
    assert ok(client.get(f"/api/projects/{project.id}/training/runs", headers=headers)) == []
