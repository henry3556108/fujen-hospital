"""刪除專案時連帶清掉 Orthanc 影像與物件儲存檔案（影像與結構式資料）。採 outbox：資料庫先 commit，外部清理可重試。"""
import pytest
from sqlalchemy import func, select

from app import project_cleanup
from app.imaging.models import ImagingFile, ImagingInstance, ImagingStudy, ImportJob
from app.imaging.orthanc import OrthancError
from app.models import AuditLog, Project
from app.permissions import AccountType
from app.project_cleanup import StorageCleanupTask
from app.tabular_api.models import TabularDataset
from imaging_support import (make_nifti, orthanc, sop_uid, study_files,  # noqa: F401
                             upload as upload_imaging)
from tabular_helpers import schema_text, synth, upload as upload_csv  # noqa: F401


@pytest.fixture
def admin(add_user):
    return add_user("admin01", AccountType.ADMIN)[1]


def _project(client, admin, name):
    return client.post("/api/admin/projects", headers=admin, json={"name": name}).json()["id"]


def _count(session, model, **where):
    q = select(func.count()).select_from(model)
    for k, v in where.items():
        q = q.where(getattr(model, k) == v)
    return session.scalar(q)


def _fill(client, admin, pid, synth, schema_text, studies=(1, 2)):
    for no in studies:
        assert upload_imaging(client, admin, pid, study_files(no)).status_code == 201
    files = [("nifti/case01_image.nii.gz", make_nifti()), ("nifti/case01_label.nii.gz", make_nifti())]
    assert upload_imaging(client, admin, pid, files, kind="files").status_code == 201
    assert upload_csv(client, pid, admin, (synth / "cohort_01.csv").read_bytes(), schema_text, name="c1").status_code == 201


def _cleanup_audits(session):
    rows = session.scalars(select(AuditLog).where(AuditLog.action == "project.data_cleanup").order_by(AuditLog.id))
    return [(e.category, e.target, e.result, e.detail) for e in rows]


def test_delete_project_removes_orthanc_images_and_objects(client, admin, session, orthanc, store, synth, schema_text):
    pid = _project(client, admin, "P1")
    keep = _project(client, admin, "P2")
    _fill(client, admin, pid, synth, schema_text)
    _fill(client, admin, keep, synth, schema_text, studies=(3,))
    assert len(orthanc.instances) == 9 and len(store.list(f"projects/{pid}/")) == 5

    assert client.delete(f"/api/admin/projects/{pid}", headers=admin).status_code == 204

    assert store.list(f"projects/{pid}/") == []
    assert sorted(orthanc.instances) == sorted(sop_uid(3, s) for s in (1, 2, 3))     # 只剩另一個專案的影像
    assert len(store.list(f"projects/{keep}/")) == 5
    for model in (ImagingStudy, ImagingInstance, ImagingFile, ImportJob, TabularDataset):
        assert _count(session, model, project_id=pid) == 0, model.__name__
        assert _count(session, model, project_id=keep) > 0, model.__name__
    assert _count(session, StorageCleanupTask) == 0
    assert _cleanup_audits(session) == [
        ("dataset", f"project:{pid}", "success", {"objects_deleted": 5, "orthanc_deleted": 6, "failed": 0})]
    # 另一個專案照常可用
    assert len(client.get(f"/api/projects/{keep}/imaging/studies", headers=admin).json()) == 1
    assert len(client.get(f"/api/projects/{keep}/tabular/datasets", headers=admin).json()) == 1


def test_image_shared_with_another_project_stays_in_orthanc(client, admin, session, orthanc):
    """Orthanc 是跨專案共用的節點：同一張影像兩個專案都匯入時只存一份，還有專案引用就不能刪。"""
    a, b = _project(client, admin, "A"), _project(client, admin, "B")
    upload_imaging(client, admin, a, study_files(1) + study_files(2))
    upload_imaging(client, admin, b, study_files(1))

    assert client.delete(f"/api/admin/projects/{a}", headers=admin).status_code == 204

    assert sorted(orthanc.instances) == sorted(sop_uid(1, s) for s in (1, 2, 3))
    assert client.get(f"/api/projects/{b}/imaging/studies", headers=admin).json()[0]["instances"] == 3
    assert client.delete(f"/api/admin/projects/{b}", headers=admin).status_code == 204
    assert orthanc.instances == {}


