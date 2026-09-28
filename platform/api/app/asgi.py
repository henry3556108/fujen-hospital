import jwt

from app.identity import JwtVerifier
from app.keycloak import KeycloakIdentityProvider
from app.main import create_app
from app.settings import Settings


def build():
    s = Settings.from_env()
    jwks = jwt.PyJWKClient(s.oidc_jwks_url)
    verifier = JwtVerifier(issuer=s.oidc_issuer, audience=s.oidc_audience,
                           key_resolver=lambda token: jwks.get_signing_key_from_jwt(token).key)
    idp = KeycloakIdentityProvider(base_url=s.keycloak_base_url, realm=s.keycloak_realm,
                                   client_id=s.keycloak_client_id, client_secret=s.keycloak_client_secret)
    return create_app(database_url=s.database_url, verifier=verifier, idp=idp), idp


app, idp = build()
