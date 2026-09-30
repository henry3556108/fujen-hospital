"""後端缺口（docs/superpowers/plans/2026-09-30-backend-gaps.md）經 Gateway 的驗收。

需要 compose 堆疊加上 compose.fhir.yaml 與 seed 基線，並設定 COMPOSE_PROJECT（查 HAPI 資料庫、稽核表）：
    cd platform/deploy/local && docker compose -f compose.yaml -f compose.fhir.yaml up -d --build
    docker compose exec -T api /app/.venv/bin/python -m app.seed
    cd platform/acceptance && COMPOSE_PROJECT=ai-platform uv run pytest test_backend_gaps.py
"""
import json
import secrets

import pytest

import fhir_support as fs

pytestmark = pytest.mark.skipif(not fs.COMPOSE_PROJECT, reason="設定 COMPOSE_PROJECT 才能查 HAPI 資料庫與稽核表")
TAG = "urn:ai-platform:tenant"


def _project(api, admin, prefix):
    response = api.post("/api/admin/projects", headers=admin, json={"name": f"{prefix}-{secrets.token_hex(3)}"})
    assert response.status_code == 201, response.text
    return response.json()["id"]


def _patients_bundle(pid, mrns):
    return {"resourceType": "Bundle", "type": "transaction", "entry": [
        {"fullUrl": f"urn:uuid:{secrets.token_hex(4)}-0000-4000-8000-{secrets.token_hex(6)}",
         "resource": {"resourceType": "Patient", "meta": {"tag": [{"system": TAG, "code": str(pid)}]},
                      "identifier": [{"system": fs.MRN, "value": mrn}], "gender": "female"},
         "request": {"method": "PUT", "url": f"Patient?identifier={fs.MRN}|{mrn}&_tag={TAG}|{pid}"}}
        for mrn in mrns]}


def _hapi_rows(pid: int) -> int:
    """HAPI 資料庫裡屬於這個分割區的資源列（含已刪除的歷史版本）。"""
    return int(fs.psql("hapi", f"select count(*) from hfj_resource where partition_id = {pid};").strip())


def _partition_exists(pid: int) -> bool:
    return fs.psql("hapi", f"select count(*) from hfj_partition where part_id = {pid};").strip() == "1"


def test_project_delete_removes_fhir_tenant(api, auth):
    admin = auth("admin01")
    pid, keep = _project(api, admin, "gaps-fhir"), _project(api, admin, "gaps-fhir-keep")
    try:
        for project, mrns in ((pid, ["G1", "G2", "G3"]), (keep, ["G1"])):
            assert api.get(f"/api/projects/{project}/fhir/summary", headers=admin).status_code == 200  # 建立租戶
            written = api.post(f"/fhir/projects/{project}", headers={**admin, "Content-Type": "application/fhir+json"},
                               content=json.dumps(_patients_bundle(project, mrns)), timeout=60)
            assert written.status_code == 200, written.text
        assert api.get(f"/api/projects/{pid}/fhir/summary", headers=admin).json()["counts"]["Patient"] == 3
        assert _hapi_rows(pid) == 3 and _partition_exists(pid)

        assert api.delete(f"/api/admin/projects/{pid}", headers=admin, timeout=120).status_code == 204

        assert _hapi_rows(pid) == 0 and not _partition_exists(pid)          # 資源、歷史版本、分割區都清掉
        assert _hapi_rows(keep) == 1                                         # 其他租戶不受影響
        assert api.get(f"/api/projects/{keep}/fhir/summary", headers=admin).json()["counts"]["Patient"] == 1
        assert fs.psql("platform", f"select count(*) from storage_cleanup_tasks where project_id = {pid};").strip() == "0"
        audit = fs.psql("platform", "select result || ' ' || detail::text from audit_log "
                                    f"where action = 'project.data_cleanup' and target = 'project:{pid}';").strip()
        assert audit.startswith("success ") and json.loads(audit.split(" ", 1)[1])["fhir_deleted"] == 3
    finally:
        for project in (pid, keep):
            api.delete(f"/api/admin/projects/{project}", headers=admin, timeout=120)
