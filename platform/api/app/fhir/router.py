import json
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from app.audit import AuditCategory, record
from app.deps import ProjectContext, client_ip, require_project_permission
from app.fhir import etl, graph, service
from app.fhir.client import FhirClient, FhirError, FhirUnavailable, fhir_from_env
from app.fhir.mapping import BUILTIN
from app.fhir.resources import SUPPORTED_TYPES
from app.permissions import AccountType, Permission

router = APIRouter()
projects = APIRouter(prefix="/api/projects/{project_id}/fhir")

MAX_HL7_BYTES = 1024 * 1024

read_access = require_project_permission(Permission.PROJECT)


def admin_access(ctx: ProjectContext = Depends(read_access)) -> ProjectContext:
    """來源、對應規則、排程與寫入都屬於資料交換的管理動作，只有 Admin 能做。"""
    if ctx.user.account_type != AccountType.ADMIN:
        raise HTTPException(403, "需要 Admin 權限")
    return ctx


def get_fhir(request: Request) -> FhirClient:
    client = getattr(request.app.state, "fhir", None)
    if client is None:
        client = fhir_from_env()
        if client is None:
            raise HTTPException(503, "FHIR 服務尚未設定（FHIR_URL）")
        request.app.state.fhir = client
    return client


@contextmanager
def _errors() -> Iterator[None]:
    try:
        yield
    except service.FhirServiceError as exc:
        detail = {"message": exc.message, **exc.detail} if exc.detail else exc.message
        raise HTTPException(exc.status_code, detail)
    except FhirUnavailable as exc:
        raise HTTPException(503, exc.message)
    except FhirError as exc:
        raise HTTPException(502, f"FHIR 服務回報錯誤：{exc.message}")


def _run_response(run) -> Response:
    """succeeded → 201；資料不合格 → 422；FHIR 伺服器拒絕 → 502；連不上或中斷 → 503。整批未寫入時都附上執行紀錄。"""
    body = service.run_out(run)
    if run.status == "succeeded":
        return JSONResponse(body, status_code=201)
    if run.status == "rejected":
        return JSONResponse({"detail": {"message": "資料不合格，整批未寫入", "run": body}}, status_code=422)
    unavailable = any(e.get("unavailable") for e in run.errors)
    return JSONResponse({"detail": {"message": "寫入 FHIR 服務失敗，整批未寫入", "run": body}},
                        status_code=503 if unavailable else 502)


def _audit_read(ctx: ProjectContext, request: Request, action: str, target: str, detail: dict) -> None:
    record(ctx.session, actor=ctx.user.username, category=AuditCategory.DATA_EXCHANGE, action=action,
           target=target, source_ip=client_ip(request), detail=detail)
    ctx.session.commit()


# ---------- 資源瀏覽 ----------

@projects.get("/summary")
def summary(ctx: ProjectContext = Depends(read_access), fhir: FhirClient = Depends(get_fhir)) -> dict:
    with _errors():
        fhir.ensure_tenant(ctx.project.id)
        return {"tenant": ctx.project.id,
                "counts": {kind: fhir.count(ctx.project.id, kind) for kind in SUPPORTED_TYPES}}


@projects.get("/resources/{resource_type}")
def list_resources(resource_type: str, request: Request, count: int = Query(20, ge=1, le=200),
                   offset: int = Query(0, ge=0), identifier: str | None = Query(None, max_length=256),
                   ctx: ProjectContext = Depends(read_access), fhir: FhirClient = Depends(get_fhir)) -> dict:
    with _errors():
        service.check_resource_type(resource_type)
        fhir.ensure_tenant(ctx.project.id)
        params = {"identifier": identifier} if identifier else {}
        total, items = fhir.search(ctx.project.id, resource_type, params, count=count, offset=offset)
    _audit_read(ctx, request, "fhir.resource.list", f"project:{ctx.project.id}/{resource_type}",
                {"returned": len(items), "offset": offset, "identifier": identifier})
    return {"total": total, "count": count, "offset": offset, "items": items}


@projects.post("/validate")
def validate_resource(resource: dict = Body(...), ctx: ProjectContext = Depends(read_access),
                      fhir: FhirClient = Depends(get_fhir)) -> dict:
    with _errors():
        service.check_resource_type(str(resource.get("resourceType")))
        fhir.ensure_tenant(ctx.project.id)
        issues = fhir.validate(ctx.project.id, resource)
    return {"valid": not issues, "issues": issues}


@projects.get("/graph")
def resource_graph(request: Request, patient: str = Query(..., min_length=1, max_length=64),
                   ctx: ProjectContext = Depends(read_access), fhir: FhirClient = Depends(get_fhir)) -> dict:
    with _errors():
        fhir.ensure_tenant(ctx.project.id)
        result = graph.patient_graph(fhir, ctx.project.id, patient)
        if result is None:
            raise service.NotFound(f"找不到病人 {patient}")
    _audit_read(ctx, request, "fhir.graph.read", f"project:{ctx.project.id}/Patient", {"patient": patient,
                "nodes": len(result["nodes"])})
    return result


