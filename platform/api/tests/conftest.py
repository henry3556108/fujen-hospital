import time

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

from app.identity import InMemoryIdentityProvider, JwtVerifier
from app.main import create_app
from app.models import User
from app.permissions import AccountType
from app.storage import LocalObjectStore

ISSUER = "http://test-idp/realms/ai-platform"
AUDIENCE = "ai-platform"


@pytest.fixture(scope="session")
def rsa_key():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


@pytest.fixture
def make_token(rsa_key):
    def _make(sub, username=None, *, expires_in=300, issuer=ISSUER, audience=AUDIENCE, key=None, typ="Bearer"):
        now = int(time.time())
        claims = {
            "sub": sub, "preferred_username": username or sub,
            "iss": issuer, "aud": audience, "iat": now, "exp": now + expires_in,
        }
        if typ is not None:
            claims["typ"] = typ
        return jwt.encode(claims, key or rsa_key, algorithm="RS256")
    return _make


@pytest.fixture
def idp():
    return InMemoryIdentityProvider()


@pytest.fixture
def store(tmp_path):
    return LocalObjectStore(tmp_path / "objects")


@pytest.fixture
def app(rsa_key, idp, store):
    verifier = JwtVerifier(issuer=ISSUER, audience=AUDIENCE, key_resolver=lambda token: rsa_key.public_key())
    return create_app(database_url="sqlite://", verifier=verifier, idp=idp, store=store)


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
