"""技術債修正的整合驗證（經 Gateway，對真的 PostgreSQL、Orthanc、MinIO）。

需要 COMPOSE_PROJECT：用 docker compose exec 查資料庫、影像節點與物件儲存（這三者都不對主機開放）。
"""
import json
import os
import subprocess
import time
from pathlib import Path

import pytest

import platform_exec as pe

ROOT = Path(__file__).resolve().parents[1]
SYNTH = ROOT / "tools" / "synth"
PROJECT = os.environ.get("COMPOSE_PROJECT")

pytestmark = pytest.mark.skipif(not pe.AVAILABLE, reason=pe.REASON)


def _exec(service: str, *command: str) -> str:
    out = pe.exec_in(service, *command, timeout=120, check=False)
    assert out.returncode == 0, out.stdout + out.stderr
    return out.stdout.strip()


def _sql(query: str) -> str:
    return _exec("postgres", "psql", "-U", "platform", "-d", "platform", "-tAc", query)


def _api_python(code: str) -> str:
    return _exec("api", "/app/.venv/bin/python", "-c", code)


def _synth(out: Path, *args: str) -> Path:
    subprocess.run(["uv", "run", "python", "-m", "synth", *args, "--out", str(out)], cwd=SYNTH, check=True,
                   capture_output=True)
    return out


def test_project_delete_cleans_orthanc_and_object_storage(api, auth, tmp_path):
    admin = auth("admin01")
    seed = 1000 + time.time_ns() % 1_000_000                       # 每次執行都是平台上沒有的影像
    dicom = _synth(tmp_path / "dicom", "dicom", "--studies", "1", "--seed", str(seed))
    study = json.loads((dicom / "manifest.json").read_text())["studies"][0]
    nifti = sorted(_synth(tmp_path / "nifti", "nifti").rglob("*.nii.gz"))[:2]
    tabular = _synth(tmp_path / "tabular", "tabular")

    pid = api.post("/api/admin/projects", headers=admin, json={"name": f"debt-{time.time_ns()}"}).json()["id"]
    slices = sorted(dicom.rglob("*.dcm"))
    for prefix in ("", "again/"):                                  # 第二次是重複影像，只補記路徑
        job = api.post(f"/api/projects/{pid}/imaging/dicom", headers=admin, timeout=120,
                       files=[("files", (prefix + str(p.relative_to(dicom)), p.read_bytes())) for p in slices])
        assert job.status_code == 201 and job.json()["counts"]["failed"] == 0, job.text
    assert job.json()["counts"]["duplicate"] == len(slices)
    files = api.post(f"/api/projects/{pid}/imaging/files", headers=admin, timeout=120,
                     files=[("files", (f"nifti/{p.name}", p.read_bytes())) for p in nifti])
    assert files.status_code == 201 and files.json()["counts"]["imported"] == 2, files.text
    csv = api.post(f"/api/projects/{pid}/tabular/datasets", headers=admin, timeout=60,
                   files={"file": ("cohort_01.csv", (tabular / "cohort_01.csv").read_bytes(), "text/csv")},
                   data={"schema": (tabular / "schema.json").read_text(), "name": "c1"})
    assert csv.status_code == 201, csv.text

    uid = study["study_instance_uid"]
    count_images = ("import os; from app.imaging.orthanc import orthanc_from_env; "
                    f"print(len(orthanc_from_env(os.environ).study_instances('{uid}')))")
    count_objects = ("import os; from app.storage import store_from_env; "
                     f"print(len(store_from_env(os.environ).list('projects/{pid}/')))")
    assert _api_python(count_images) == str(len(slices))
    assert _api_python(count_objects) == "5"                       # NIfTI 2 個＋CSV 的原始檔、乾淨檔、報告

    assert api.delete(f"/api/admin/projects/{pid}", headers=admin).status_code == 204

    assert _api_python(count_images) == "0"
    assert _api_python(count_objects) == "0"
    for table in ("imaging_studies", "imaging_instances", "imaging_instance_sources", "imaging_files",
                  "tabular_datasets"):
        assert _sql(f"select count(*) from {table} where project_id = {pid}") == "0", table
    assert _sql(f"select count(*) from storage_cleanup_tasks where project_id = {pid}") == "0"
    audit = _sql("select result || ' ' || detail::text from audit_log "
                 f"where action = 'project.data_cleanup' and target = 'project:{pid}'")
    result, detail = audit.split(" ", 1)
    assert result == "success"
    # 堆疊有 FHIR 時多一個 fhir_deleted（這個專案沒有 FHIR 資料：0）
    assert json.loads(detail) in ({"objects_deleted": 5, "orthanc_deleted": len(slices), "failed": 0},
                                  {"objects_deleted": 5, "orthanc_deleted": len(slices), "failed": 0, "fhir_deleted": 0})


def test_api_storage_account_is_not_root():
    """平台 API 用的物件儲存帳號只能讀寫自己的 bucket：不能建 bucket、不能列出其他 bucket、不能做管理動作。"""
    code = r'''
import os
from minio import Minio, MinioAdmin
from minio.credentials import StaticProvider
from minio.error import S3Error, MinioAdminException

e = os.environ
assert "MINIO_ROOT_USER" not in e and "MINIO_ROOT_PASSWORD" not in e, "api 容器不應拿到 root 金鑰"
c = Minio(e["S3_ENDPOINT"], access_key=e["S3_ACCESS_KEY"], secret_key=e["S3_SECRET_KEY"], secure=False)
c.put_object(e["S3_BUCKET"], "selfcheck/probe.txt", __import__("io").BytesIO(b"ok"), length=2)
assert c.get_object(e["S3_BUCKET"], "selfcheck/probe.txt").read() == b"ok"
c.remove_object(e["S3_BUCKET"], "selfcheck/probe.txt")
denied = []
for name, call in [("make_bucket", lambda: c.make_bucket("debt-should-not-exist")),
                   ("remove_bucket", lambda: c.remove_bucket(e["S3_BUCKET"])),
                   ("other_bucket", lambda: list(c.list_objects("some-other-bucket")))]:
    try:
        call()
    except S3Error as exc:
        denied.append((name, exc.code))
admin = MinioAdmin(endpoint=e["S3_ENDPOINT"], credentials=StaticProvider(e["S3_ACCESS_KEY"], e["S3_SECRET_KEY"]),
                   secure=False)
try:
    admin.user_list()
except MinioAdminException as exc:
    denied.append(("admin_user_list", "denied"))
print(denied)
'''
    out = _api_python(code)
    assert out == ("[('make_bucket', 'AccessDenied'), ('remove_bucket', 'AccessDenied'), "
                   "('other_bucket', 'AccessDenied'), ('admin_user_list', 'denied')]"), out
    assert _exec("api", "printenv", "S3_ACCESS_KEY") == "platform-api"
