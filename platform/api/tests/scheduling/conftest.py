import pytest

from app.models import Membership, Project
from app.permissions import AccountType, DEFAULT_ROLE_PERMISSIONS, Role
from app.scheduling.backend import FakeJobBackend


@pytest.fixture
def backend(app):
    b = FakeJobBackend()
    app.state.job_backend = b
    return b


@pytest.fixture
def admin(add_user):
    return add_user("admin01", AccountType.ADMIN)[1]


@pytest.fixture
def make_project(session):
    def _make(name, gpu_group="gpu-exclusive"):
        p = Project(name=name, gpu_group=gpu_group)
        session.add(p)
        session.commit()
        return p
    return _make


@pytest.fixture
def member(session, add_user):
    """建立專案成員並回傳其 headers。"""
    def _member(project, username, role=Role.RESEARCH_ASSISTANT):
        user, headers = add_user(username)
        session.add(Membership(user_id=user.id, project_id=project.id, role=role.value,
                               permissions=sorted(p.value for p in DEFAULT_ROLE_PERMISSIONS[role])))
        session.commit()
        return headers
    return _member