# ---------- 來源 ----------

class SourceIn(BaseModel):
    name: str
    kind: str
    config: dict = Field(default_factory=dict)
    content: str | None = None


@projects.get("/sources")
def list_sources(ctx: ProjectContext = Depends(read_access)) -> list[dict]:
    return [service.source_out(s) for s in service.list_sources(ctx.session, ctx.project.id)]


@projects.post("/sources", status_code=201)
def create_source(body: SourceIn, request: Request, ctx: ProjectContext = Depends(admin_access)) -> dict:
    with _errors():
        source = service.create_source(ctx.session, project_id=ctx.project.id, actor=ctx.user.username,
                                       source_ip=client_ip(request), **body.model_dump())
    return service.source_out(source)


@projects.get("/sources/{source_id}")
def get_source(source_id: int, ctx: ProjectContext = Depends(read_access)) -> dict:
    with _errors():
        return service.source_out(service.get_source(ctx.session, ctx.project.id, source_id))


@projects.delete("/sources/{source_id}", status_code=204)
def delete_source(source_id: int, request: Request, ctx: ProjectContext = Depends(admin_access)) -> Response:
    with _errors():
        service.delete_source(ctx.session, project_id=ctx.project.id, source_id=source_id,
                              actor=ctx.user.username, source_ip=client_ip(request))
    return Response(status_code=204)


# ---------- 對應規則 ----------

class MappingIn(BaseModel):
    name: str | None = None
    source_kind: str | None = None
    rules: dict | None = None
    builtin: str | None = None    # 以內建規則建立；與 rules 擇一


class MappingPatch(BaseModel):
    name: str | None = None
    rules: dict | None = None


class PreviewIn(BaseModel):
    rules: dict
    records: list[Any]


@projects.get("/mappings/builtin")
def builtin_mappings(ctx: ProjectContext = Depends(read_access)) -> list[dict]:
    return [{"name": name, "source_kind": spec["source_kind"], "rules": spec["mapping"],
             "resource_types": [r["resourceType"] for r in spec["mapping"]["resources"]]}
            for name, spec in BUILTIN.items()]


@projects.post("/mappings/preview")
def preview_mapping(body: PreviewIn, ctx: ProjectContext = Depends(admin_access)) -> dict:
    with _errors():
        return {"results": service.preview(body.rules, body.records)}


@projects.get("/mappings")
def list_mappings(ctx: ProjectContext = Depends(read_access)) -> list[dict]:
    return [service.mapping_out(m) for m in service.list_mappings(ctx.session, ctx.project.id)]


@projects.post("/mappings", status_code=201)
def create_mapping(body: MappingIn, request: Request, ctx: ProjectContext = Depends(admin_access)) -> dict:
    common = dict(project_id=ctx.project.id, actor=ctx.user.username, source_ip=client_ip(request))
    with _errors():
        if (body.builtin is None) == (body.rules is None):
            raise service.Invalid("請提供 rules 或 builtin 其中之一")
        if body.builtin is not None:
            m = service.create_builtin_mapping(ctx.session, builtin=body.builtin, name=body.name, **common)
        else:
            m = service.create_mapping(ctx.session, name=body.name or "", source_kind=body.source_kind or "",
                                       rules=body.rules, **common)
    return service.mapping_out(m)


@projects.get("/mappings/{mapping_id}")
def get_mapping(mapping_id: int, ctx: ProjectContext = Depends(read_access)) -> dict:
    with _errors():
        return service.mapping_out(service.get_mapping(ctx.session, ctx.project.id, mapping_id))


@projects.put("/mappings/{mapping_id}")
def update_mapping(mapping_id: int, body: MappingPatch, request: Request,
                   ctx: ProjectContext = Depends(admin_access)) -> dict:
    with _errors():
        m = service.update_mapping(ctx.session, project_id=ctx.project.id, mapping_id=mapping_id,
                                   actor=ctx.user.username, source_ip=client_ip(request), name=body.name,
                                   rules=body.rules)
    return service.mapping_out(m)


@projects.delete("/mappings/{mapping_id}", status_code=204)
def delete_mapping(mapping_id: int, request: Request, ctx: ProjectContext = Depends(admin_access)) -> Response:
    with _errors():
        service.delete_mapping(ctx.session, project_id=ctx.project.id, mapping_id=mapping_id,
                               actor=ctx.user.username, source_ip=client_ip(request))
    return Response(status_code=204)


# ---------- 執行 ----------

class RunIn(BaseModel):
    source_id: int
    mapping_id: int


