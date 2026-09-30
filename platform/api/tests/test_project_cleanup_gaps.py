"""刪專案時的外部清理（續）：HAPI 的 FHIR 租戶、叢集中排隊／執行中的工作。沿用 app.project_cleanup 的待清理清單與重試。"""
import pytest
from sqlalchemy import func, select

from app.fhir.client import InMemoryFhir
from app.models import AuditLog
from app.permissions import AccountType
from app.project_cleanup import StorageCleanupTask

TAG = "urn:ai-platform:tenant"


@pytest.fixture
def admin(add_user):
    return add_user("admin01", AccountType.ADMIN)[1]


@pytest.fixture
def fhir(app):
    app.state.fhir = InMemoryFhir()
    return app.state.fhir


def _project(client, admin, name, **extra):
    r = client.post("/api/admin/projects", headers=admin, json={"name": name, **extra})
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _patients(fhir, tenant, *mrns):
    fhir.ensure_tenant(tenant)
    fhir.transaction(tenant, {"resourceType": "Bundle", "type": "transaction", "entry": [
        {"resource": {"resourceType": "Patient", "meta": {"tag": [{"system": TAG, "code": str(tenant)}]},
                      "identifier": [{"system": "urn:mrn", "value": m}]},
         "request": {"method": "PUT", "url": f"Patient?identifier=urn:mrn|{m}&_tag={TAG}|{tenant}"}}
        for m in mrns]})


def _tasks(session):
    session.expire_all()
    return [(t.kind, t.ref, t.project_id, t.attempts)
            for t in session.scalars(select(StorageCleanupTask).order_by(StorageCleanupTask.id))]


def _cleanup_audits(session):
    rows = session.scalars(select(AuditLog).where(AuditLog.action == "project.data_cleanup").order_by(AuditLog.id))
    return [(e.target, e.result, e.detail) for e in rows]


# ---------- 第 1 項：FHIR 租戶 ----------

def test_delete_project_removes_fhir_tenant(client, admin, session, fhir):
    pid, keep = _project(client, admin, "P1"), _project(client, admin, "P2")
    _patients(fhir, pid, "A", "B", "C")
    _patients(fhir, keep, "A")

    assert client.delete(f"/api/admin/projects/{pid}", headers=admin).status_code == 204

    assert fhir.tenants() == [keep] and fhir.count(keep, "Patient") == 1
    assert _tasks(session) == []
    assert _cleanup_audits(session) == [
        (f"project:{pid}", "success", {"objects_deleted": 0, "orthanc_deleted": 0, "failed": 0, "fhir_deleted": 3})]


def test_project_that_never_used_fhir_writes_no_cleanup_audit(client, admin, session, fhir):
    pid = _project(client, admin, "empty")
    assert client.delete(f"/api/admin/projects/{pid}", headers=admin).status_code == 204
    assert _tasks(session) == [] and _cleanup_audits(session) == []


def test_fhir_cleanup_failure_is_kept_and_retried(client, admin, session, fhir):
    pid = _project(client, admin, "P1")
    _patients(fhir, pid, "A", "B")
    fhir.offline = True

    assert client.delete(f"/api/admin/projects/{pid}", headers=admin).status_code == 204   # 專案照樣刪除

    assert client.get("/api/admin/projects", headers=admin).json() == []
    assert _tasks(session) == [("fhir_tenant", str(pid), pid, 1)]
    assert _cleanup_audits(session) == [
        (f"project:{pid}", "partial", {"objects_deleted": 0, "orthanc_deleted": 0, "failed": 1})]
    assert fhir._tenants[pid]                                       # 資料還在，等重試

    fhir.offline = False
    other = _project(client, admin, "P2")
    assert client.delete(f"/api/admin/projects/{other}", headers=admin).status_code == 204
    assert fhir.tenants() == [] and _tasks(session) == []
    assert _cleanup_audits(session)[-1] == (
        f"project:{pid}", "success", {"objects_deleted": 0, "orthanc_deleted": 0, "failed": 0, "fhir_deleted": 2})


def test_without_fhir_configured_no_fhir_task_is_staged(client, admin, session, monkeypatch):
    monkeypatch.delenv("FHIR_URL", raising=False)
    pid = _project(client, admin, "P1")
    assert client.delete(f"/api/admin/projects/{pid}", headers=admin).status_code == 204
    assert _tasks(session) == []


def test_fhir_url_from_environment_is_used(client, admin, session, monkeypatch):
    """app.state 還沒有 FHIR 客戶端（沒人呼叫過 FHIR API）時，依 FHIR_URL 建立，與 FHIR 路由相同。"""
    import app.project_cleanup as cleanup
    created = []

    def fake_from_env():
        created.append(InMemoryFhir())
        return created[-1]
    monkeypatch.setattr(cleanup, "fhir_from_env", fake_from_env)
    pid = _project(client, admin, "P1")
    assert client.delete(f"/api/admin/projects/{pid}", headers=admin).status_code == 204
    assert len(created) == 1 and client.app.state.fhir is created[0] and _tasks(session) == []


def test_reused_project_id_skips_fhir_cleanup(client, admin, session, fhir):
    """SQLite 會重用專案編號：重試時該編號已屬於新專案，不可刪到新專案的 FHIR 資料。"""
    from app import project_cleanup
    pid = _project(client, admin, "P1")
    fhir.offline = True
    assert client.delete(f"/api/admin/projects/{pid}", headers=admin).status_code == 204
    fhir.offline = False
    again = _project(client, admin, "P1-new")
    assert again == pid
    _patients(fhir, again, "NEW")
    project_cleanup.run_pending(session, None, None, actor="admin01", fhir=fhir)
    assert fhir.count(again, "Patient") == 1 and _tasks(session) == []


def test_seed_reset_cleans_fhir_tenants(session, idp, fhir, store):
    from app.models import Project
    from app.seed import reset_and_seed
    idp.create_user("admin01", "Admin01-dev!")
    reset_and_seed(session, idp, admin_username="admin01", store=store, fhir=fhir)
    ids = session.scalars(select(Project.id)).all()
    for pid in ids:
        _patients(fhir, pid, "A")

    reset_and_seed(session, idp, admin_username="admin01", store=store, fhir=fhir)

    assert not set(ids) & set(fhir.tenants())
    assert session.scalar(select(func.count()).select_from(StorageCleanupTask)) == 0
