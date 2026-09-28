import os
from dataclasses import dataclass, fields


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
        names = [f.name.upper() for f in fields(cls)]
        missing = [n for n in names if not os.environ.get(n)]
        if missing:
            raise RuntimeError(f"缺少環境變數：{', '.join(missing)}")
        return cls(**{n.lower(): os.environ[n] for n in names})
