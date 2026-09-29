"""S0 情境 smoke 的共用環境：整個平台 API 跑在程序內，外部服務全換成記憶體版。

- 身分：InMemoryIdentityProvider＋本地簽發的 RS256 token（取代 Keycloak）
- 資料庫：SQLite 記憶體（取代 PostgreSQL）
- 影像節點與 PACS：InMemoryOrthanc，PACS 內放 synth 產生的 20 個研究
- 物件儲存：LocalObjectStore（取代 MinIO）
- 排程：FakeJobBackend（取代 kind＋Kueue），以 advance() 推進時間
- 模型服務：platform/fakes 的 fake-llm、fake-autolabel（ASGI 直接呼叫）
- WP7：模型來源用 InMemoryModelSource、向量庫用 SqlVectorStore、Wiki 用 InMemoryWiki；LLM 用戶端是正式的
  OpenAICompatClient，接到程序內的 fake-llm

所有情境共用同一個 world（session scope），依檔案順序執行，模擬同一套平台被連續使用。
"""
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from sqlalchemy import select

PLATFORM = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(PLATFORM / "api"), str(PLATFORM / "fakes"), str(PLATFORM / "tools" / "synth"),
                str(PLATFORM / "training")]

from app.identity import InMemoryIdentityProvider, JwtVerifier  # noqa: E402
from app.imaging.orthanc import InMemoryOrthanc  # noqa: E402
from app.main import create_app  # noqa: E402
from app.models import AuditLog  # noqa: E402
from app.scheduling.backend import FakeJobBackend  # noqa: E402
from app.seed import reset_and_seed  # noqa: E402
from app.storage import LocalObjectStore  # noqa: E402
from app.llm.client import OpenAICompatClient  # noqa: E402
from app.llm.services import LlmServices  # noqa: E402
from app.llm.sources import fake_source, FAKE_SOURCE_HOST  # noqa: E402
from app.llm.vectors import SqlVectorStore  # noqa: E402
from app.llm.wiki import InMemoryWiki  # noqa: E402

ISSUER = "http://s0-idp/realms/ai-platform"
AUDIENCE = "ai-platform"


@dataclass
class World:
    client: TestClient
    app: object
    idp: InMemoryIdentityProvider
    backend: FakeJobBackend
    orthanc: InMemoryOrthanc
    synth: Path
    key: object
    ids: dict = field(default_factory=dict)  # 情境之間傳遞的 id（專案、資料集…）

    def headers(self, username: str) -> dict:
        subject = self.idp.find_subject(username)
        assert subject, f"身分提供者沒有 {username}"
        now = int(time.time())
        token = jwt.encode({"sub": subject, "preferred_username": username, "iss": ISSUER, "aud": AUDIENCE,
                            "iat": now, "exp": now + 600, "typ": "Bearer"}, self.key, algorithm="RS256")
        return {"Authorization": f"Bearer {token}"}

    def project_id(self, name: str) -> int:
        rows = self.client.get("/api/admin/projects", headers=self.headers("admin01")).json()
        return next(p["id"] for p in rows if p["name"] == name)

    def audit(self, category: str | None = None, *, since: int = 0) -> list[AuditLog]:
        with self.app.state.sessionmaker() as s:
            q = select(AuditLog).where(AuditLog.id > since)
            if category:
                q = q.where(AuditLog.category == category)
            return list(s.scalars(q.order_by(AuditLog.id)))

    def last_audit_id(self) -> int:
        rows = self.audit()
        return rows[-1].id if rows else 0


@pytest.fixture(scope="session")
def synth(tmp_path_factory) -> Path:
    """platform/tools/synth 的全套合成資料（影像、結構式、臨床、生理監視器）。"""
    out = tmp_path_factory.mktemp("synth")
    subprocess.run(["uv", "run", "-q", "python", "-m", "synth", "all", "--out", str(out)],
                   cwd=PLATFORM / "tools" / "synth", check=True, capture_output=True)
    return out


@pytest.fixture(scope="session")
def world(synth, tmp_path_factory) -> World:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    verifier = JwtVerifier(issuer=ISSUER, audience=AUDIENCE, key_resolver=lambda token: key.public_key())
    idp = InMemoryIdentityProvider()
    store = LocalObjectStore(tmp_path_factory.mktemp("objects"))
    app = create_app(database_url="sqlite://", verifier=verifier, idp=idp, store=store)

    pacs = [p.read_bytes() for p in sorted((synth / "dicom").rglob("*.dcm"))]
    orthanc = InMemoryOrthanc(pacs=pacs)
    backend = FakeJobBackend()
    app.state.orthanc = orthanc
    app.state.job_backend = backend

    from fakes.llm import app as fake_llm
    app.state.llm = LlmServices(client=OpenAICompatClient("http://testserver/v1", http=TestClient(fake_llm)),
                                sources={FAKE_SOURCE_HOST: fake_source()},
                                model_dir=tmp_path_factory.mktemp("llm-models"),
                                vectors=SqlVectorStore(), wiki=InMemoryWiki())

    idp.create_user("admin01", "Dev-Passw0rd!")
    with app.state.sessionmaker() as s:
        reset_and_seed(s, idp, admin_username="admin01")

    return World(client=TestClient(app), app=app, idp=idp, backend=backend, orthanc=orthanc,
                 synth=synth, key=key)
