# WP1a 平台 API 核心 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立平台唯一的自研後端骨幹：驗證 Keycloak 簽發的 token、管理專案／帳號／角色／權限、每個寫入動作寫稽核，並提供 Gateway 用的授權檢查端點。

**Architecture:** FastAPI 模組化單體。權限存在平台資料庫，每次請求即時查詢（不寫進 token），所以權限變更立即生效。Keycloak 只負責帳號、密碼與登入，平台透過 `IdentityProvider` 介面呼叫它；測試用記憶體版實作。稽核是同一個資料庫的一張表，和業務變更在同一個交易內寫入。

**Tech Stack:** Python 3.12、uv、FastAPI、SQLAlchemy 2、PyJWT（RS256）、httpx、pytest；本機整合：Docker Compose（PostgreSQL 16、Keycloak 26、APISIX 3.11）。

**Spec:** Claude Doc「MacBook 開發機實作計畫」的「架構」「資料流」兩節；驗收案例 `docs/test-cases/acceptance-test-cases.md` 的 TC-SS、TC-A03。

## Global Constraints

- Python `>=3.12`，套件管理只用 `uv`；所有指令在 `platform/api/` 下以 `uv run` 執行。
- 權限 5 項固定為：`project`、`training`、`labeling`、`coding`、`prediction`。
- 角色 5 種固定為：`viewer`、`coder_assistant`、`research_assistant`、`medical_doctor`、`principal_investigator`；帳號類型：`admin`、`user`。
- 稽核類別 8 種固定為：`account`、`role`、`permission`、`project`、`dataset`、`training`、`inference`、`data_exchange`。
- 稽核只能新增與查詢，平台不提供修改或刪除稽核的 API。
- 所有錯誤訊息用繁體中文；HTTP 狀態：未登入 401、無權限 403、不存在 404、重複 409、格式錯誤 422。
- 單元測試用 SQLite 記憶體資料庫；正式與整合環境用 PostgreSQL。
- 測試函式名稱帶驗收案例 ID（例：`test_tc_a03_06_permission_takes_effect_immediately`）。

## Review Focus

1. **帳號被刪除後，手上還沒過期的 token** → 必須立刻 401，不能等 token 過期（Task 4 測試）。
2. **Admin 刪除自己或降級最後一個 Admin** → 409 拒絕，避免平台失去管理者（Task 7 測試）。
3. **設定權限時帶入不存在的權限字串** → 422，不能寫進資料庫（Task 8 測試）。
4. **授權端點的路徑技巧**：`/api/projects/2/../1/training`、URL 編碼、查詢字串 → 先正規化再比對，不能被繞過（Task 9 測試）。
5. **重複的帳號名稱或專案名稱** → 409，不是 500（Task 6、Task 7 測試）。

## File Structure

```
platform/api/
  pyproject.toml            依賴與 pytest 設定
  Dockerfile                整合環境用映像（Task 11）
  app/
    main.py                 create_app()：組裝 FastAPI、例外處理、路由
    asgi.py                 正式進入點：從環境變數組裝（Task 11）
    settings.py             讀取環境變數（Task 11）
    db.py                   engine 與 sessionmaker
    models.py               User、Project、Membership、AuditLog
    permissions.py          權限、角色、帳號類型與角色預設權限
    audit.py                稽核類別與 record()
    identity.py             Identity、JwtVerifier、IdentityProvider（記憶體版、Keycloak 版）
    deps.py                 FastAPI 相依：session、目前使用者、require_admin
    authz.py                effective_permissions()、路徑規則 match_rule()
    admin_service.py        專案、帳號、成員資格的業務邏輯（路由與種子共用）
    seed.py                 測試基線種子資料（Task 10）
    routers/
      admin.py              /api/admin/*
      me.py                 /api/me
      authz_check.py        /authz/check（給 Gateway forward-auth）
  tests/
    conftest.py
    test_health.py  test_permissions.py  test_audit.py  test_identity.py
    test_authz.py  test_admin_projects.py  test_admin_users.py
    test_memberships.py  test_authz_check.py  test_seed.py
platform/deploy/local/        Compose、Keycloak realm、APISIX 設定（Task 11）
platform/acceptance/          經 Gateway 的驗收測試（Task 12）
```

---

### Task 1: 程式庫骨架與健康檢查

**Files:**
- Create: `.gitignore`、`platform/api/pyproject.toml`、`platform/api/app/__init__.py`、`platform/api/app/main.py`、`platform/api/app/routers/__init__.py`、`platform/api/tests/conftest.py`、`platform/api/tests/test_health.py`

**Interfaces:**
- Produces: `create_app(*, database_url: str = "sqlite://", verifier=None, idp=None) -> FastAPI`；`GET /healthz -> {"status": "ok"}`

- [ ] **Step 1: 初始化 git 與專案**

```bash
cd /Users/hongyicheng/Downloads/ai-platform-architecture
git init
mkdir -p platform/api/app/routers platform/api/tests
touch platform/api/app/__init__.py platform/api/app/routers/__init__.py
```

`.gitignore`：

```
.venv/
__pycache__/
*.pyc
.pytest_cache/
platform/acceptance/reports/
.env
```

`platform/api/pyproject.toml`：

```toml
[project]
name = "ai-platform-api"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = [
    "fastapi>=0.115",
    "uvicorn[standard]>=0.30",
    "sqlalchemy>=2.0",
    "pydantic>=2.7",
    "pyjwt[crypto]>=2.9",
    "httpx>=0.27",
    "psycopg[binary]>=3.2",
]

[dependency-groups]
dev = ["pytest>=8"]

[tool.pytest.ini_options]
testpaths = ["tests"]
pythonpath = ["."]
```

- [ ] **Step 2: 寫失敗的測試**

`platform/api/tests/conftest.py`：

```python
import pytest
from fastapi.testclient import TestClient

from app.main import create_app


@pytest.fixture
def app():
    return create_app(database_url="sqlite://")


@pytest.fixture
def client(app):
    return TestClient(app)
```

`platform/api/tests/test_health.py`：

```python
def test_healthz(client):
    response = client.get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
```

- [ ] **Step 3: 執行，確認失敗**

Run: `cd platform/api && uv sync && uv run pytest tests/test_health.py -v`
Expected: FAIL，`ModuleNotFoundError: No module named 'app.main'`

- [ ] **Step 4: 最小實作**

`platform/api/app/main.py`：

```python
from fastapi import FastAPI


def create_app(*, database_url: str = "sqlite://", verifier=None, idp=None) -> FastAPI:
    app = FastAPI(title="AI Platform API")

    @app.get("/healthz")
    def healthz() -> dict:
        return {"status": "ok"}

    return app
```

- [ ] **Step 5: 執行，確認通過**

Run: `uv run pytest -v`
Expected: 1 passed

- [ ] **Step 6: Commit**

```bash
git add .gitignore platform/api
git commit -m "feat(api): scaffold platform API with health check"
```

---

### Task 2: 權限、角色與角色預設權限

**Files:**
- Create: `platform/api/app/permissions.py`、`platform/api/tests/test_permissions.py`

**Interfaces:**
- Produces: `Permission`、`Role`、`AccountType`（皆為 `StrEnum`）；`DEFAULT_ROLE_PERMISSIONS: dict[Role, frozenset[Permission]]`

- [ ] **Step 1: 寫失敗的測試**

```python
from app.permissions import DEFAULT_ROLE_PERMISSIONS, AccountType, Permission, Role


def test_five_permissions_and_roles():
    assert {p.value for p in Permission} == {"project", "training", "labeling", "coding", "prediction"}
    assert {r.value for r in Role} == {
        "viewer", "coder_assistant", "research_assistant", "medical_doctor", "principal_investigator",
    }
    assert {a.value for a in AccountType} == {"admin", "user"}


def test_tc_a03_04_every_role_has_defaults():
    assert set(DEFAULT_ROLE_PERMISSIONS) == set(Role)
    for perms in DEFAULT_ROLE_PERMISSIONS.values():
        assert Permission.PROJECT in perms


def test_role_defaults_match_baseline():
    P = Permission
    assert DEFAULT_ROLE_PERMISSIONS[Role.VIEWER] == {P.PROJECT, P.PREDICTION}
    assert DEFAULT_ROLE_PERMISSIONS[Role.MEDICAL_DOCTOR] == {P.PROJECT, P.LABELING, P.PREDICTION}
    assert DEFAULT_ROLE_PERMISSIONS[Role.RESEARCH_ASSISTANT] == {P.PROJECT, P.LABELING, P.TRAINING, P.PREDICTION}
    assert DEFAULT_ROLE_PERMISSIONS[Role.CODER_ASSISTANT] == {P.PROJECT, P.TRAINING, P.CODING, P.PREDICTION}
    assert DEFAULT_ROLE_PERMISSIONS[Role.PRINCIPAL_INVESTIGATOR] == set(P)
```

- [ ] **Step 2: 執行，確認失敗**

Run: `uv run pytest tests/test_permissions.py -v`
Expected: FAIL，`No module named 'app.permissions'`

- [ ] **Step 3: 實作**

```python
from enum import StrEnum


class Permission(StrEnum):
    PROJECT = "project"
    TRAINING = "training"
    LABELING = "labeling"
    CODING = "coding"
    PREDICTION = "prediction"


class Role(StrEnum):
    VIEWER = "viewer"
    CODER_ASSISTANT = "coder_assistant"
    RESEARCH_ASSISTANT = "research_assistant"
    MEDICAL_DOCTOR = "medical_doctor"
    PRINCIPAL_INVESTIGATOR = "principal_investigator"


class AccountType(StrEnum):
    ADMIN = "admin"
    USER = "user"


_P = Permission

# 角色預設權限，需與甲方確認；加入專案時套用，之後可逐人調整。
DEFAULT_ROLE_PERMISSIONS: dict[Role, frozenset[Permission]] = {
    Role.VIEWER: frozenset({_P.PROJECT, _P.PREDICTION}),
    Role.MEDICAL_DOCTOR: frozenset({_P.PROJECT, _P.LABELING, _P.PREDICTION}),
    Role.RESEARCH_ASSISTANT: frozenset({_P.PROJECT, _P.LABELING, _P.TRAINING, _P.PREDICTION}),
    Role.CODER_ASSISTANT: frozenset({_P.PROJECT, _P.TRAINING, _P.CODING, _P.PREDICTION}),
    Role.PRINCIPAL_INVESTIGATOR: frozenset(_P),
}
```

- [ ] **Step 4: 執行，確認通過**

Run: `uv run pytest -v`
Expected: all passed

- [ ] **Step 5: Commit**

