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
            if claims.get("typ") != "Bearer":  # Keycloak 的 ID token、refresh token 不能當 access token 用
                raise TokenError("不是 access token")
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
