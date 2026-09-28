"""WP3 測試共用：合成資料、專案成員、上傳。"""
import json
import subprocess
from pathlib import Path

import pytest

from app.models import Membership, Project

SYNTH_DIR = Path(__file__).resolve().parents[2] / "tools" / "synth"
PROJECT_ONLY = ["project", "prediction"]  # viewer
WITH_TRAINING = ["project", "training", "prediction"]


@pytest.fixture(scope="session")
def synth(tmp_path_factory) -> Path:
    """platform/tools/synth 產生的 3×100 列 CSV、bad.csv、bad_rows.json、schema.json。"""
    out = tmp_path_factory.mktemp("synth-tabular")
    subprocess.run(["uv", "run", "python", "-m", "synth", "tabular", "--out", str(out)],
                   cwd=SYNTH_DIR, check=True, capture_output=True)
    return out


@pytest.fixture
def schema_text(synth) -> str:
    return (synth / "schema.json").read_text()


@pytest.fixture
def member(session, add_user):
    """建立專案（若不存在）並加入一位成員，回傳 (project_id, headers)。"""

    def _member(username, permissions=WITH_TRAINING, project_name="P2-tabular"):
        project = session.query(Project).filter_by(name=project_name).one_or_none()
        if project is None:
            project = Project(name=project_name)
            session.add(project)
            session.flush()
        user, headers = add_user(username)
        session.add(Membership(user_id=user.id, project_id=project.id, role="research_assistant",
                               permissions=list(permissions)))
        session.commit()
        return project.id, headers

    return _member


def upload(client, pid, headers, csv_bytes: bytes, schema: str, name: str | None = None, filename="data.csv"):
    data = {"schema": schema}
    if name is not None:
        data["name"] = name
    return client.post(f"/api/projects/{pid}/tabular/datasets", headers=headers,
                       files={"file": (filename, csv_bytes, "text/csv")}, data=data)


@pytest.fixture
def dataset(client, member, synth, schema_text):
    """已上傳 cohort_01.csv 的資料集：回傳 (project_id, headers, dataset_id)。"""
    pid, headers = member("pi01")
    response = upload(client, pid, headers, (synth / "cohort_01.csv").read_bytes(), schema_text, name="cohort_01")
    assert response.status_code == 201, response.text
    return pid, headers, response.json()["dataset"]["id"]


def bad_rows(synth) -> set[int]:
    return {r["row"] for r in json.loads((synth / "bad_rows.json").read_text())["rows"]}