```bash
git add platform/api/app/permissions.py platform/api/tests/test_permissions.py
git commit -m "feat(api): define permissions, roles and role defaults"
```

---

### Task 3: 資料模型與稽核寫入

**Files:**
- Create: `platform/api/app/models.py`、`platform/api/app/db.py`、`platform/api/app/audit.py`、`platform/api/tests/test_audit.py`
- Modify: `platform/api/app/main.py`、`platform/api/tests/conftest.py`

**Interfaces:**
- Produces:
  - `models.User(id, username, account_type, idp_subject)`、`Project(id, name, description, gpu_group)`、`Membership(id, user_id, project_id, role, permissions: list[str])`、`AuditLog(id, at, actor, category, action, target, result, source_ip, detail)`
  - `db.make_engine(url)`、`db.make_sessionmaker(engine)`
  - `audit.AuditCategory`（8 類）；`audit.record(session, *, actor: str, category: AuditCategory, action: str, target: str, result: str = "success", source_ip: str | None = None, detail: dict | None = None) -> AuditLog`（只 `add`，由呼叫端 commit）
  - `app.state.sessionmaker`

- [ ] **Step 1: 寫失敗的測試**

在 `conftest.py` 末端加入：

```python
@pytest.fixture
def session(app):
    with app.state.sessionmaker() as s:
        yield s
```

`platform/api/tests/test_audit.py`：

```python
from sqlalchemy import select

from app.audit import AuditCategory, record
from app.models import AuditLog


def test_eight_audit_categories():
    assert {c.value for c in AuditCategory} == {
        "account", "role", "permission", "project", "dataset", "training", "inference", "data_exchange",
    }


def test_tc_ss_06_audit_record_has_required_fields(session):
    record(session, actor="admin01", category=AuditCategory.PROJECT, action="create",
           target="project:1", source_ip="10.0.0.5", detail={"name": "P1"})
    session.commit()

    entry = session.scalars(select(AuditLog)).one()
    assert entry.actor == "admin01"
    assert entry.category == "project"
    assert entry.action == "create"
    assert entry.target == "project:1"
    assert entry.result == "success"
    assert entry.source_ip == "10.0.0.5"
    assert entry.detail == {"name": "P1"}
    assert entry.at is not None


def test_audit_is_part_of_caller_transaction(session):
    record(session, actor="admin01", category=AuditCategory.ACCOUNT, action="create", target="user:9")
    session.rollback()
    assert session.scalars(select(AuditLog)).all() == []
```

- [ ] **Step 2: 執行，確認失敗**

Run: `uv run pytest tests/test_audit.py -v`
Expected: FAIL，`No module named 'app.audit'`

- [ ] **Step 3: 實作**

`platform/api/app/models.py`：

```python
from datetime import datetime, timezone

from sqlalchemy import JSON, DateTime, ForeignKey, String, UniqueConstraint
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True)
    account_type: Mapped[str] = mapped_column(String(16))
    idp_subject: Mapped[str] = mapped_column(String(64), unique=True)


class Project(Base):
    __tablename__ = "projects"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(128), unique=True)
    description: Mapped[str] = mapped_column(String(1024), default="")
    gpu_group: Mapped[str | None] = mapped_column(String(64), default=None)


class Membership(Base):
    __tablename__ = "memberships"
    __table_args__ = (UniqueConstraint("user_id", "project_id"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"))
    role: Mapped[str] = mapped_column(String(32))
    permissions: Mapped[list[str]] = mapped_column(JSON)


class AuditLog(Base):
    __tablename__ = "audit_log"
    id: Mapped[int] = mapped_column(primary_key=True)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    actor: Mapped[str] = mapped_column(String(64))
    category: Mapped[str] = mapped_column(String(32), index=True)
    action: Mapped[str] = mapped_column(String(64))
    target: Mapped[str] = mapped_column(String(128))
    result: Mapped[str] = mapped_column(String(16))
    source_ip: Mapped[str | None] = mapped_column(String(64), default=None)
    detail: Mapped[dict] = mapped_column(JSON, default=dict)
```

`platform/api/app/db.py`：

```python
from sqlalchemy import create_engine
from sqlalchemy.engine import Engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool


def make_engine(url: str) -> Engine:
    if url.startswith("sqlite"):
        return create_engine(url, connect_args={"check_same_thread": False}, poolclass=StaticPool)
    return create_engine(url, pool_pre_ping=True)


def make_sessionmaker(engine: Engine) -> sessionmaker:
    return sessionmaker(engine, expire_on_commit=False)
```

`platform/api/app/audit.py`：

```python
from enum import StrEnum

from sqlalchemy.orm import Session

from app.models import AuditLog


class AuditCategory(StrEnum):
    ACCOUNT = "account"
    ROLE = "role"
    PERMISSION = "permission"
    PROJECT = "project"
    DATASET = "dataset"
    TRAINING = "training"
    INFERENCE = "inference"
    DATA_EXCHANGE = "data_exchange"


def record(
    session: Session,
    *,
    actor: str,
    category: AuditCategory,
    action: str,
    target: str,
    result: str = "success",
    source_ip: str | None = None,
    detail: dict | None = None,
) -> AuditLog:
    """寫入一筆稽核。只 add，不 commit：與業務變更同一個交易，一起成功或一起失敗。"""
    entry = AuditLog(
        actor=actor, category=category.value, action=action, target=target,
        result=result, source_ip=source_ip, detail=detail or {},
    )
    session.add(entry)
    return entry
```

`platform/api/app/main.py` 改為：

```python
from fastapi import FastAPI

from app.db import make_engine, make_sessionmaker
from app.models import Base


def create_app(*, database_url: str = "sqlite://", verifier=None, idp=None) -> FastAPI:
    engine = make_engine(database_url)
    Base.metadata.create_all(engine)

    app = FastAPI(title="AI Platform API")
    app.state.sessionmaker = make_sessionmaker(engine)
    app.state.verifier = verifier
    app.state.idp = idp

    @app.get("/healthz")
    def healthz() -> dict:
        return {"status": "ok"}

    return app
```

- [ ] **Step 4: 執行，確認通過**

Run: `uv run pytest -v`
Expected: all passed

- [ ] **Step 5: Commit**

```bash
git add platform/api
git commit -m "feat(api): add data model and transactional audit log"
```

---

### Task 4: 身分驗證（JWT）與目前使用者

**Files:**
- Create: `platform/api/app/identity.py`、`platform/api/app/deps.py`、`platform/api/app/routers/me.py`、`platform/api/tests/test_identity.py`
- Modify: `platform/api/app/main.py`、`platform/api/tests/conftest.py`（整份替換）

**Interfaces:**
- Consumes: `models.User`、`app.state.sessionmaker`
- Produces:
  - `identity.Identity(subject: str, username: str)`；`identity.TokenError`
  - `identity.JwtVerifier(issuer: str, audience: str, key_resolver: Callable[[str], Any])`，`.verify(token: str) -> Identity`
  - `identity.IdentityProvider`（Protocol）：`create_user(username, password) -> str`、`delete_user(subject) -> None`、`reset_password(subject, new_password) -> None`、`find_subject(username) -> str | None`
  - `identity.InMemoryIdentityProvider`（另有 `check_password(username, password) -> bool` 供測試）
  - `deps.get_session`、`deps.current_identity`、`deps.current_user`、`deps.require_admin`、`deps.client_ip(request) -> str | None`
  - `GET /api/me`（本 Task 先回傳 `{"username", "account_type"}`，Task 8 擴充）
- 測試 fixture：`make_token(sub, username=None, *, expires_in=300, issuer=ISSUER, audience=AUDIENCE, key=None)`、`idp`、`add_user(username, account_type=AccountType.USER) -> (User, headers)`

- [ ] **Step 1: 替換 conftest 並寫失敗的測試**

`platform/api/tests/conftest.py`（整份）：

```python
import time

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

from app.identity import InMemoryIdentityProvider, JwtVerifier
from app.main import create_app
from app.models import User
from app.permissions import AccountType

ISSUER = "http://test-idp/realms/ai-platform"
AUDIENCE = "ai-platform"


@pytest.fixture(scope="session")
def rsa_key():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


@pytest.fixture
def make_token(rsa_key):
    def _make(sub, username=None, *, expires_in=300, issuer=ISSUER, audience=AUDIENCE, key=None):
        now = int(time.time())
        claims = {
            "sub": sub, "preferred_username": username or sub,
            "iss": issuer, "aud": audience, "iat": now, "exp": now + expires_in,
        }
        return jwt.encode(claims, key or rsa_key, algorithm="RS256")
    return _make


@pytest.fixture
def idp():
    return InMemoryIdentityProvider()


@pytest.fixture
def app(rsa_key, idp):
    verifier = JwtVerifier(issuer=ISSUER, audience=AUDIENCE, key_resolver=lambda token: rsa_key.public_key())
    return create_app(database_url="sqlite://", verifier=verifier, idp=idp)


@pytest.fixture
def client(app):
    return TestClient(app)


@pytest.fixture
def session(app):
    with app.state.sessionmaker() as s:
        yield s


@pytest.fixture
def add_user(session, idp, make_token):
    def _add(username, account_type=AccountType.USER):
        subject = idp.create_user(username, "Dev-Passw0rd!")
        user = User(username=username, account_type=account_type.value, idp_subject=subject)
        session.add(user)
        session.commit()
        return user, {"Authorization": f"Bearer {make_token(subject, username)}"}
    return _add
```

`platform/api/tests/test_identity.py`：

```python
from cryptography.hazmat.primitives.asymmetric import rsa

from app.models import User


def test_me_returns_current_user(client, add_user):
    _, headers = add_user("pi01")
    response = client.get("/api/me", headers=headers)
    assert response.status_code == 200
    assert response.json()["username"] == "pi01"


def test_tc_ss_02_missing_token_is_401(client):
    assert client.get("/api/me").status_code == 401


def test_tc_ss_03_bad_tokens_are_401(client, add_user, make_token, idp):
    user, _ = add_user("pi01")
    other_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    bad_tokens = [
        make_token(user.idp_subject, "pi01", key=other_key),          # 錯誤簽章
        make_token(user.idp_subject, "pi01", expires_in=-10),        # 已過期
        make_token(user.idp_subject, "pi01", issuer="http://evil"),  # 別的 issuer
        make_token(user.idp_subject, "pi01", audience="other-app"),  # 別的 audience
        "not-a-jwt",
    ]
    for token in bad_tokens:
        response = client.get("/api/me", headers={"Authorization": f"Bearer {token}"})
        assert response.status_code == 401, token


def test_deleted_user_with_valid_token_is_401(client, add_user, session):
    user, headers = add_user("ra01")
    session.delete(session.get(User, user.id))
    session.commit()
    assert client.get("/api/me", headers=headers).status_code == 401


def test_in_memory_idp_password_lifecycle(idp):
    subject = idp.create_user("md01", "old-pass")
    assert idp.find_subject("md01") == subject
    idp.reset_password(subject, "new-pass")
    assert idp.check_password("md01", "new-pass")
    assert not idp.check_password("md01", "old-pass")
    idp.delete_user(subject)
    assert idp.find_subject("md01") is None
```

