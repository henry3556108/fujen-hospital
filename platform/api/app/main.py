from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app import admin_service
from app.db import make_engine, make_sessionmaker
from app.models import Base
from app.routers import admin, authz_check, me


def create_app(*, database_url: str = "sqlite://", verifier=None, idp=None) -> FastAPI:
    engine = make_engine(database_url)
    Base.metadata.create_all(engine)

    app = FastAPI(title="AI Platform API")
    app.state.sessionmaker = make_sessionmaker(engine)
    app.state.verifier = verifier
    app.state.idp = idp

    @app.exception_handler(admin_service.Conflict)
    def _conflict(request: Request, exc: admin_service.Conflict):
        return JSONResponse(status_code=409, content={"detail": str(exc)})

    @app.exception_handler(admin_service.NotFound)
    def _not_found(request: Request, exc: admin_service.NotFound):
        return JSONResponse(status_code=404, content={"detail": str(exc)})

    app.include_router(me.router)
    app.include_router(admin.router)
    app.include_router(authz_check.router)

    @app.get("/healthz")
    def healthz() -> dict:
        return {"status": "ok"}

    return app
