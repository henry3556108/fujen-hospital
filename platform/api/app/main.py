from fastapi import FastAPI

from app.db import make_engine, make_sessionmaker
from app.models import Base
from app.routers import authz_check, me


def create_app(*, database_url: str = "sqlite://", verifier=None, idp=None) -> FastAPI:
    engine = make_engine(database_url)
    Base.metadata.create_all(engine)

    app = FastAPI(title="AI Platform API")
    app.state.sessionmaker = make_sessionmaker(engine)
    app.state.verifier = verifier
    app.state.idp = idp

    app.include_router(me.router)
    app.include_router(authz_check.router)

    @app.get("/healthz")
    def healthz() -> dict:
        return {"status": "ok"}

    return app