- [ ] **Step 2: 執行，確認失敗**

Run: `uv run pytest tests/test_identity.py -v`
Expected: FAIL，`No module named 'app.identity'`

- [ ] **Step 3: 實作**

`platform/api/app/identity.py`：

```python
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Protocol

import jwt


@dataclass(frozen=True)
class Identity:
    subject: str
    username: str


class TokenError(Exception):
    pass


class JwtVerifier:
    """驗證 Keycloak 簽發的 RS256 access token。key_resolver 由 token 找出公鑰。"""

    def __init__(self, *, issuer: str, audience: str, key_resolver: Callable[[str], Any]):
        self.issuer = issuer
        self.audience = audience
        self.key_resolver = key_resolver

    def verify(self, token: str) -> Identity:
        try:
            key = self.key_resolver(token)
            claims = jwt.decode(
                token, key, algorithms=["RS256"], audience=self.audience, issuer=self.issuer,
                options={"require": ["exp", "iss", "sub", "aud"]},
            )
        except Exception as exc:  # PyJWT 與取公鑰的錯誤一律視為無效 token
            raise TokenError(str(exc)) from exc
        return Identity(subject=claims["sub"], username=claims.get("preferred_username", claims["sub"]))


class IdentityProvider(Protocol):
    def create_user(self, username: str, password: str) -> str: ...
    def delete_user(self, subject: str) -> None: ...
    def reset_password(self, subject: str, new_password: str) -> None: ...
    def find_subject(self, username: str) -> str | None: ...


class InMemoryIdentityProvider:
    """測試用身分提供者，行為對齊 Keycloak：subject 為隨機 UUID。"""

    def __init__(self) -> None:
        self._users: dict[str, dict[str, str]] = {}

    def create_user(self, username: str, password: str) -> str:
        subject = str(uuid.uuid4())
        self._users[subject] = {"username": username, "password": password}
        return subject

    def delete_user(self, subject: str) -> None:
        self._users.pop(subject, None)

    def reset_password(self, subject: str, new_password: str) -> None:
        self._users[subject]["password"] = new_password

    def find_subject(self, username: str) -> str | None:
        return next((s for s, u in self._users.items() if u["username"] == username), None)

    def check_password(self, username: str, password: str) -> bool:
        subject = self.find_subject(username)
        return subject is not None and self._users[subject]["password"] == password
```

`platform/api/app/deps.py`：

```python
from collections.abc import Iterator

from fastapi import Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.identity import Identity, TokenError
from app.models import User
from app.permissions import AccountType


def get_session(request: Request) -> Iterator[Session]:
    with request.app.state.sessionmaker() as session:
        yield session


def client_ip(request: Request) -> str | None:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else None


def current_identity(request: Request) -> Identity:
    auth = request.headers.get("authorization", "")
    if not auth.lower().startswith("bearer "):
        raise HTTPException(401, "未登入")
    try:
        return request.app.state.verifier.verify(auth[7:])
    except TokenError:
        raise HTTPException(401, "登入已失效，請重新登入")


def current_user(identity: Identity = Depends(current_identity), session: Session = Depends(get_session)) -> User:
    user = session.scalar(select(User).where(User.idp_subject == identity.subject))
    if user is None:
        raise HTTPException(401, "帳號不存在或已停用")
    return user


def require_admin(user: User = Depends(current_user)) -> User:
    if user.account_type != AccountType.ADMIN:
        raise HTTPException(403, "需要 Admin 權限")
    return user
```

`platform/api/app/routers/me.py`：

```python
from fastapi import APIRouter, Depends

from app.deps import current_user
from app.models import User

router = APIRouter(prefix="/api")


@router.get("/me")
def me(user: User = Depends(current_user)) -> dict:
    return {"username": user.username, "account_type": user.account_type}
```

`platform/api/app/main.py`：在 `healthz` 之前加入路由：

```python
from app.routers import me
...
    app.include_router(me.router)
```

- [ ] **Step 4: 執行，確認通過**

Run: `uv run pytest -v`
Expected: all passed

- [ ] **Step 5: Commit**

```bash
git add platform/api
git commit -m "feat(api): verify OIDC tokens and resolve current user from database"
```

---

### Task 5: 即時權限判斷

**Files:**
- Create: `platform/api/app/authz.py`、`platform/api/tests/test_authz.py`

**Interfaces:**
- Consumes: `models.User`、`models.Membership`、`permissions.*`
- Produces: `authz.effective_permissions(session, user: User, project_id: int) -> frozenset[Permission]`；`authz.require_permission(session, user, project_id, permission) -> None`（不足時 `HTTPException(403)`，detail 為 `{"code": "forbidden", "permission": <值>, "message": "你沒有 <值> 權限"}`）

- [ ] **Step 1: 寫失敗的測試**

```python
import pytest
from fastapi import HTTPException

from app.authz import effective_permissions, require_permission
from app.models import Membership, Project
from app.permissions import AccountType, Permission


@pytest.fixture
def project(session):
    p = Project(name="P1-lung-ct")
    session.add(p)
    session.commit()
    return p


def test_admin_has_all_permissions_everywhere(session, add_user, project):
    admin, _ = add_user("admin01", AccountType.ADMIN)
    assert effective_permissions(session, admin, project.id) == frozenset(Permission)


def test_non_member_has_nothing(session, add_user, project):
    outsider, _ = add_user("user01")
    assert effective_permissions(session, outsider, project.id) == frozenset()


def test_member_gets_stored_permissions(session, add_user, project):
    vw, _ = add_user("vw01")
    session.add(Membership(user_id=vw.id, project_id=project.id, role="viewer", permissions=["project", "prediction"]))
    session.commit()
    assert effective_permissions(session, vw, project.id) == {Permission.PROJECT, Permission.PREDICTION}


def test_tc_a03_05_require_permission_rejects_with_message(session, add_user, project):
    vw, _ = add_user("vw01")
    session.add(Membership(user_id=vw.id, project_id=project.id, role="viewer", permissions=["project", "prediction"]))
    session.commit()
    for perm in [Permission.TRAINING, Permission.LABELING, Permission.CODING]:
        with pytest.raises(HTTPException) as exc:
            require_permission(session, vw, project.id, perm)
        assert exc.value.status_code == 403
        assert exc.value.detail["permission"] == perm.value


def test_tc_a03_06_change_is_visible_on_next_check(session, add_user, project):
    ra, _ = add_user("ra01")
    m = Membership(user_id=ra.id, project_id=project.id, role="research_assistant", permissions=["project", "training"])
    session.add(m)
    session.commit()
    require_permission(session, ra, project.id, Permission.TRAINING)

    m.permissions = ["project"]
    session.commit()
    with pytest.raises(HTTPException):
        require_permission(session, ra, project.id, Permission.TRAINING)
```

- [ ] **Step 2: 執行，確認失敗**

Run: `uv run pytest tests/test_authz.py -v`
Expected: FAIL，`No module named 'app.authz'`

- [ ] **Step 3: 實作**

```python
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Membership, User
from app.permissions import AccountType, Permission


def effective_permissions(session: Session, user: User, project_id: int) -> frozenset[Permission]:
    """每次都查資料庫，不快取：權限變更在下一個請求就生效。"""
    if user.account_type == AccountType.ADMIN:
        return frozenset(Permission)
    membership = session.scalar(
        select(Membership).where(Membership.user_id == user.id, Membership.project_id == project_id)
    )
    if membership is None:
        return frozenset()
    return frozenset(Permission(p) for p in membership.permissions)


def require_permission(session: Session, user: User, project_id: int, permission: Permission) -> None:
    if permission not in effective_permissions(session, user, project_id):
        raise HTTPException(403, {
            "code": "forbidden", "permission": permission.value, "message": f"你沒有 {permission.value} 權限",
        })
```

- [ ] **Step 4: 執行，確認通過**

Run: `uv run pytest -v`
Expected: all passed

- [ ] **Step 5: Commit**

```bash
git add platform/api
git commit -m "feat(api): live permission checks per project"
```

---

### Task 6: 專案管理 API（Admin）

**Files:**
- Create: `platform/api/app/admin_service.py`、`platform/api/app/routers/admin.py`、`platform/api/tests/test_admin_projects.py`
- Modify: `platform/api/app/main.py`

**Interfaces:**
- Consumes: `audit.record`、`deps.require_admin`、`deps.get_session`、`deps.client_ip`
- Produces:
  - `admin_service.Conflict`、`admin_service.NotFound`（main 轉成 409、404）
  - `admin_service.create_project(session, *, actor: str, name: str, description: str = "", gpu_group: str | None = None, source_ip: str | None = None) -> Project`
  - `admin_service.update_project(session, *, actor, project_id: int, changes: dict, source_ip=None) -> Project`
  - `admin_service.delete_project(session, *, actor, project_id: int, source_ip=None) -> None`
  - `POST /api/admin/projects`（201）、`GET /api/admin/projects`、`PATCH /api/admin/projects/{id}`、`DELETE /api/admin/projects/{id}`（204）；回應格式 `{"id", "name", "description", "gpu_group"}`

- [ ] **Step 1: 寫失敗的測試**

```python
from sqlalchemy import select

from app.models import AuditLog
from app.permissions import AccountType


def test_tc_a03_01_project_crud_three_times_with_audit(client, add_user, session):
    _, admin = add_user("admin01", AccountType.ADMIN)
    for i in range(3):
        created = client.post("/api/admin/projects", headers=admin, json={"name": f"P-{i}", "gpu_group": "gpu-exclusive"})
        assert created.status_code == 201
        pid = created.json()["id"]
        updated = client.patch(f"/api/admin/projects/{pid}", headers=admin, json={"description": "改過"})
        assert updated.status_code == 200 and updated.json()["description"] == "改過"
        assert client.delete(f"/api/admin/projects/{pid}", headers=admin).status_code == 204

    actions = [e.action for e in session.scalars(select(AuditLog).where(AuditLog.category == "project"))]
    assert actions.count("create") == 3 and actions.count("update") == 3 and actions.count("delete") == 3


def test_tc_a03_03_non_admin_cannot_manage_projects(client, add_user):
    _, pi = add_user("pi01")
    for _ in range(5):
        response = client.post("/api/admin/projects", headers=pi, json={"name": "偷建"})
        assert response.status_code == 403
        assert response.json()["detail"] == "需要 Admin 權限"


def test_duplicate_project_name_is_409(client, add_user):
    _, admin = add_user("admin01", AccountType.ADMIN)
    assert client.post("/api/admin/projects", headers=admin, json={"name": "P1"}).status_code == 201
    assert client.post("/api/admin/projects", headers=admin, json={"name": "P1"}).status_code == 409


def test_missing_project_is_404(client, add_user):
    _, admin = add_user("admin01", AccountType.ADMIN)
    assert client.patch("/api/admin/projects/999", headers=admin, json={"description": "x"}).status_code == 404
```

