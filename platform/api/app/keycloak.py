import httpx

from app.admin_service import Conflict


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
        if response.status_code == 409:
            raise Conflict(f"帳號「{username}」已存在於身分提供者")
        response.raise_for_status()
        return response.headers["Location"].rsplit("/", 1)[-1]

    def delete_user(self, subject: str) -> None:
        response = httpx.delete(f"{self._users_url()}/{subject}", headers=self._headers(), timeout=10)
        if response.status_code != 404:  # 已不存在視為刪除成功
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
