from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from sqlalchemy.exc import IntegrityError

from app import admin_service
from app.db import make_engine, make_sessionmaker
from app.imaging.router import router as imaging_router
from app.labeling.router import router as labeling_router
from app.llm.router import router as llm_router
from app.models import Base
from app.routers import admin, authz_check, me
from app.tabular_api.router import router as tabular_router
from app.scheduling import router as scheduling


def create_app(*, database_url: str = "sqlite://", verifier=None, idp=None, store=None) -> FastAPI:
    engine = make_engine(database_url)
    Base.metadata.create_all(engine)

    app = FastAPI(title="AI Platform API")
    app.state.sessionmaker = make_sessionmaker(engine)
    app.state.verifier = verifier
    app.state.idp = idp
    app.state.store = store

    @app.exception_handler(admin_service.Conflict)
    def _conflict(request: Request, exc: admin_service.Conflict):
        return JSONResponse(status_code=409, content={"detail": str(exc)})

    @app.exception_handler(admin_service.NotFound)
    def _not_found(request: Request, exc: admin_service.NotFound):
        return JSONResponse(status_code=404, content={"detail": str(exc)})

    @app.exception_handler(IntegrityError)
    def _integrity(request: Request, exc: IntegrityError):
        # 事前檢查擋不住併發的重複名稱，由資料庫唯一鍵兜底
        return JSONResponse(status_code=409, content={"detail": "資料重複，請改用其他名稱"})

    app.include_router(me.router)
    app.include_router(admin.router)
    app.include_router(authz_check.router)
    app.include_router(tabular_router)
    app.include_router(imaging_router)
    app.include_router(scheduling.router)
    app.include_router(labeling_router)
    app.include_router(llm_router)

    @app.get("/healthz")
    def healthz() -> dict:
        return {"status": "ok"}

    return app