- [ ] **Step 2: 執行，確認失敗**

Run: `uv run pytest tests/test_admin_projects.py -v`
Expected: FAIL，404 on `/api/admin/projects`

- [ ] **Step 3: 實作**

`platform/api/app/admin_service.py`：

```python
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.audit import AuditCategory, record
from app.models import Membership, Project


class Conflict(Exception):
    pass


class NotFound(Exception):
    pass


def _get(session: Session, model, obj_id: int):
    obj = session.get(model, obj_id)
    if obj is None:
        raise NotFound(f"找不到 {model.__tablename__} {obj_id}")
    return obj


def create_project(session: Session, *, actor: str, name: str, description: str = "",
                   gpu_group: str | None = None, source_ip: str | None = None) -> Project:
    if session.scalar(select(Project).where(Project.name == name)):
        raise Conflict(f"專案名稱「{name}」已存在")
    project = Project(name=name, description=description, gpu_group=gpu_group)
    session.add(project)
    session.flush()
    record(session, actor=actor, category=AuditCategory.PROJECT, action="create",
           target=f"project:{project.id}", source_ip=source_ip,
           detail={"name": name, "gpu_group": gpu_group})
    session.commit()
    return project


def update_project(session: Session, *, actor: str, project_id: int, changes: dict,
                   source_ip: str | None = None) -> Project:
    project = _get(session, Project, project_id)
    new_name = changes.get("name")
    if new_name and new_name != project.name and session.scalar(select(Project).where(Project.name == new_name)):
        raise Conflict(f"專案名稱「{new_name}」已存在")
    for key, value in changes.items():
        setattr(project, key, value)
    record(session, actor=actor, category=AuditCategory.PROJECT, action="update",
           target=f"project:{project.id}", source_ip=source_ip, detail=changes)
    session.commit()
    return project


def delete_project(session: Session, *, actor: str, project_id: int, source_ip: str | None = None) -> None:
    project = _get(session, Project, project_id)
    session.execute(delete(Membership).where(Membership.project_id == project_id))
    session.delete(project)
    record(session, actor=actor, category=AuditCategory.PROJECT, action="delete",
           target=f"project:{project_id}", source_ip=source_ip, detail={"name": project.name})
    session.commit()
```

`platform/api/app/routers/admin.py`：

```python
from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import admin_service
from app.deps import client_ip, get_session, require_admin
from app.models import Project, User

router = APIRouter(prefix="/api/admin")


class ProjectIn(BaseModel):
    name: str
    description: str = ""
    gpu_group: str | None = None


class ProjectPatch(BaseModel):
    name: str | None = None
    description: str | None = None
    gpu_group: str | None = None


def project_out(p: Project) -> dict:
    return {"id": p.id, "name": p.name, "description": p.description, "gpu_group": p.gpu_group}


@router.get("/projects")
def list_projects(admin: User = Depends(require_admin), session: Session = Depends(get_session)) -> list[dict]:
    return [project_out(p) for p in session.scalars(select(Project).order_by(Project.id))]


@router.post("/projects", status_code=201)
def create_project(body: ProjectIn, request: Request, admin: User = Depends(require_admin),
                   session: Session = Depends(get_session)) -> dict:
    p = admin_service.create_project(session, actor=admin.username, source_ip=client_ip(request), **body.model_dump())
    return project_out(p)


@router.patch("/projects/{project_id}")
def update_project(project_id: int, body: ProjectPatch, request: Request, admin: User = Depends(require_admin),
                   session: Session = Depends(get_session)) -> dict:
    p = admin_service.update_project(session, actor=admin.username, project_id=project_id,
                                     changes=body.model_dump(exclude_unset=True), source_ip=client_ip(request))
    return project_out(p)


@router.delete("/projects/{project_id}", status_code=204)
def delete_project(project_id: int, request: Request, admin: User = Depends(require_admin),
                   session: Session = Depends(get_session)) -> Response:
    admin_service.delete_project(session, actor=admin.username, project_id=project_id, source_ip=client_ip(request))
    return Response(status_code=204)
```

`platform/api/app/main.py`：加入例外處理與路由（在 `create_app` 內、`return app` 之前）：

```python
from fastapi import Request
from fastapi.responses import JSONResponse

from app import admin_service
from app.routers import admin, me
...
    @app.exception_handler(admin_service.Conflict)
    def _conflict(request: Request, exc: admin_service.Conflict):
        return JSONResponse(status_code=409, content={"detail": str(exc)})

    @app.exception_handler(admin_service.NotFound)
    def _not_found(request: Request, exc: admin_service.NotFound):
        return JSONResponse(status_code=404, content={"detail": str(exc)})

    app.include_router(me.router)
    app.include_router(admin.router)
```

- [ ] **Step 4: 執行，確認通過**

Run: `uv run pytest -v`
Expected: all passed

- [ ] **Step 5: Commit**

```bash
git add platform/api
git commit -m "feat(api): admin project CRUD with audit"
```

---

### Task 7: 帳號管理 API 與重設密碼（Admin）

**Files:**
- Create: `platform/api/tests/test_admin_users.py`
- Modify: `platform/api/app/admin_service.py`、`platform/api/app/routers/admin.py`

**Interfaces:**
- Consumes: `IdentityProvider`（`request.app.state.idp`）
- Produces:
  - `admin_service.create_user(session, idp, *, actor, username: str, password: str, account_type: AccountType, source_ip=None) -> User`
  - `admin_service.update_user(session, *, actor, user_id: int, account_type: AccountType, source_ip=None) -> User`
  - `admin_service.delete_user(session, idp, *, actor_user: User, user_id: int, source_ip=None) -> None`
  - `admin_service.reset_password(session, idp, *, actor, user_id: int, new_password: str, source_ip=None) -> None`
  - `POST /api/admin/users`（201）、`GET /api/admin/users`、`PATCH /api/admin/users/{id}`、`DELETE /api/admin/users/{id}`（204）、`POST /api/admin/users/{id}/reset-password`（204）；回應 `{"id", "username", "account_type"}`

- [ ] **Step 1: 寫失敗的測試**

```python
from sqlalchemy import select

from app.models import AuditLog
from app.permissions import AccountType


def test_tc_a03_02_user_crud_three_times_synced_with_idp(client, add_user, idp, session):
    _, admin = add_user("admin01", AccountType.ADMIN)
    for i in range(3):
        created = client.post("/api/admin/users", headers=admin,
                              json={"username": f"u{i}", "password": "Init-Passw0rd!", "account_type": "user"})
        assert created.status_code == 201
        uid = created.json()["id"]
        assert idp.find_subject(f"u{i}") is not None
        assert client.patch(f"/api/admin/users/{uid}", headers=admin, json={"account_type": "admin"}).status_code == 200
        assert client.delete(f"/api/admin/users/{uid}", headers=admin).status_code == 204
        assert idp.find_subject(f"u{i}") is None

    actions = [e.action for e in session.scalars(select(AuditLog).where(AuditLog.category == "account"))]
    assert actions.count("create") == 3 and actions.count("update") == 3 and actions.count("delete") == 3


def test_tc_a03_08_reset_password_three_times(client, add_user, idp):
    _, admin = add_user("admin01", AccountType.ADMIN)
    ra, _ = add_user("ra01")
    previous = "Dev-Passw0rd!"
    for i in range(3):
        new = f"New-Passw0rd-{i}!"
        response = client.post(f"/api/admin/users/{ra.id}/reset-password", headers=admin, json={"new_password": new})
        assert response.status_code == 204
        assert idp.check_password("ra01", new)
        assert not idp.check_password("ra01", previous)
        previous = new


def test_tc_a03_03_non_admin_cannot_create_users(client, add_user):
    _, user01 = add_user("user01")
    for _ in range(5):
        response = client.post("/api/admin/users", headers=user01,
                               json={"username": "x", "password": "Init-Passw0rd!", "account_type": "admin"})
        assert response.status_code == 403


def test_duplicate_username_is_409(client, add_user):
    _, admin = add_user("admin01", AccountType.ADMIN)
    body = {"username": "dup", "password": "Init-Passw0rd!", "account_type": "user"}
    assert client.post("/api/admin/users", headers=admin, json=body).status_code == 201
    assert client.post("/api/admin/users", headers=admin, json=body).status_code == 409


def test_admin_cannot_delete_self(client, add_user):
    admin_user, admin = add_user("admin01", AccountType.ADMIN)
    assert client.delete(f"/api/admin/users/{admin_user.id}", headers=admin).status_code == 409


def test_last_admin_cannot_be_demoted(client, add_user):
    admin_user, admin = add_user("admin01", AccountType.ADMIN)
    response = client.patch(f"/api/admin/users/{admin_user.id}", headers=admin, json={"account_type": "user"})
    assert response.status_code == 409


def test_invalid_account_type_is_422(client, add_user):
    _, admin = add_user("admin01", AccountType.ADMIN)
    response = client.post("/api/admin/users", headers=admin,
                           json={"username": "x", "password": "Init-Passw0rd!", "account_type": "root"})
    assert response.status_code == 422
```

- [ ] **Step 2: 執行，確認失敗**

Run: `uv run pytest tests/test_admin_users.py -v`
Expected: FAIL，404 on `/api/admin/users`

- [ ] **Step 3: 實作**

`admin_service.py` 加入（imports 補上 `User`、`AccountType`、`IdentityProvider`）：

