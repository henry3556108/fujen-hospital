"""TC-B01-10、TC-B04 經 Gateway 驗收的共用 fixture。

前提：本機整合環境已用含 WP3 的 API 映像啟動並執行過種子（見 platform/deploy/local/README.md）。
執行：cd platform/acceptance && uv run pytest -q test_tc_b01_10.py test_tc_b04.py

測試會暫時把 pi01（principal_investigator）與 vw01（viewer）加入 P2-tabular，
上傳的資料集與成員資格在結束時移除，可重複執行。
"""
import json
import subprocess
import time
from pathlib import Path

import pytest

SYNTH_DIR = Path(__file__).resolve().parents[1] / "tools" / "synth"
PROJECT = "P2-tabular"


@pytest.fixture(scope="session")
def synth(tmp_path_factory) -> Path:
    out = tmp_path_factory.mktemp("synth-tabular")
    subprocess.run(["uv", "run", "python", "-m", "synth", "tabular", "--out", str(out)],
                   cwd=SYNTH_DIR, check=True, capture_output=True)
    return out


@pytest.fixture
def p2(api, auth):
    """回傳 (project_id, pi01 headers, vw01 headers, uploaded ids)；結束時清理。"""
    admin = auth("admin01")
    pid = next(p["id"] for p in api.get("/api/admin/projects", headers=admin).json() if p["name"] == PROJECT)
    users = {u["username"]: u["id"] for u in api.get("/api/admin/users", headers=admin).json()}
    roles = {"pi01": "principal_investigator", "vw01": "viewer"}
    for username, role in roles.items():
        r = api.put(f"/api/admin/projects/{pid}/members/{users[username]}", headers=admin, json={"role": role})
        assert r.status_code == 200, r.text
    pi, vw = auth("pi01"), auth("vw01")
    created: list[int] = []
    try:
        yield pid, pi, vw, created
    finally:
        for did in created:
            api.delete(f"/api/projects/{pid}/tabular/datasets/{did}", headers=pi)
        for username in roles:
            api.delete(f"/api/admin/projects/{pid}/members/{users[username]}", headers=admin)


def upload(api, pid, headers, path: Path, schema: str, created: list[int]):
    name = f"{path.stem}-{time.time_ns()}"
    response = api.post(f"/api/projects/{pid}/tabular/datasets", headers=headers,
                        files={"file": (path.name, path.read_bytes(), "text/csv")},
                        data={"schema": schema, "name": name}, timeout=60)
    if response.status_code == 201:
        created.append(response.json()["dataset"]["id"])
    return response


def bad_rows(synth: Path) -> set[int]:
    return {r["row"] for r in json.loads((synth / "bad_rows.json").read_text())["rows"]}
