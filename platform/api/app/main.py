import logging

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from sqlalchemy.exc import IntegrityError, ProgrammingError

from app import admin_service, db_init, labeling_groups, metrics, scanning
from app.db import make_engine, make_sessionmaker
from app.fhir import router as fhir_router
from app.imaging.router import router as imaging_router
from app.labeling.router import router as labeling_router
from app.llm.router import router as llm_router
from app.models import Base
from app.routers import admin, authz_check, me, overview, user_lookup
from app.routers import audit as audit_router
from app.routers import labeling_groups as labeling_groups_router
from app.tabular_api.router import router as tabular_router
from app.scheduling import router as scheduling
from app.training.router import router as training_router

log = logging.getLogger(__name__)


def create_app(*, database_url: str = "sqlite://", verifier=None, idp=None, store=None) -> FastAPI:
    engine = make_engine(database_url)
    try:
        Base.metadata.create_all(engine)  # 表都已存在時不做事；正式部署由 db-init 先建好
    except ProgrammingError as exc:
        raise RuntimeError("資料表尚未建立，或平台資料庫帳號沒有建表權限：請先執行 db-init（python -m app.db_init），"
                           "它以資料表擁有者建表並授權") from exc
    extra = db_init.audit_write_rights(engine)
    if extra:
        log.warning("平台 API 連線的資料庫帳號可以對稽核表 %s（TC-SS-07 要求只有 INSERT 與 SELECT）："
                    "請改用 db-init 建立的平台帳號（見 docs/delivery/部署說明.md）", "、".join(extra))

    app = FastAPI(title="AI Platform API")
    app.state.sessionmaker = make_sessionmaker(engine)
    app.state.verifier = verifier
    app.state.idp = idp
    app.state.store = store
    scanning.install(app)  # 掃毒：app.state.scanner、物件儲存寫入前掃描、錯誤回應

    @app.exception_handler(labeling_groups.Conflict)
    @app.exception_handler(admin_service.Conflict)
    def _conflict(request: Request, exc: admin_service.Conflict):
        return JSONResponse(status_code=409, content={"detail": str(exc)})

    @app.exception_handler(labeling_groups.NotFound)
    @app.exception_handler(admin_service.NotFound)
    def _not_found(request: Request, exc: admin_service.NotFound):
        return JSONResponse(status_code=404, content={"detail": str(exc)})

    @app.exception_handler(IntegrityError)
    def _integrity(request: Request, exc: IntegrityError):
        # 事前檢查擋不住併發的重複名稱，由資料庫唯一鍵兜底
        return JSONResponse(status_code=409, content={"detail": "資料重複，請改用其他名稱"})

    app.include_router(me.router)
    app.include_router(admin.router)
    app.include_router(labeling_groups_router.router)
    app.include_router(audit_router.router)
    app.include_router(authz_check.router)
    app.include_router(user_lookup.router)
    app.include_router(overview.router)
    app.include_router(tabular_router)
    app.include_router(imaging_router)
    app.include_router(scheduling.router)
    app.include_router(fhir_router)
    app.include_router(labeling_router)
    app.include_router(training_router)
    app.include_router(llm_router)

    metrics.install(app)  # GET /metrics（TC-C02-01；叢集內只有 monitoring 命名空間連得到）

    @app.get("/healthz")
    def healthz() -> dict:
        return {"status": "ok"}

    return app