def test_project_without_data_writes_no_cleanup_audit(client, admin, session, orthanc):
    pid = _project(client, admin, "empty")
    assert client.delete(f"/api/admin/projects/{pid}", headers=admin).status_code == 204
    assert _cleanup_audits(session) == [] and _count(session, StorageCleanupTask) == 0


def test_partial_failure_keeps_tasks_and_retries_later(client, admin, session, orthanc, store, synth, schema_text,
                                                       monkeypatch):
    """清理部分失敗：專案仍刪除成功（204），失敗的留在待清理清單並記稽核 partial；下一次刪除專案時重試。"""
    pid = _project(client, admin, "P1")
    _fill(client, admin, pid, synth, schema_text, studies=(1,))
    real_delete = orthanc.delete

    def flaky(sop):
        if sop == sop_uid(1, 2):
            raise OrthancError("無法連線影像節點：ConnectError")
        real_delete(sop)
    monkeypatch.setattr(orthanc, "delete", flaky)

    assert client.delete(f"/api/admin/projects/{pid}", headers=admin).status_code == 204

    assert client.get("/api/admin/projects", headers=admin).json() == []
    assert list(orthanc.instances) == [sop_uid(1, 2)] and store.list(f"projects/{pid}/") == []
    session.expire_all()
    [task] = session.scalars(select(StorageCleanupTask)).all()
    assert (task.kind, task.ref, task.project_id, task.attempts) == ("orthanc_instance", sop_uid(1, 2), pid, 1)
    assert "ConnectError" in task.last_error
    assert _cleanup_audits(session) == [
        ("dataset", f"project:{pid}", "partial", {"objects_deleted": 5, "orthanc_deleted": 2, "failed": 1})]

    monkeypatch.setattr(orthanc, "delete", real_delete)
    other = _project(client, admin, "P2")
    assert client.delete(f"/api/admin/projects/{other}", headers=admin).status_code == 204
    session.expire_all()
    assert orthanc.instances == {} and _count(session, StorageCleanupTask) == 0
    assert _cleanup_audits(session)[-1] == (
        "dataset", f"project:{pid}", "success", {"objects_deleted": 0, "orthanc_deleted": 1, "failed": 0})


def test_object_store_failure_is_retried(client, admin, session, orthanc, store, synth, schema_text, monkeypatch):
    pid = _project(client, admin, "P1")
    _fill(client, admin, pid, synth, schema_text, studies=(1,))
    real = store.delete
    calls = {"n": 0}

    def flaky(key):
        calls["n"] += 1
        if calls["n"] == 2:
            raise OSError("disk error")
        real(key)
    monkeypatch.setattr(store, "delete", flaky)
    assert client.delete(f"/api/admin/projects/{pid}", headers=admin).status_code == 204
    assert len(store.list(f"projects/{pid}/")) == 1
    session.expire_all()
    [task] = session.scalars(select(StorageCleanupTask)).all()
    assert (task.kind, task.ref) == ("object_prefix", f"projects/{pid}/")

    monkeypatch.setattr(store, "delete", real)
    result = project_cleanup.run_pending(session, store, orthanc, actor="admin01")
    assert result == {pid: {"objects_deleted": 1, "orthanc_deleted": 0, "failed": 0}}
    assert store.list(f"projects/{pid}/") == [] and _count(session, StorageCleanupTask) == 0