@projects.post("/runs", status_code=201)
def create_run(body: RunIn, request: Request, ctx: ProjectContext = Depends(admin_access),
               fhir: FhirClient = Depends(get_fhir)) -> Response:
    with _errors():
        source = service.get_source(ctx.session, ctx.project.id, body.source_id)
        mapping = service.get_mapping(ctx.session, ctx.project.id, body.mapping_id)
    run = etl.run_etl(ctx.session, fhir, project=ctx.project, source=source, mapping=mapping,
                      actor=ctx.user.username, source_ip=client_ip(request))
    return _run_response(run)


@projects.get("/runs")
def list_runs(schedule_id: int | None = None, limit: int = Query(100, ge=1, le=500),
              ctx: ProjectContext = Depends(read_access)) -> list[dict]:
    return [service.run_out(r) for r in service.list_runs(ctx.session, ctx.project.id, schedule_id=schedule_id,
                                                          limit=limit)]


@projects.get("/runs/{run_id}")
def get_run(run_id: int, ctx: ProjectContext = Depends(read_access)) -> dict:
    with _errors():
        return service.run_out(service.get_run(ctx.session, ctx.project.id, run_id))


# ---------- 即時接收：HL7 V2、生理監視器 ----------

async def hl7_body(request: Request) -> bytes:
    """接受 text/plain（訊息本身）或 application/json（{"message": "..."}）。"""
    raw = await request.body()
    if len(raw) > MAX_HL7_BYTES:
        raise HTTPException(413, "HL7 V2 訊息不可超過 1 MB")
    if request.headers.get("content-type", "").split(";")[0].strip().lower() == "application/json":
        try:
            message = json.loads(raw).get("message")
        except (ValueError, AttributeError):
            message = None
        if not isinstance(message, str):
            raise HTTPException(422, "JSON 內容需要字串欄位 message")
        return message.encode("utf-8")
    return raw


@projects.post("/hl7v2", status_code=201)
def receive_hl7(request: Request, raw: bytes = Depends(hl7_body), ctx: ProjectContext = Depends(admin_access),
                fhir: FhirClient = Depends(get_fhir)) -> Response:
    run = etl.ingest_hl7(ctx.session, fhir, project=ctx.project, raw=raw, actor=ctx.user.username,
                         source_ip=client_ip(request))
    return _run_response(run)


@projects.post("/vitals", status_code=201)
def receive_vitals(request: Request, body: Any = Body(...), ctx: ProjectContext = Depends(admin_access),
                   fhir: FhirClient = Depends(get_fhir)) -> Response:
    readings = body.get("readings") if isinstance(body, dict) and "readings" in body else body
    if isinstance(readings, dict):
        readings = [readings]
    if not isinstance(readings, list) or not readings:
        raise HTTPException(422, "請提供一筆讀數、讀數陣列，或 {\"readings\": [...]}")
    if len(readings) > etl.MAX_VITALS_BATCH:
        raise HTTPException(422, f"一次最多 {etl.MAX_VITALS_BATCH} 筆讀數")
    run = etl.ingest_vitals(ctx.session, fhir, project=ctx.project, readings=readings, actor=ctx.user.username,
                            source_ip=client_ip(request))
    return _run_response(run)


# ---------- 排程 ----------

class ScheduleIn(BaseModel):
    name: str
    source_id: int
    mapping_id: int
    interval_minutes: int
    enabled: bool = True
    start_at: datetime | None = None


class SchedulePatch(BaseModel):
    name: str | None = None
    interval_minutes: int | None = None
    enabled: bool | None = None


@projects.get("/schedules")
def list_schedules(ctx: ProjectContext = Depends(read_access)) -> list[dict]:
    return [service.schedule_out(ctx.session, s) for s in service.list_schedules(ctx.session, ctx.project.id)]


@projects.post("/schedules", status_code=201)
def create_schedule(body: ScheduleIn, request: Request, ctx: ProjectContext = Depends(admin_access)) -> dict:
    with _errors():
        s = service.create_schedule(ctx.session, project_id=ctx.project.id, actor=ctx.user.username,
                                    source_ip=client_ip(request), **body.model_dump())
    return service.schedule_out(ctx.session, s)


@projects.patch("/schedules/{schedule_id}")
def update_schedule(schedule_id: int, body: SchedulePatch, request: Request,
                    ctx: ProjectContext = Depends(admin_access)) -> dict:
    with _errors():
        s = service.update_schedule(ctx.session, project_id=ctx.project.id, schedule_id=schedule_id,
                                    actor=ctx.user.username, source_ip=client_ip(request), **body.model_dump())
    return service.schedule_out(ctx.session, s)


@projects.delete("/schedules/{schedule_id}", status_code=204)
def delete_schedule(schedule_id: int, request: Request, ctx: ProjectContext = Depends(admin_access)) -> Response:
    with _errors():
        service.delete_schedule(ctx.session, project_id=ctx.project.id, schedule_id=schedule_id,
                                actor=ctx.user.username, source_ip=client_ip(request))
    return Response(status_code=204)


router.include_router(projects)