```python
from app.identity import IdentityProvider
from app.models import Membership, Project, User
from app.permissions import AccountType


def _admin_count(session: Session) -> int:
    return session.scalar(select(func.count()).select_from(User).where(User.account_type == AccountType.ADMIN))


def create_user(session: Session, idp: IdentityProvider, *, actor: str, username: str, password: str,
                account_type: AccountType, source_ip: str | None = None) -> User:
    if session.scalar(select(User).where(User.username == username)):
        raise Conflict(f"帳號「{username}」已存在")
    subject = idp.create_user(username, password)
    try:
        user = User(username=username, account_type=account_type.value, idp_subject=subject)
        session.add(user)
        session.flush()
        record(session, actor=actor, category=AuditCategory.ACCOUNT, action="create", target=f"user:{user.id}",
               source_ip=source_ip, detail={"username": username, "account_type": account_type.value})
        session.commit()
    except Exception:
        session.rollback()
        idp.delete_user(subject)  # 補償：資料庫失敗時不留下孤兒帳號
        raise
    return user


def update_user(session: Session, *, actor: str, user_id: int, account_type: AccountType,
                source_ip: str | None = None) -> User:
    user = _get(session, User, user_id)
    if user.account_type == AccountType.ADMIN and account_type != AccountType.ADMIN and _admin_count(session) <= 1:
        raise Conflict("至少要保留 1 個 Admin")
    before = user.account_type
    user.account_type = account_type.value
    record(session, actor=actor, category=AuditCategory.ACCOUNT, action="update", target=f"user:{user.id}",
           source_ip=source_ip, detail={"account_type": {"from": before, "to": account_type.value}})
    session.commit()
    return user


def delete_user(session: Session, idp: IdentityProvider, *, actor_user: User, user_id: int,
                source_ip: str | None = None) -> None:
    user = _get(session, User, user_id)
    if user.id == actor_user.id:
        raise Conflict("不能刪除自己的帳號")
    if user.account_type == AccountType.ADMIN and _admin_count(session) <= 1:
        raise Conflict("至少要保留 1 個 Admin")
    idp.delete_user(user.idp_subject)
    session.execute(delete(Membership).where(Membership.user_id == user_id))
    session.delete(user)
    record(session, actor=actor_user.username, category=AuditCategory.ACCOUNT, action="delete",
           target=f"user:{user_id}", source_ip=source_ip, detail={"username": user.username})
    session.commit()


def reset_password(session: Session, idp: IdentityProvider, *, actor: str, user_id: int, new_password: str,
                   source_ip: str | None = None) -> None:
    user = _get(session, User, user_id)
    idp.reset_password(user.idp_subject, new_password)
    record(session, actor=actor, category=AuditCategory.ACCOUNT, action="reset_password",
           target=f"user:{user_id}", source_ip=source_ip)
    session.commit()
```

`routers/admin.py` 加入：

```python
from app.permissions import AccountType


class UserIn(BaseModel):
    username: str
    password: str
    account_type: AccountType


class UserPatch(BaseModel):
    account_type: AccountType


class PasswordReset(BaseModel):
    new_password: str


def user_out(u: User) -> dict:
    return {"id": u.id, "username": u.username, "account_type": u.account_type}


@router.get("/users")
def list_users(admin: User = Depends(require_admin), session: Session = Depends(get_session)) -> list[dict]:
    return [user_out(u) for u in session.scalars(select(User).order_by(User.id))]


@router.post("/users", status_code=201)
def create_user(body: UserIn, request: Request, admin: User = Depends(require_admin),
                session: Session = Depends(get_session)) -> dict:
    u = admin_service.create_user(session, request.app.state.idp, actor=admin.username,
                                  source_ip=client_ip(request), **body.model_dump())
    return user_out(u)


@router.patch("/users/{user_id}")
def update_user(user_id: int, body: UserPatch, request: Request, admin: User = Depends(require_admin),
                session: Session = Depends(get_session)) -> dict:
    u = admin_service.update_user(session, actor=admin.username, user_id=user_id,
                                  account_type=body.account_type, source_ip=client_ip(request))
    return user_out(u)


@router.delete("/users/{user_id}", status_code=204)
def delete_user(user_id: int, request: Request, admin: User = Depends(require_admin),
                session: Session = Depends(get_session)) -> Response:
    admin_service.delete_user(session, request.app.state.idp, actor_user=admin, user_id=user_id,
                              source_ip=client_ip(request))
    return Response(status_code=204)


@router.post("/users/{user_id}/reset-password", status_code=204)
def reset_password(user_id: int, body: PasswordReset, request: Request, admin: User = Depends(require_admin),
                   session: Session = Depends(get_session)) -> Response:
    admin_service.reset_password(session, request.app.state.idp, actor=admin.username, user_id=user_id,
                                 new_password=body.new_password, source_ip=client_ip(request))
    return Response(status_code=204)
```

- [ ] **Step 4: 執行，確認通過**

Run: `uv run pytest -v`
Expected: all passed

- [ ] **Step 5: Commit**

```bash
git add platform/api
git commit -m "feat(api): admin user management synced with identity provider"
```

---

### Task 8: 專案成員、角色與權限設定，以及 /api/me 權限清單

**Files:**
- Create: `platform/api/tests/test_memberships.py`
- Modify: `platform/api/app/admin_service.py`、`platform/api/app/routers/admin.py`、`platform/api/app/routers/me.py`

**Interfaces:**
- Produces:
  - `admin_service.set_membership(session, *, actor, project_id: int, user_id: int, role: Role, permissions: set[Permission] | None = None, source_ip=None) -> Membership`（`permissions=None` 時套用角色預設；角色變更記 `role` 類、權限變更記 `permission` 類稽核）
  - `admin_service.remove_membership(session, *, actor, project_id: int, user_id: int, source_ip=None) -> None`
  - `PUT /api/admin/projects/{pid}/members/{uid}` body `{"role": Role, "permissions": list[Permission] | null}`；`DELETE /api/admin/projects/{pid}/members/{uid}`（204）
  - `GET /api/me` → `{"username", "account_type", "projects": [{"id", "name", "role", "permissions": [..]}]}`（Admin 列出全部專案、角色為 `null`、權限全開）

- [ ] **Step 1: 寫失敗的測試**

```python
from sqlalchemy import select

from app.models import AuditLog, Project
from app.permissions import AccountType


def _setup(client, add_user, session):
    _, admin = add_user("admin01", AccountType.ADMIN)
    project = Project(name="P1-lung-ct")
    session.add(project)
    session.commit()
    return admin, project


def test_member_gets_role_defaults(client, add_user, session):
    admin, project = _setup(client, add_user, session)
    md, md_headers = add_user("md01")
    response = client.put(f"/api/admin/projects/{project.id}/members/{md.id}", headers=admin, json={"role": "medical_doctor"})
    assert response.status_code == 200
    me = client.get("/api/me", headers=md_headers).json()
    assert me["projects"] == [{"id": project.id, "name": "P1-lung-ct", "role": "medical_doctor",
                               "permissions": ["labeling", "prediction", "project"]}]


def test_tc_a03_06_permission_takes_effect_immediately(client, add_user, session):
    admin, project = _setup(client, add_user, session)
    ra, ra_headers = add_user("ra01")
    client.put(f"/api/admin/projects/{project.id}/members/{ra.id}", headers=admin, json={"role": "research_assistant"})
    client.put(f"/api/admin/projects/{project.id}/members/{ra.id}", headers=admin,
               json={"role": "research_assistant", "permissions": ["project", "labeling", "prediction"]})
    perms = client.get("/api/me", headers=ra_headers).json()["projects"][0]["permissions"]
    assert "training" not in perms  # 同一個 token、下一個請求就看到變更


def test_tc_a03_07_removed_member_loses_access_immediately(client, add_user, session):
    admin, project = _setup(client, add_user, session)
    md, md_headers = add_user("md01")
    client.put(f"/api/admin/projects/{project.id}/members/{md.id}", headers=admin, json={"role": "medical_doctor"})
    assert client.delete(f"/api/admin/projects/{project.id}/members/{md.id}", headers=admin).status_code == 204
    assert client.get("/api/me", headers=md_headers).json()["projects"] == []


def test_role_and_permission_changes_are_audited_separately(client, add_user, session):
    admin, project = _setup(client, add_user, session)
    ca, _ = add_user("ca01")
    client.put(f"/api/admin/projects/{project.id}/members/{ca.id}", headers=admin, json={"role": "coder_assistant"})
    client.put(f"/api/admin/projects/{project.id}/members/{ca.id}", headers=admin, json={"role": "viewer"})
    categories = [e.category for e in session.scalars(select(AuditLog))]
    assert categories.count("role") == 2        # assign + change
    assert categories.count("permission") == 2  # grant + change


def test_unknown_permission_is_422(client, add_user, session):
    admin, project = _setup(client, add_user, session)
    vw, _ = add_user("vw01")
    response = client.put(f"/api/admin/projects/{project.id}/members/{vw.id}", headers=admin,
                          json={"role": "viewer", "permissions": ["project", "superuser"]})
    assert response.status_code == 422


def test_admin_me_lists_all_projects_with_all_permissions(client, add_user, session):
    admin, project = _setup(client, add_user, session)
    me = client.get("/api/me", headers=admin).json()
    assert me["projects"][0]["role"] is None
    assert me["projects"][0]["permissions"] == ["coding", "labeling", "prediction", "project", "training"]
```

- [ ] **Step 2: 執行，確認失敗**

Run: `uv run pytest tests/test_memberships.py -v`
Expected: FAIL，404/405 on members endpoint

- [ ] **Step 3: 實作**

`admin_service.py` 加入（imports 補 `DEFAULT_ROLE_PERMISSIONS, Permission, Role`）：

```python
from app.permissions import DEFAULT_ROLE_PERMISSIONS, AccountType, Permission, Role


def set_membership(session: Session, *, actor: str, project_id: int, user_id: int, role: Role,
                   permissions: set[Permission] | None = None, source_ip: str | None = None) -> Membership:
    _get(session, Project, project_id)
    _get(session, User, user_id)
    target = f"project:{project_id}/user:{user_id}"
    chosen = permissions if permissions is not None else DEFAULT_ROLE_PERMISSIONS[role]
    new_perms = sorted(p.value for p in chosen)
    membership = session.scalar(
        select(Membership).where(Membership.user_id == user_id, Membership.project_id == project_id)
    )
    if membership is None:
        membership = Membership(user_id=user_id, project_id=project_id, role=role.value, permissions=new_perms)
        session.add(membership)
        record(session, actor=actor, category=AuditCategory.ROLE, action="assign", target=target,
               source_ip=source_ip, detail={"role": role.value})
        record(session, actor=actor, category=AuditCategory.PERMISSION, action="grant", target=target,
               source_ip=source_ip, detail={"permissions": new_perms})
    else:
        if membership.role != role.value:
            record(session, actor=actor, category=AuditCategory.ROLE, action="change", target=target,
                   source_ip=source_ip, detail={"from": membership.role, "to": role.value})
            membership.role = role.value
        if membership.permissions != new_perms:
            record(session, actor=actor, category=AuditCategory.PERMISSION, action="change", target=target,
                   source_ip=source_ip, detail={"from": membership.permissions, "to": new_perms})
            membership.permissions = new_perms
    session.commit()
    return membership


def remove_membership(session: Session, *, actor: str, project_id: int, user_id: int,
                      source_ip: str | None = None) -> None:
    membership = session.scalar(
        select(Membership).where(Membership.user_id == user_id, Membership.project_id == project_id)
    )
    if membership is None:
        raise NotFound(f"使用者 {user_id} 不是專案 {project_id} 的成員")
    session.delete(membership)
    record(session, actor=actor, category=AuditCategory.ROLE, action="revoke",
           target=f"project:{project_id}/user:{user_id}", source_ip=source_ip, detail={"role": membership.role})
    session.commit()
```

