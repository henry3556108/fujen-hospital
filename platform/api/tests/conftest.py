import pytest
from fastapi.testclient import TestClient

from app.main import create_app


@pytest.fixture
def app():
    return create_app(database_url="sqlite://")


@pytest.fixture
def client(app):
    return TestClient(app)


@pytest.fixture
def session(app):
    with app.state.sessionmaker() as s:
        yield s
