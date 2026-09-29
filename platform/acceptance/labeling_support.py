"""WP5a 經 Gateway 驗收的共用工具：確保 P1 有影像、取得可存取的研究。"""
import json
import subprocess
from pathlib import Path

import httpx

from conftest import GATEWAY, login

ROOT = Path(__file__).resolve().parents[1]
SYNTH = ROOT / "tools" / "synth"


def headers(username: str) -> dict:
    return {"Authorization": f"Bearer {login(username)}"}


def p1_id(client: httpx.Client) -> int:
    rows = client.get("/api/admin/projects", headers=headers("admin01")).json()
    return next(p["id"] for p in rows if p["name"] == "P1-lung-ct")


def ensure_images(client: httpx.Client, pid: int, out: Path) -> list[dict]:
    """把合成的 20 個研究匯入 P1（已匯入的會判為重複），回傳目前看得到的研究。"""
    if not (out / "manifest.json").exists():
        subprocess.run(["uv", "run", "-q", "python", "-m", "synth", "dicom", "--out", str(out)], cwd=SYNTH,
                       check=True, capture_output=True)
    files = [("files", (str(p.relative_to(out)), p.read_bytes())) for p in sorted(out.rglob("*.dcm"))]
    r = client.post(f"/api/projects/{pid}/imaging/dicom", headers=headers("ra01"), files=files, timeout=120)
    assert r.status_code == 201, r.text
    assert r.json()["counts"]["failed"] == 0
    studies = client.get(f"/api/projects/{pid}/imaging/studies", headers=headers("ra01")).json()
    manifest = json.loads((out / "manifest.json").read_text())
    by_uid = {s["study_instance_uid"]: s for s in manifest["studies"]}
    for s in studies:
        s["sop_instance_uids"] = by_uid[s["study_instance_uid"]]["sop_instance_uids"]
    return studies


def gateway() -> httpx.Client:
    return httpx.Client(base_url=GATEWAY, timeout=60)
