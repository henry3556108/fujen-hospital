from fastapi import FastAPI

from app.db import make_engine, make_sessionmaker
from app.models import Base


def create_app(*, database_url: str = "sqlite://", verifier=None, idp=None) -> FastAPI:
    engine = make_engine(database_url)
    Base.metadata.create_all(engine)

    app = FastAPI(title="AI Platform API")
    app.state.sessionmaker = make_sessionmaker(engine)
    app.state.verifier = verifier
    app.state.idp = idp

    @app.get("/healthz")
    def healthz() -> dict:
        return {"status": "ok"}

    return app