def test_retry_never_touches_data_that_is_in_use_again(client, admin, session, orthanc, store):
    """重試前重新檢查：影像之後又被別的專案匯入、或專案編號被重用（SQLite），就放棄該筆清理，不刪使用中的資料。"""
    session.add_all([
        StorageCleanupTask(kind="orthanc_instance", ref=sop_uid(1, 1), project_id=99, attempts=1),
        StorageCleanupTask(kind="object_prefix", ref="projects/1/", project_id=1, attempts=1),
    ])
    session.commit()
    pid = _project(client, admin, "reused")
    assert pid == 1
    upload_imaging(client, admin, pid, study_files(1))
    upload_imaging(client, admin, pid, [("nifti/case01_image.nii.gz", make_nifti())], kind="files")

    project_cleanup.run_pending(session, store, orthanc, actor="admin01")

    assert sop_uid(1, 1) in orthanc.instances and len(store.list("projects/1/")) == 1
    assert _count(session, StorageCleanupTask) == 0


def test_missing_image_node_leaves_tasks_pending(client, admin, session, orthanc, store):
    pid = _project(client, admin, "P1")
    upload_imaging(client, admin, pid, study_files(1))
    client.app.state.orthanc = None                       # 例如 ORTHANC_URL 未設定
    assert client.delete(f"/api/admin/projects/{pid}", headers=admin).status_code == 204
    session.expire_all()
    tasks = session.scalars(select(StorageCleanupTask)).all()
    assert len(tasks) == 3 and {t.kind for t in tasks} == {"orthanc_instance"}
    assert all("影像節點未設定" in t.last_error for t in tasks)


def test_tabular_frame_cache_is_evicted(client, admin, session, orthanc, synth, schema_text):
    """SQLite 會重用專案與資料集編號；刪除專案後快取也要清，否則新資料集會讀到舊內容。"""
    pid = _project(client, admin, "P1")
    raw = (synth / "cohort_01.csv").read_bytes()
    did = upload_csv(client, pid, admin, raw, schema_text, name="c1").json()["dataset"]["id"]
    assert client.get(f"/api/projects/{pid}/tabular/datasets/{did}", headers=admin).status_code == 200  # 進快取
    assert client.delete(f"/api/admin/projects/{pid}", headers=admin).status_code == 204
    assert client.app.state.tabular_frames._items == {}


def test_seed_reset_cleans_project_data(session, idp, orthanc, store, client, synth, schema_text):
    from app.seed import reset_and_seed

    idp.create_user("admin01", "Admin01-dev!")
    reset_and_seed(session, idp, admin_username="admin01", store=store, orthanc=orthanc)
    p1 = session.scalar(select(Project).where(Project.name == "P1-lung-ct"))
    from app.imaging import service
    service.import_dicom(session, orthanc, project_id=p1.id, actor="admin01", files=study_files(1))
    service.import_files(session, store, project_id=p1.id, actor="admin01",
                         files=[("nifti/case01_image.nii.gz", make_nifti())])
    assert len(orthanc.instances) == 3 and len(store.list("projects/")) == 1

    reset_and_seed(session, idp, admin_username="admin01", store=store, orthanc=orthanc)

    assert orthanc.instances == {} and store.list("projects/") == []
    assert _count(session, ImagingInstance) == 0 and _count(session, ImagingFile) == 0


def test_http_orthanc_delete_by_sop_uid():
    import httpx

    from app.imaging.orthanc import HttpOrthanc

    seen = []

    def handler(request):
        seen.append((request.method, request.url.path))
        if request.url.path == "/tools/find":
            return httpx.Response(200, json=["abc"])
        return httpx.Response(200, json={})

    HttpOrthanc("http://orthanc:8042", transport=httpx.MockTransport(handler)).delete("1.2.3")
    assert seen == [("POST", "/tools/find"), ("DELETE", "/instances/abc")]

    seen.clear()
    HttpOrthanc("http://orthanc:8042",
                transport=httpx.MockTransport(lambda r: httpx.Response(200, json=[]))).delete("1.2.3")   # 已不存在
