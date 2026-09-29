import json

import pytest

from app.llm.client import InMemoryLlmClient
from app.llm.services import LlmServices
from app.llm.sources import InMemoryModelSource, OfflinePreloadSource
from app.models import Membership, Project
from app.permissions import DEFAULT_ROLE_PERMISSIONS, AccountType, Role

HOST = "models.test.invalid"
TOKEN = "hf_test_valid_token"


@pytest.fixture
def source():
    s = InMemoryModelSource(valid_tokens={TOKEN})
    s.add("org/small", "a" * 40, {"config.json": b'{"model_type": "fake"}', "README.md": b"no weights"})
    s.add("org/gated", "b" * 40, {"config.json": b'{"model_type": "fake", "n": 2}'}, gated=True)
    s.add("org/remote-code", "c" * 40, {"config.json": b'{"auto_map": {"AutoModel": "m.M"}}', "m.py": b"class M: pass\n"})
    s.add("org/not-listed", "d" * 40, {"config.json": b"{}"})
    return s


@pytest.fixture
def preload(tmp_path, source):
    """離線預載目錄：放一份與來源相同內容的 org/small。"""
    root = tmp_path / "preload"
    folder = root / "small"
    folder.mkdir(parents=True)
    for name, data in source.repos["org/small"].files.items():
        (folder / name).write_bytes(data)
    (folder / "manifest.json").write_text(json.dumps({"repo": "org/small", "commit": "a" * 40}))
    return OfflinePreloadSource(root)


@pytest.fixture
def llm(app, source, preload, tmp_path):
    from app.llm.vectors import InMemoryVectorStore
    from app.llm.wiki import InMemoryWiki
    services = LlmServices(client=InMemoryLlmClient(), sources={HOST: source}, offline=preload,
                           model_dir=tmp_path / "models", vectors=InMemoryVectorStore(), wiki=InMemoryWiki())
    app.state.llm = services
    return services


@pytest.fixture
def admin(add_user):
    return add_user("admin01", AccountType.ADMIN)[1]


@pytest.fixture
def project(session):
    p = Project(name="P3-llm")
    session.add(p)
    session.commit()
    return p


@pytest.fixture
def member(session, add_user):
    def _member(project, username, role=Role.CODER_ASSISTANT):
        user, headers = add_user(username)
        session.add(Membership(user_id=user.id, project_id=project.id, role=role.value,
                               permissions=sorted(p.value for p in DEFAULT_ROLE_PERMISSIONS[role])))
        session.commit()
        return headers
    return _member


@pytest.fixture
def coder(project, member):
    return member(project, "ca01")


@pytest.fixture
def viewer(project, member):
    return member(project, "vw01", Role.VIEWER)


@pytest.fixture
def base(project):
    return f"/api/projects/{project.id}/llm"


@pytest.fixture
def whitelist(client, admin, source):
    """把來源上的模型登記進白名單（org/not-listed 除外）。"""
    def _add(name, repo, **extra):
        artifact = source.repos[repo]
        body = {"name": name, "source": HOST, "repo": repo, "revision": artifact.commit, "sha256": artifact.sha256,
                "license": "apache-2.0", **extra}
        response = client.post("/api/admin/llm/whitelist", headers=admin, json=body)
        assert response.status_code == 201, response.text
        return response.json()
    _add("small", "org/small")
    _add("gated", "org/gated", requires_token=True)
    _add("remote-code", "org/remote-code", has_remote_code=True)
    return _add


@pytest.fixture
def install(client, admin, coder, base):
    """申請 → 核准 → 執行下載，回傳下載紀錄。"""
    def _install(name, token=None, headers=None):
        headers = headers or coder
        requested = client.post(f"{base}/models/downloads", headers=headers, json={"name": name})
        assert requested.status_code == 201, requested.text
        download_id = requested.json()["id"]
        approved = client.post(f"/api/admin/llm/downloads/{download_id}/approve", headers=admin)
        assert approved.status_code == 200, approved.text
        done = client.post(f"{base}/models/downloads/{download_id}/execute", headers=headers, json={"token": token})
        assert done.status_code == 200, done.text
        return done.json()
    return _install
