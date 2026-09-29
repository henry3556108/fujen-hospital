"""TC-D01-06 經 Gateway：上傳檔案掃毒。需以 compose.compliance.yaml 疊加檔啟動（clamd），並設定 COMPOSE_PROJECT。

EICAR 測試字串在執行時組出來，不存成檔案。
"""
import os
import subprocess
from pathlib import Path

import pytest

from tabular_support import p2, synth, upload  # noqa: F401

ROOT = Path(__file__).resolve().parents[1]
PROJECT = os.environ.get("COMPOSE_PROJECT")


def _scanner_configured() -> bool:
    if not PROJECT:
        return False
    out = subprocess.run(["docker", "compose", "-p", PROJECT, "exec", "-T", "api", "printenv", "CLAMAV_HOST"],
                         capture_output=True, text=True, timeout=60)
    return out.returncode == 0 and bool(out.stdout.strip())


pytestmark = pytest.mark.skipif(not _scanner_configured(),
                                reason="api 未設定 CLAMAV_HOST：以 compose.compliance.yaml 疊加檔啟動並設定 COMPOSE_PROJECT")


def eicar() -> bytes:
    return ("X5O!P%@AP[4\\PZX54(P^)7CC)7}$" + "EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*").encode("ascii")


def _sql(query: str) -> str:
    out = subprocess.run(["docker", "compose", "-p", PROJECT, "exec", "-T", "postgres", "psql", "-U", "platform",
                          "-d", "platform", "-tAc", query], capture_output=True, text=True, timeout=60)
    assert out.returncode == 0, out.stderr
    return out.stdout.strip()


def test_tc_d01_06_eicar_upload_is_blocked_clean_upload_passes(api, p2, synth, tmp_path):
    pid, pi, _, created = p2
    schema = (synth / "schema.json").read_text()
    infected = tmp_path / "eicar.csv"
    infected.write_bytes(eicar())
    before = int(_sql("select count(*) from audit_log where action = 'malware_blocked'"))
    response = upload(api, pid, pi, infected, schema, created)
    assert response.status_code == 422, response.text
    assert response.json()["detail"]["code"] == "malware_detected"
    assert "Eicar" in response.json()["detail"]["signature"]
    assert int(_sql("select count(*) from audit_log where action = 'malware_blocked'")) == before + 1
    clean = upload(api, pid, pi, synth / "cohort_01.csv", schema, created)
    assert clean.status_code == 201, clean.text


def test_tc_d01_06_eicar_imaging_file_fails_alone(api, auth):
    admin = auth("admin01")
    pid = next(p["id"] for p in api.get("/api/admin/projects", headers=admin).json() if p["name"] == "P1-lung-ct")
    ra = auth("ra01")
    files = [("files", ("scan/eicar_label.nii", eicar())), ("files", ("scan/notes.json", b"{}"))]
    job = api.post(f"/api/projects/{pid}/imaging/files", headers=ra, files=files, timeout=60).json()
    reasons = {f["filename"]: f.get("reason", "") for f in job["files"]}
    assert reasons["scan/eicar_label.nii"].startswith("掃毒攔截")
    assert not reasons["scan/notes.json"].startswith("掃毒攔截")
