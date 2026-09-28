import pytest
from fastapi.testclient import TestClient

from app.main import create_app


@pytest.fixture
def app():
    return create_app(database_url="sqlite://")


@pytest.fixture
def client(app):
    return TestClient(app)