`routers/admin.py` 加入：

```python
from app.permissions import AccountType, Permission, Role


class MembershipIn(BaseModel):
    role: Role
    permissions: list[Permission] | None = None


@router.put("/projects/{project_id}/members/{user_id}")
def set_member(project_id: int, user_id: int, body: MembershipIn, request: Request,
               admin: User = Depends(require_admin), session: Session = Depends(get_session)) -> dict:
    m = admin_service.set_membership(
        session, actor=admin.username, project_id=project_id, user_id=user_id, role=body.role,
        permissions=set(body.permissions) if body.permissions is not None else None,
        source_ip=client_ip(request),
    )
    return {"project_id": m.project_id, "user_id": m.user_id, "role": m.role, "permissions": m.permissions}


@router.delete("/projects/{project_id}/members/{user_id}", status_code=204)
def remove_member(project_id: int, user_id: int, request: Request, admin: User = Depends(require_admin),
                  session: Session = Depends(get_session)) -> Response:
    admin_service.remove_membership(session, actor=admin.username, project_id=project_id, user_id=user_id,
                                    source_ip=client_ip(request))
    return Response(status_code=204)
```

`routers/me.py` 整份：

```python
from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.deps import current_user, get_session
from app.models import Membership, Project, User
from app.permissions import AccountType, Permission

router = APIRouter(prefix="/api")

ALL_PERMISSIONS = sorted(p.value for p in Permission)


@router.get("/me")
def me(user: User = Depends(current_user), session: Session = Depends(get_session)) -> dict:
    if user.account_type == AccountType.ADMIN:
        projects = [
            {"id": p.id, "name": p.name, "role": None, "permissions": ALL_PERMISSIONS}
            for p in session.scalars(select(Project).order_by(Project.id))
        ]
    else:
        rows = session.execute(
            select(Project, Membership).join(Membership, Membership.project_id == Project.id)
            .where(Membership.user_id == user.id).order_by(Project.id)
        )
        projects = [
            {"id": p.id, "name": p.name, "role": m.role, "permissions": sorted(m.permissions)}
            for p, m in rows
        ]
    return {"username": user.username, "account_type": user.account_type, "projects": projects}
```

- [ ] **Step 4: 執行，確認通過**

Run: `uv run pytest -v`
Expected: all passed

- [ ] **Step 5: Commit**

```bash
git add platform/api
git commit -m "feat(api): project membership, per-user permissions and /api/me"
```

---

### Task 9: Gateway 授權檢查端點（forward-auth）

**Files:**
- Create: `platform/api/app/routers/authz_check.py`、`platform/api/tests/test_authz_check.py`
- Modify: `platform/api/app/authz.py`、`platform/api/app/main.py`

**Interfaces:**
- Produces:
  - `authz.match_rule(path: str) -> tuple[int, Permission] | None`（先 URL 解碼、去查詢字串、正規化 `..` 與重複斜線，再比對）
  - `GET /authz/check`：讀 `Authorization`、`X-Forwarded-Uri`；通過回 200 並帶 `X-User: <username>`；未登入 401；權限不足或沒有規則 403（預設拒絕）
- 路徑規則（後續工作包的服務都掛在這些前綴下）：

| 前綴 | 需要的權限 |
|---|---|
| `/api/projects/{pid}/inference` | prediction |
| `/api/projects/{pid}/training` | training |
| `/api/projects/{pid}/labels` | labeling |
| `/api/projects/{pid}/code` | coding |
| `/api/projects/{pid}/...`（其他） | project |

- [ ] **Step 1: 寫失敗的測試**

```python
import pytest

from app.authz import match_rule
from app.models import Membership, Project
from app.permissions import Permission


@pytest.mark.parametrize("path,expected", [
    ("/api/projects/7/inference/predict", (7, Permission.PREDICTION)),
    ("/api/projects/7/training", (7, Permission.TRAINING)),
    ("/api/projects/7/labels/12", (7, Permission.LABELING)),
    ("/api/projects/7/code/export", (7, Permission.CODING)),
    ("/api/projects/7/datasets", (7, Permission.PROJECT)),
    ("/api/projects/7", (7, Permission.PROJECT)),
    ("/api/projects/7/training?x=1", (7, Permission.TRAINING)),
    ("/api/projects/2/../1/training", (1, Permission.TRAINING)),
    ("/api/projects/1/%2e%2e/2/training", (2, Permission.TRAINING)),
    ("//api//projects/3//inference", (3, Permission.PREDICTION)),
    ("/api/projects/1/inferencex", (1, Permission.PROJECT)),
    ("/api/other", None),
    ("/api/projects/abc/training", None),
])
def test_match_rule(path, expected):
    assert match_rule(path) == expected


@pytest.fixture
def p1(session):
    p = Project(name="P1")
    session.add(p)
    session.commit()
    return p


def _check(client, headers, uri):
    return client.get("/authz/check", headers={**headers, "X-Forwarded-Uri": uri})


def test_allowed_request_returns_200_with_user(client, add_user, session, p1):
    vw, headers = add_user("vw01")
    session.add(Membership(user_id=vw.id, project_id=p1.id, role="viewer", permissions=["project", "prediction"]))
    session.commit()
    response = _check(client, headers, f"/api/projects/{p1.id}/inference/predict")
    assert response.status_code == 200
    assert response.headers["X-User"] == "vw01"


def test_tc_a03_05_viewer_denied_ten_times(client, add_user, session, p1):
    vw, headers = add_user("vw01")
    session.add(Membership(user_id=vw.id, project_id=p1.id, role="viewer", permissions=["project", "prediction"]))
    session.commit()
    uris = [f"/api/projects/{p1.id}/{s}" for s in ["training", "labels", "code"] * 3] + [f"/api/projects/{p1.id}/training/1"]
    assert len(uris) == 10
    assert all(_check(client, headers, u).status_code == 403 for u in uris)


def test_tc_a02_04_outsider_denied_ten_times(client, add_user, p1):
    _, headers = add_user("user01")
    for _ in range(10):
        assert _check(client, headers, f"/api/projects/{p1.id}/datasets").status_code == 403


def test_path_traversal_cannot_escape_to_other_project(client, add_user, session, p1):
    p2 = Project(name="P2")
    session.add(p2)
    vw, headers = add_user("vw01")
    session.add(Membership(user_id=vw.id, project_id=p1.id, role="viewer", permissions=["project", "prediction"]))
    session.commit()
    assert _check(client, headers, f"/api/projects/{p1.id}/../{p2.id}/inference").status_code == 403


def test_unknown_route_is_denied_by_default(client, add_user):
    _, headers = add_user("user01")
    assert _check(client, headers, "/something/else").status_code == 403


def test_no_token_is_401(client):
    assert client.get("/authz/check", headers={"X-Forwarded-Uri": "/api/projects/1"}).status_code == 401
```

- [ ] **Step 2: 執行，確認失敗**

Run: `uv run pytest tests/test_authz_check.py -v`
Expected: FAIL，`cannot import name 'match_rule'`

- [ ] **Step 3: 實作**

`authz.py` 加入：

```python
import posixpath
import re
from urllib.parse import unquote

_RULES: list[tuple[re.Pattern, Permission]] = [
    (re.compile(r"^/api/projects/(?P<pid>\d+)/inference(/|$)"), Permission.PREDICTION),
    (re.compile(r"^/api/projects/(?P<pid>\d+)/training(/|$)"), Permission.TRAINING),
    (re.compile(r"^/api/projects/(?P<pid>\d+)/labels(/|$)"), Permission.LABELING),
    (re.compile(r"^/api/projects/(?P<pid>\d+)/code(/|$)"), Permission.CODING),
    (re.compile(r"^/api/projects/(?P<pid>\d+)(/|$)"), Permission.PROJECT),
]


def _normalize(path: str) -> str:
    # 不用 urlsplit：它會把 "//api/..." 的 "api" 當成主機名稱。
    decoded = unquote(path.split("?", 1)[0])
    return posixpath.normpath("/" + decoded.lstrip("/"))


def match_rule(path: str) -> tuple[int, Permission] | None:
    """由 Gateway 轉來的原始路徑決定專案與所需權限；比對不到就回 None（呼叫端預設拒絕）。"""
    normalized = _normalize(path)
    for pattern, permission in _RULES:
        m = pattern.match(normalized)
        if m:
            return int(m.group("pid")), permission
    return None
```

`routers/authz_check.py`：

```python
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy.orm import Session

from app.authz import effective_permissions, match_rule
from app.deps import current_user, get_session
from app.models import User

router = APIRouter()


@router.get("/authz/check")
def check(request: Request, user: User = Depends(current_user), session: Session = Depends(get_session)) -> Response:
    rule = match_rule(request.headers.get("x-forwarded-uri", ""))
    if rule is None:
        raise HTTPException(403, "此路徑未開放")
    project_id, permission = rule
    if permission not in effective_permissions(session, user, project_id):
        raise HTTPException(403, f"你沒有 {permission.value} 權限")
    return Response(status_code=200, headers={"X-User": user.username})
```

`main.py`：`from app.routers import admin, authz_check, me`，並加 `app.include_router(authz_check.router)`。

- [ ] **Step 4: 執行，確認通過**

Run: `uv run pytest -v`
Expected: all passed

- [ ] **Step 5: Commit**

```bash
git add platform/api
git commit -m "feat(api): forward-auth endpoint with normalized path rules"
```

---

### Task 10: 測試基線種子資料

**Files:**
- Create: `platform/api/app/seed.py`、`platform/api/tests/test_seed.py`

