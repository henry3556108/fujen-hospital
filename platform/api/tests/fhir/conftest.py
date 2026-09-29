import json
from pathlib import Path

import pytest

from app.models import Membership, Project
from app.permissions import AccountType, DEFAULT_ROLE_PERMISSIONS, Role

# 由 platform/tools/synth 以預設 seed 42 產生（clinical、vitals --count 100），內容是確定性的。
# 重新產生：cd platform/tools/synth && uv run python -m synth clinical --out ../../api/tests/fhir/data/clinical
DATA = Path(__file__).parent / "data"


@pytest.fixture(scope="session")
def clinical() -> Path:
    return DATA / "clinical"


@pytest.fixture(scope="session")
def hl7_messages(clinical) -> list[str]:
    return [p.read_bytes().decode("ascii") for p in sorted((clinical / "hl7").glob("*.hl7"))]


@pytest.fixture(scope="session")
def invalid_hl7(clinical) -> dict[str, str]:
    return {p.name: p.read_bytes().decode("ascii") for p in sorted((clinical / "invalid").glob("*.hl7"))}


@pytest.fixture(scope="session")
def vitals() -> list[dict]:
    lines = (DATA / "vitals" / "vitals.jsonl").read_text(encoding="utf-8").splitlines()
    return [json.loads(line) for line in lines if line.strip()]


@pytest.fixture
def admin(add_user):
    return add_user("admin01", AccountType.ADMIN)[1]


@pytest.fixture
def make_project(session):
    def _make(name):
        p = Project(name=name)
        session.add(p)
        session.commit()
        return p
    return _make


@pytest.fixture
def member(session, add_user):
    def _member(project, username, role=Role.RESEARCH_ASSISTANT):
        user, headers = add_user(username)
        session.add(Membership(user_id=user.id, project_id=project.id, role=role.value,
                               permissions=sorted(p.value for p in DEFAULT_ROLE_PERMISSIONS[role])))
        session.commit()
        return headers
    return _member
