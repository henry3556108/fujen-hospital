import os

import httpx
import pytest

GATEWAY = os.environ.get("GATEWAY_URL", "http://localhost:9080")
KEYCLOAK = os.environ.get("KEYCLOAK_URL", "http://localhost:8080")
# 本機測試值，與 platform/deploy/local/keycloak/realm-ai-platform.json、platform/api/app/seed.py 相同
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
