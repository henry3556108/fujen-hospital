import os

import jwt

from app.identity import JwtVerifier
from app.imaging.orthanc import orthanc_from_env
from app.keycloak import KeycloakIdentityProvider
from app.main import create_app
from app.settings import Settings
from app.storage import store_from_env


def build():
    s = Settings.from_env()
    jwks = jwt.PyJWKClient(s.oidc_jwks_url)
    verifier = JwtVerifier(issuer=s.oidc_issuer, audience=s.oidc_audience,
                           key_resolver=lambda token: jwks.get_signing_key_from_jwt(token).key)
    idp = KeycloakIdentityProvider(base_url=s.keycloak_base_url, realm=s.keycloak_realm,
                                   client_id=s.keycloak_client_id, client_secret=s.keycloak_client_secret)
    store = store_from_env(os.environ)  # STORAGE_BACKEND=local|s3
    app = create_app(database_url=s.database_url, verifier=verifier, idp=idp, store=store)
    app.state.orthanc = orthanc_from_env(os.environ)  # 未設定 ORTHANC_URL 時影像端點回 503
    return app, idp


app, idp = build()
