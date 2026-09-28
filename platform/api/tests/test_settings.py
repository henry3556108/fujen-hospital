import pytest

from app.settings import Settings

ENV = {
    "DATABASE_URL": "postgresql+psycopg://u:p@db/platform",
    "OIDC_ISSUER": "http://localhost:8080/realms/ai-platform",
    "OIDC_AUDIENCE": "ai-platform",
    "OIDC_JWKS_URL": "http://keycloak:8080/realms/ai-platform/protocol/openid-connect/certs",
    "KEYCLOAK_BASE_URL": "http://keycloak:8080",
    "KEYCLOAK_REALM": "ai-platform",
    "KEYCLOAK_CLIENT_ID": "ai-platform-api",
    "KEYCLOAK_CLIENT_SECRET": "secret",
    "STORAGE_ROOT": "/data/objects",
}


def test_settings_from_env(monkeypatch):
    for k, v in ENV.items():
        monkeypatch.setenv(k, v)
    s = Settings.from_env()
    assert s.database_url == ENV["DATABASE_URL"]
    assert s.keycloak_client_secret == "secret"


def test_missing_setting_names_the_variable(monkeypatch):
    for k, v in ENV.items():
        monkeypatch.setenv(k, v)
    monkeypatch.delenv("OIDC_ISSUER")
    with pytest.raises(RuntimeError, match="OIDC_ISSUER"):
        Settings.from_env()
