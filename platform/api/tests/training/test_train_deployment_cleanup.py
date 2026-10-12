"""刪除專案時停止專案的線上推論服務：部署列與專案同一個交易刪除（端點立即停用），
commit 後從推論服務卸下專案的模型；失敗留在待清理清單重試（app.project_cleanup）。"""
import pytest
from sqlalchemy import select

from app.models import AuditLog
from app.permissions import Role
from app.project_cleanup import StorageCleanupTask
from app.training.inference import InferenceUnavailable
from app.training.models import Deployment, DeploymentTitle
from conftest_training import finish, ok, setting_body, start

ROWS = [{"age": 60, "bmi": 25, "glucose": 100, "sbp": 130}]


@pytest.fixture
def tabular_model(client, pi, project, backend, inference, table, tmp_path):
    run = finish(client, backend, pi, start(client, pi, project.id,
                                            setting_body("tabular_classification", dataset_id=table)), tmp_path)
    return ok(client.get(f"/api/projects/{project.id}/models/{run['model_id']}", headers=pi))


@pytest.fixture
def deployed(client, pi, member, project, tabular_model, add_user):
    """授權給專案成員 md01 與專案外的 user01（專案刪除後成員資格沒了，user01 本來就不是成員）。"""
    member("md01", Role.MEDICAL_DOCTOR)
    outsider = add_user("user01")[1]
    created = ok(client.post(f"/api/projects/{project.id}/deployments", headers=pi,
                             json={"model_id": tabular_model["id"], "name": "diagnosis-rf", "title": "確診預測",
                                   "allowed_users": ["md01", "user01"]}), 201)
    ok(client.post(created["endpoint"], headers=outsider, json={"rows": ROWS}))
    return created, outsider


def _tasks(session):
    session.expire_all()
    return [(t.kind, t.ref, t.attempts) for t in session.scalars(select(StorageCleanupTask).order_by(StorageCleanupTask.id))]


def _cleanup_audits(session):
    rows = session.scalars(select(AuditLog).where(AuditLog.action == "project.data_cleanup").order_by(AuditLog.id))
    return [(e.result, e.detail) for e in rows]


def test_deleting_the_project_stops_its_online_deployments(client, admin, project, tabular_model, deployed, inference,
                                                           session):
    created, caller = deployed
    assert tabular_model["id"] in inference.models

    assert client.delete(f"/api/admin/projects/{project.id}", headers=admin).status_code == 204

    assert client.post(created["endpoint"], headers=caller, json={"rows": ROWS}).status_code == 403, "端點已停用"
    assert session.scalars(select(Deployment)).all() == [] and session.scalars(select(DeploymentTitle)).all() == []
    assert tabular_model["id"] not in inference.models, "模型已從推論服務卸下"
    assert _tasks(session) == []
    [(result, detail)] = _cleanup_audits(session)
    assert result == "success" and detail["models_unloaded"] == 1 and detail["failed"] == 0
    # 與取消叢集工作相同：不逐筆寫 deployment.delete
    assert not session.scalars(select(AuditLog).where(AuditLog.action == "deployment.delete")).all()


def test_unload_failure_is_kept_and_retried(client, admin, project, tabular_model, deployed, inference, session,
                                            monkeypatch):
    created, caller = deployed
    other = ok(client.post("/api/admin/projects", headers=admin, json={"name": "P-other"}), 201)   # 先建：不重用編號
    real_unload = inference.unload

    def down(model_id):
        raise InferenceUnavailable("推論服務目前無法連線，請稍後再試")
    monkeypatch.setattr(inference, "unload", down)

    assert client.delete(f"/api/admin/projects/{project.id}", headers=admin).status_code == 204   # 專案照樣刪除

    assert client.post(created["endpoint"], headers=caller, json={"rows": ROWS}).status_code == 403, "端點不等卸下就停用"
    assert _tasks(session) == [("inference_model", str(tabular_model["id"]), 1)]
    assert _cleanup_audits(session)[-1][0] == "partial"
    assert tabular_model["id"] in inference.models

    monkeypatch.setattr(inference, "unload", real_unload)
    assert client.delete(f"/api/admin/projects/{other['id']}", headers=admin).status_code == 204
    assert tabular_model["id"] not in inference.models and _tasks(session) == []
    assert _cleanup_audits(session)[-1] == ("success", {"objects_deleted": 0, "orthanc_deleted": 0, "failed": 0,
                                                        "models_unloaded": 1})


def test_without_an_inference_service_no_unload_task_is_staged(client, admin, project, tabular_model, deployed,
                                                               session, monkeypatch):
    """推論服務沒有設定就沒有載入過的模型；部署列仍然刪除。"""
    created, caller = deployed
    client.app.state.inference_backend = None
    monkeypatch.delenv("INFERENCE_URL", raising=False)
    monkeypatch.delenv("INFERENCE_BACKEND", raising=False)
    assert client.delete(f"/api/admin/projects/{project.id}", headers=admin).status_code == 204
    assert session.scalars(select(Deployment)).all() == []
    assert _tasks(session) == []
    assert client.post(created["endpoint"], headers=caller, json={"rows": ROWS}).status_code == 403