**Interfaces:**
- Consumes: `admin_service.create_project`、`create_user`、`set_membership`
- Produces:
  - `seed.DEV_PASSWORD`（開發用測試密碼，只存在這個檔案）
  - `seed.reset_and_seed(session, idp, *, admin_username: str) -> dict`：刪除除 Admin 以外的所有帳號（含身分提供者端）、專案、成員資格，再建立測試基線；回傳 `{"projects": [...], "users": [...]}`。Admin 帳號必須已存在於身分提供者；若平台資料庫沒有，就依 `idp.find_subject` 建立。
  - 指令：`uv run python -m app.seed`（Task 11 接上正式設定後可用）

- [ ] **Step 1: 寫失敗的測試**

```python
from sqlalchemy import func, select

from app.models import Membership, Project, User
from app.seed import DEV_PASSWORD, reset_and_seed


def test_seed_creates_baseline(session, idp):
    idp.create_user("admin01", "Admin01-dev!")
    summary = reset_and_seed(session, idp, admin_username="admin01")

    assert sorted(summary["projects"]) == ["P1-lung-ct", "P2-tabular", "P3-llm"]
    assert session.scalar(select(func.count()).select_from(User)) == 8
    assert session.scalar(select(func.count()).select_from(Membership)) == 5
    assert idp.check_password("vw01", DEV_PASSWORD)
    p1 = session.scalar(select(Project).where(Project.name == "P1-lung-ct"))
    assert p1.gpu_group == "gpu-exclusive"


def test_seed_is_repeatable(session, idp):
    idp.create_user("admin01", "Admin01-dev!")
    reset_and_seed(session, idp, admin_username="admin01")
    reset_and_seed(session, idp, admin_username="admin01")
    assert session.scalar(select(func.count()).select_from(User)) == 8
    assert idp.check_password("admin01", "Admin01-dev!")  # Admin 不被重設
```

- [ ] **Step 2: 執行，確認失敗**

Run: `uv run pytest tests/test_seed.py -v`
Expected: FAIL，`No module named 'app.seed'`

- [ ] **Step 3: 實作**

```python
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app import admin_service
from app.identity import IdentityProvider
from app.models import Membership, Project, User
from app.permissions import AccountType, Role

DEV_PASSWORD = "Dev-Passw0rd!"  # 只用於本機與測試環境的種子帳號

PROJECTS = [
    ("P1-lung-ct", "影像專案", "gpu-exclusive"),
    ("P2-tabular", "結構式資料專案", "gpu-shared"),
    ("P3-llm", "LLM 專案", "gpu-exclusive"),
]
P1_MEMBERS = [
    ("pi01", Role.PRINCIPAL_INVESTIGATOR),
    ("md01", Role.MEDICAL_DOCTOR),
    ("ra01", Role.RESEARCH_ASSISTANT),
    ("ca01", Role.CODER_ASSISTANT),
    ("vw01", Role.VIEWER),
]
OUTSIDERS = ["user01", "user02"]


def reset_and_seed(session: Session, idp: IdentityProvider, *, admin_username: str) -> dict:
    admin = session.scalar(select(User).where(User.username == admin_username))
    if admin is None:
        subject = idp.find_subject(admin_username)
        if subject is None:
            raise RuntimeError(f"身分提供者中找不到 {admin_username}")
        admin = User(username=admin_username, account_type=AccountType.ADMIN.value, idp_subject=subject)
        session.add(admin)
        session.commit()

    session.execute(delete(Membership))
    for user in session.scalars(select(User).where(User.id != admin.id)).all():
        idp.delete_user(user.idp_subject)
        session.delete(user)
    session.execute(delete(Project))
    session.commit()

    actor = admin.username
    projects = {
        name: admin_service.create_project(session, actor=actor, name=name, description=desc, gpu_group=group)
        for name, desc, group in PROJECTS
    }
    for username, role in P1_MEMBERS:
        stale = idp.find_subject(username)
        if stale:
            idp.delete_user(stale)
        user = admin_service.create_user(session, idp, actor=actor, username=username,
                                         password=DEV_PASSWORD, account_type=AccountType.USER)
        admin_service.set_membership(session, actor=actor, project_id=projects["P1-lung-ct"].id,
                                     user_id=user.id, role=role)
    for username in OUTSIDERS:
        stale = idp.find_subject(username)
        if stale:
            idp.delete_user(stale)
        admin_service.create_user(session, idp, actor=actor, username=username,
                                  password=DEV_PASSWORD, account_type=AccountType.USER)

    return {"projects": list(projects), "users": [admin_username] + [u for u, _ in P1_MEMBERS] + OUTSIDERS}
```

- [ ] **Step 4: 執行，確認通過**

Run: `uv run pytest -v`
Expected: all passed

- [ ] **Step 5: Commit**

```bash
git add platform/api
git commit -m "feat(api): repeatable test baseline seed"
```

---

### Task 11: 本機整合環境（需 Docker；磁碟清理後執行）

**Files:**
- Create: `platform/api/app/settings.py`、`platform/api/app/asgi.py`、`platform/api/Dockerfile`、`platform/api/app/keycloak.py`
- Create: `platform/deploy/local/compose.yaml`、`platform/deploy/local/postgres/init.sql`、`platform/deploy/local/keycloak/realm-ai-platform.json`、`platform/deploy/local/apisix/config.yaml`、`platform/deploy/local/apisix/apisix.yaml`
- Modify: `platform/api/app/seed.py`（加入 `__main__`）

**Interfaces:**
- Produces: `settings.Settings.from_env()`；`keycloak.KeycloakIdentityProvider(base_url, realm, client_id, client_secret)`（實作 `IdentityProvider`）；`asgi.app`；Gateway `http://localhost:9080`、Keycloak `http://localhost:8080`；平台 API 不對主機開放連接埠（TC-SS-05）。
- 說明：WP1 先用 Compose 讓開發迴圈快；WP4 導入 kind 與 Helm 時，同一批映像與設定搬進叢集。

- [ ] **Step 1: 設定與正式進入點**

`platform/api/app/settings.py`：

```python
import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    database_url: str
    oidc_issuer: str
    oidc_audience: str
    oidc_jwks_url: str
    keycloak_base_url: str
    keycloak_realm: str
    keycloak_client_id: str
    keycloak_client_secret: str

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(**{field: os.environ[field.upper()] for field in cls.__dataclass_fields__})
```

`platform/api/app/keycloak.py`：

```python
import httpx


class KeycloakIdentityProvider:
    """透過 Keycloak Admin REST API 管理帳號；平台 API 以 service account 取得管理 token。"""

    def __init__(self, *, base_url: str, realm: str, client_id: str, client_secret: str):
        self.base = base_url.rstrip("/")
        self.realm = realm
        self.client_id = client_id
        self.client_secret = client_secret

    def _headers(self) -> dict:
        response = httpx.post(
            f"{self.base}/realms/{self.realm}/protocol/openid-connect/token",
            data={"grant_type": "client_credentials", "client_id": self.client_id, "client_secret": self.client_secret},
            timeout=10,
        )
        response.raise_for_status()
        return {"Authorization": f"Bearer {response.json()['access_token']}"}

    def _users_url(self) -> str:
        return f"{self.base}/admin/realms/{self.realm}/users"

    def create_user(self, username: str, password: str) -> str:
        body = {"username": username, "enabled": True,
                "credentials": [{"type": "password", "value": password, "temporary": False}]}
        response = httpx.post(self._users_url(), json=body, headers=self._headers(), timeout=10)
        response.raise_for_status()
        return response.headers["Location"].rsplit("/", 1)[-1]

    def delete_user(self, subject: str) -> None:
        response = httpx.delete(f"{self._users_url()}/{subject}", headers=self._headers(), timeout=10)
        if response.status_code != 404:
            response.raise_for_status()

    def reset_password(self, subject: str, new_password: str) -> None:
        response = httpx.put(f"{self._users_url()}/{subject}/reset-password",
                             json={"type": "password", "value": new_password, "temporary": False},
                             headers=self._headers(), timeout=10)
        response.raise_for_status()

    def find_subject(self, username: str) -> str | None:
        response = httpx.get(self._users_url(), params={"username": username, "exact": "true"},
                             headers=self._headers(), timeout=10)
        response.raise_for_status()
        users = response.json()
        return users[0]["id"] if users else None
```

`platform/api/app/asgi.py`：

```python
import jwt

from app.identity import JwtVerifier
from app.keycloak import KeycloakIdentityProvider
from app.main import create_app
from app.settings import Settings


def build():
    s = Settings.from_env()
    jwks = jwt.PyJWKClient(s.oidc_jwks_url)
    verifier = JwtVerifier(issuer=s.oidc_issuer, audience=s.oidc_audience,
                           key_resolver=lambda token: jwks.get_signing_key_from_jwt(token).key)
    idp = KeycloakIdentityProvider(base_url=s.keycloak_base_url, realm=s.keycloak_realm,
                                   client_id=s.keycloak_client_id, client_secret=s.keycloak_client_secret)
    return create_app(database_url=s.database_url, verifier=verifier, idp=idp), s, idp


app, _settings, _idp = build()
```

`seed.py` 末端加入：

```python
if __name__ == "__main__":
    import json
    import os

    from app.asgi import app, _idp

    with app.state.sessionmaker() as s:
        print(json.dumps(reset_and_seed(s, _idp, admin_username=os.environ.get("SEED_ADMIN", "admin01")),
                         ensure_ascii=False, indent=2))
```

- [ ] **Step 2: 映像與 Compose**

`platform/api/Dockerfile`：

```dockerfile
FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:0.5 /uv /bin/uv
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev
COPY app ./app
CMD ["uv", "run", "--no-sync", "uvicorn", "app.asgi:app", "--host", "0.0.0.0", "--port", "8000"]
```

`platform/deploy/local/postgres/init.sql`：

```sql
CREATE DATABASE keycloak;
```

`platform/deploy/local/compose.yaml`：

```yaml
name: ai-platform
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: platform
      POSTGRES_PASSWORD: platform-dev
      POSTGRES_DB: platform
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./postgres/init.sql:/docker-entrypoint-initdb.d/init.sql:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U platform"]
      interval: 5s
      retries: 20

  keycloak:
    image: quay.io/keycloak/keycloak:26.0
    command: ["start-dev", "--import-realm"]
    environment:
      KC_BOOTSTRAP_ADMIN_USERNAME: kcadmin
      KC_BOOTSTRAP_ADMIN_PASSWORD: kcadmin-dev
      KC_DB: postgres
      KC_DB_URL: jdbc:postgresql://postgres:5432/keycloak
      KC_DB_USERNAME: platform
      KC_DB_PASSWORD: platform-dev
      KC_HOSTNAME: http://localhost:8080
      KC_HOSTNAME_BACKCHANNEL_DYNAMIC: "true"
    volumes:
      - ./keycloak/realm-ai-platform.json:/opt/keycloak/data/import/realm-ai-platform.json:ro
    ports: ["8080:8080"]
    depends_on:
      postgres: {condition: service_healthy}

  api:
    build: ../../api
    environment:
      DATABASE_URL: postgresql+psycopg://platform:platform-dev@postgres:5432/platform
      OIDC_ISSUER: http://localhost:8080/realms/ai-platform
      OIDC_AUDIENCE: ai-platform
      OIDC_JWKS_URL: http://keycloak:8080/realms/ai-platform/protocol/openid-connect/certs
      KEYCLOAK_BASE_URL: http://keycloak:8080
      KEYCLOAK_REALM: ai-platform
      KEYCLOAK_CLIENT_ID: ai-platform-api
      KEYCLOAK_CLIENT_SECRET: api-secret-dev
    depends_on:
      postgres: {condition: service_healthy}
      keycloak: {condition: service_started}

  apisix:
    image: apache/apisix:3.11.0-debian
    volumes:
      - ./apisix/config.yaml:/usr/local/apisix/conf/config.yaml:ro
      - ./apisix/apisix.yaml:/usr/local/apisix/conf/apisix.yaml:ro
    ports: ["9080:9080"]
    depends_on: [api]

volumes:
  pgdata: {}
```

`platform/deploy/local/keycloak/realm-ai-platform.json`（`directAccessGrantsEnabled` 只為本機驗收腳本取 token，正式環境必須關閉）：

```json
{
  "realm": "ai-platform",
  "enabled": true,
  "accessTokenLifespan": 300,
  "clients": [
    {
      "clientId": "ai-platform-web",
      "publicClient": true,
      "standardFlowEnabled": true,
      "directAccessGrantsEnabled": true,
      "redirectUris": ["http://localhost:5173/*"],
      "webOrigins": ["http://localhost:5173"],
      "attributes": {"pkce.code.challenge.method": "S256"},
      "protocolMappers": [
        {
          "name": "platform-audience",
          "protocol": "openid-connect",
          "protocolMapper": "oidc-audience-mapper",
          "config": {"included.custom.audience": "ai-platform", "access.token.claim": "true", "id.token.claim": "false"}
        }
      ]
    },
    {
      "clientId": "ai-platform-api",
      "publicClient": false,
      "secret": "api-secret-dev",
      "serviceAccountsEnabled": true,
      "standardFlowEnabled": false
    }
  ],
  "users": [
    {
      "username": "admin01",
      "enabled": true,
      "credentials": [{"type": "password", "value": "Admin01-dev!", "temporary": false}]
    },
    {
      "username": "service-account-ai-platform-api",
      "enabled": true,
      "serviceAccountClientId": "ai-platform-api",
      "clientRoles": {"realm-management": ["manage-users", "view-users"]}
    }
  ]
}
```

`platform/deploy/local/apisix/config.yaml`：

```yaml
deployment:
  role: data_plane
  role_data_plane:
    config_provider: yaml
```

`platform/deploy/local/apisix/apisix.yaml`（平台 API 自己驗 token 與權限；forward-auth 從 WP2 起用在 DICOMweb、推論等其他上游）：

```yaml
routes:
  - id: platform-api
    uri: /api/*
    upstream:
      type: roundrobin
      nodes:
        "api:8000": 1
#END
```

- [ ] **Step 3: 起環境並驗證**

```bash
cd platform/api && uv lock
cd ../deploy/local && docker compose up -d --build
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:9080/api/me
docker compose exec api uv run --no-sync python -m app.seed
```

Expected: 第一個 curl 印出 `401`；seed 印出 3 個專案與 8 個帳號。

- [ ] **Step 4: Commit**

```bash
git add platform
git commit -m "feat(deploy): local stack with Postgres, Keycloak, APISIX and API"
```

---

### Task 12: 經 Gateway 的驗收測試（需 Docker）

**Files:**
- Create: `platform/acceptance/pyproject.toml`、`platform/acceptance/conftest.py`、`platform/acceptance/test_tc_ss.py`、`platform/acceptance/test_tc_a03.py`

**Interfaces:**
- Consumes: Task 11 的 Gateway 與 Keycloak、Task 10 的種子帳號（密碼讀 `app.seed.DEV_PASSWORD` 的同一個值，透過環境變數 `DEV_PASSWORD` 傳入）
- Produces: `uv run pytest` 產出 `reports/<日期>/junit.xml`，每個案例名稱帶 TC ID

- [ ] **Step 1: 建立驗收專案**

`platform/acceptance/pyproject.toml`：

```toml
[project]
name = "ai-platform-acceptance"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = ["pytest>=8", "httpx>=0.27"]

[tool.pytest.ini_options]
addopts = "--junitxml=reports/latest/junit.xml"
```

`platform/acceptance/conftest.py`：

```python
import os

import httpx
import pytest

GATEWAY = os.environ.get("GATEWAY_URL", "http://localhost:9080")
KEYCLOAK = os.environ.get("KEYCLOAK_URL", "http://localhost:8080")
PASSWORDS = {"admin01": os.environ.get("ADMIN_PASSWORD", "Admin01-dev!")}
DEV_PASSWORD = os.environ.get("DEV_PASSWORD", "Dev-Passw0rd!")


def login(username: str, password: str | None = None) -> str:
    response = httpx.post(
        f"{KEYCLOAK}/realms/ai-platform/protocol/openid-connect/token",
        data={"grant_type": "password", "client_id": "ai-platform-web", "username": username,
              "password": password or PASSWORDS.get(username, DEV_PASSWORD)},
        timeout=10,
    )
    response.raise_for_status()
    return response.json()["access_token"]


@pytest.fixture
def api():
    with httpx.Client(base_url=GATEWAY, timeout=10) as client:
        yield client


@pytest.fixture
def auth():
    return lambda username, password=None: {"Authorization": f"Bearer {login(username, password)}"}
```

- [ ] **Step 2: 寫驗收測試**

`platform/acceptance/test_tc_ss.py`：

```python
import httpx
import pytest

from conftest import login

SEEDED = ["admin01", "pi01", "md01", "ra01", "ca01", "vw01", "user01", "user02"]


def test_tc_ss_01_all_seeded_accounts_can_login(api, auth):
    for username in SEEDED:
        assert api.get("/api/me", headers=auth(username)).status_code == 200


def test_tc_ss_02_no_token_ten_times(api):
    paths = ["/api/me", "/api/admin/users", "/api/admin/projects"] * 3 + ["/api/admin/projects/1"]
    assert all(api.get(p).status_code == 401 for p in paths)


@pytest.mark.parametrize("url", ["http://localhost:8000/api/me", "http://localhost:5432"])
def test_tc_ss_05_internal_services_not_reachable_from_host(url):
    for _ in range(10):
        with pytest.raises(httpx.TransportError):
            httpx.get(url, timeout=2)
```

`platform/acceptance/test_tc_a03.py`：

```python
import time


def _user_id(api, admin, username):
    return next(u["id"] for u in api.get("/api/admin/users", headers=admin).json() if u["username"] == username)


def _project_id(api, admin, name):
    return next(p["id"] for p in api.get("/api/admin/projects", headers=admin).json() if p["name"] == name)


def test_tc_a03_01_project_crud(api, auth):
    admin = auth("admin01")
    for i in range(3):
        pid = api.post("/api/admin/projects", headers=admin, json={"name": f"acc-{time.time_ns()}-{i}"}).json()["id"]
        assert api.patch(f"/api/admin/projects/{pid}", headers=admin, json={"description": "改"}).status_code == 200
        assert api.delete(f"/api/admin/projects/{pid}", headers=admin).status_code == 204


def test_tc_a03_02_user_crud_and_login(api, auth):
    admin = auth("admin01")
    for i in range(3):
        name = f"acc{time.time_ns()}{i}"
        uid = api.post("/api/admin/users", headers=admin,
                       json={"username": name, "password": "Init-Passw0rd!", "account_type": "user"}).json()["id"]
        assert api.get("/api/me", headers=auth(name, "Init-Passw0rd!")).status_code == 200
        assert api.delete(f"/api/admin/users/{uid}", headers=admin).status_code == 204


def test_tc_a03_03_non_admin_denied(api, auth):
    for username in ["pi01", "user01"]:
        headers = auth(username)
        for _ in range(5):
            assert api.post("/api/admin/users", headers=headers,
                            json={"username": "x", "password": "Init-Passw0rd!", "account_type": "admin"}).status_code == 403


def test_tc_a03_06_permission_change_within_10_seconds(api, auth):
    admin = auth("admin01")
    ra_headers = auth("ra01")
    pid = _project_id(api, admin, "P1-lung-ct")
    uid = _user_id(api, admin, "ra01")
    api.put(f"/api/admin/projects/{pid}/members/{uid}", headers=admin,
            json={"role": "research_assistant", "permissions": ["project", "labeling", "prediction"]})
    start = time.monotonic()
    perms = api.get("/api/me", headers=ra_headers).json()["projects"][0]["permissions"]
    assert "training" not in perms and time.monotonic() - start < 10
    api.put(f"/api/admin/projects/{pid}/members/{uid}", headers=admin, json={"role": "research_assistant"})
    assert "training" in api.get("/api/me", headers=ra_headers).json()["projects"][0]["permissions"]


def test_tc_a03_08_reset_password(api, auth):
    admin = auth("admin01")
    uid = _user_id(api, admin, "user02")
    for i in range(3):
        new = f"Reset-Passw0rd-{i}!"
        assert api.post(f"/api/admin/users/{uid}/reset-password", headers=admin,
                        json={"new_password": new}).status_code == 204
        assert api.get("/api/me", headers=auth("user02", new)).status_code == 200
```

- [ ] **Step 3: 執行**

```bash
cd platform/deploy/local && docker compose exec api uv run --no-sync python -m app.seed
cd ../../acceptance && uv run pytest -v
```

Expected: 全部通過；`reports/latest/junit.xml` 產出。

- [ ] **Step 4: Commit**

```bash
git add platform/acceptance
git commit -m "test(acceptance): TC-SS and TC-A03 through the gateway"
```

---

## 未涵蓋、留給後續工作包

- TC-A03-05 的「提示顯示」與 TC-A03-10 → WP1b 網頁殼（Playwright）。
- TC-SS-04 金鑰掃描、TC-SS-07 資料庫層只允許 INSERT 稽核 → WP8（需 PostgreSQL 角色設定）。
- TC-A03-09 稽核抽查 20 筆 → 在 Task 12 環境跑完後由 WP8 的每日稽核覆蓋檢查統一抽查。
