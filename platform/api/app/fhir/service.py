"""來源、對應規則、執行紀錄的管理，以及資源瀏覽。寫入類動作都寫 data_exchange 稽核（同一個交易）。"""
from datetime import datetime, timedelta, timezone

from sqlalchemy import select, update
from sqlalchemy.engine import make_url
from sqlalchemy.exc import ArgumentError
from sqlalchemy.orm import Session

from app.audit import AuditCategory, record
from app.fhir import mapping as mapping_engine, sources
from app.fhir.mapping import BUILTIN
from app.fhir.models import FhirMapping, FhirRun, FhirSchedule, FhirSource
from app.fhir.resources import SUPPORTED_TYPES, validate
from app.models import utcnow

MAX_CONTENT_BYTES = 5 * 1024 * 1024
MAX_PREVIEW_RECORDS = 50


class FhirServiceError(Exception):
    status_code = 400

    def __init__(self, message: str, detail: dict | None = None):
        super().__init__(message)
        self.message = message
        self.detail = detail


class Invalid(FhirServiceError):
    status_code = 422


class NotFound(FhirServiceError):
    status_code = 404


class Conflict(FhirServiceError):
    status_code = 409


def _audit(session: Session, *, actor: str, action: str, target: str, source_ip: str | None, detail: dict) -> None:
    record(session, actor=actor, category=AuditCategory.DATA_EXCHANGE, action=action, target=target,
           source_ip=source_ip, detail=detail)


def _masked_dsn(dsn: str) -> str:
    try:
        return make_url(dsn).render_as_string(hide_password=True)
    except ArgumentError:
        return "***"


def _iso(value) -> str | None:
    return value.isoformat() if value else None


# ---------- 來源 ----------

def source_out(s: FhirSource) -> dict:
    config = dict(s.config or {})
    if "dsn" in config:
        config["dsn"] = _masked_dsn(str(config["dsn"]))   # 密碼不回傳
    return {"id": s.id, "project_id": s.project_id, "name": s.name, "kind": s.kind, "config": config,
            "content_bytes": len(s.content.encode("utf-8")) if s.content else 0,
            "created_by": s.created_by, "created_at": _iso(s.created_at)}


def _name_taken(session: Session, model, project_id: int, name: str, *, except_id: int | None = None) -> bool:
    q = select(model.id).where(model.project_id == project_id, model.name == name)
    if except_id is not None:
        q = q.where(model.id != except_id)
    return session.scalar(q) is not None


def _clean_name(name: str) -> str:
    name = (name or "").strip()
    if not name or len(name) > 128:
        raise Invalid("名稱必填，且不可超過 128 個字元")
    return name


def create_source(session: Session, *, project_id: int, actor: str, source_ip: str | None, name: str, kind: str,
                  config: dict | None, content: str | None) -> FhirSource:
    name = _clean_name(name)
    config = config or {}
    if content is not None and len(content.encode("utf-8")) > MAX_CONTENT_BYTES:
        raise Invalid(f"來源內容不可超過 {MAX_CONTENT_BYTES // (1024 * 1024)} MB")
    problems = sources.validate_config(kind, config, content)
    if problems:
        raise Invalid("；".join(problems))
    if _name_taken(session, FhirSource, project_id, name):
        raise Conflict(f"來源名稱 {name} 已存在")
    source = FhirSource(project_id=project_id, name=name, kind=kind, config=config,
                        content=None if kind == "sql" else content, created_by=actor)
    session.add(source)
    session.flush()
    _audit(session, actor=actor, action="fhir.source.create", target=f"project:{project_id}/source:{source.id}",
           source_ip=source_ip, detail={"name": name, "kind": kind})
    session.commit()
    return source


def list_sources(session: Session, project_id: int) -> list[FhirSource]:
    return list(session.scalars(select(FhirSource).where(FhirSource.project_id == project_id)
                                .order_by(FhirSource.id)))


def get_source(session: Session, project_id: int, source_id: int) -> FhirSource:
    source = session.get(FhirSource, source_id)
    if source is None or source.project_id != project_id:
        raise NotFound(f"找不到來源 {source_id}")
    return source


def delete_source(session: Session, *, project_id: int, source_id: int, actor: str, source_ip: str | None) -> None:
    source = get_source(session, project_id, source_id)
    if session.scalar(select(FhirSchedule.id).where(FhirSchedule.source_id == source_id)) is not None:
        raise Conflict("仍有排程使用這個來源，請先刪除排程")
    _audit(session, actor=actor, action="fhir.source.delete", target=f"project:{project_id}/source:{source_id}",
           source_ip=source_ip, detail={"name": source.name})
    # 執行紀錄要留著：明確清掉參照（SQLite 預設不執行 ON DELETE SET NULL）
    session.execute(update(FhirRun).where(FhirRun.source_id == source_id).values(source_id=None))
    session.delete(source)
    session.commit()


# ---------- 對應規則 ----------

def mapping_out(m: FhirMapping) -> dict:
    return {"id": m.id, "project_id": m.project_id, "name": m.name, "source_kind": m.source_kind, "rules": m.rules,
            "resource_types": [r["resourceType"] for r in m.rules.get("resources", [])],
            "created_by": m.created_by, "updated_at": _iso(m.updated_at)}


def _check_rules(source_kind: str, rules) -> None:
    if source_kind not in sources.KINDS:
        raise Invalid(f"source_kind 必須是 {'、'.join(sources.KINDS)} 之一")
    problems = mapping_engine.validate_mapping(rules)
    if problems:
        raise Invalid("對應規則格式錯誤", {"problems": problems})


def create_mapping(session: Session, *, project_id: int, actor: str, source_ip: str | None, name: str,
                   source_kind: str, rules: dict) -> FhirMapping:
    name = _clean_name(name)
    _check_rules(source_kind, rules)
    if _name_taken(session, FhirMapping, project_id, name):
        raise Conflict(f"對應規則名稱 {name} 已存在")
    m = FhirMapping(project_id=project_id, name=name, source_kind=source_kind, rules=rules, created_by=actor)
    session.add(m)
    session.flush()
    _audit(session, actor=actor, action="fhir.mapping.create", target=f"project:{project_id}/mapping:{m.id}",
           source_ip=source_ip, detail={"name": name, "source_kind": source_kind})
    session.commit()
    return m


def create_builtin_mapping(session: Session, *, project_id: int, actor: str, source_ip: str | None,
                           builtin: str, name: str | None = None) -> FhirMapping:
    if builtin not in BUILTIN:
        raise Invalid(f"沒有內建規則 {builtin}（可用：{'、'.join(BUILTIN)}）")
    spec = BUILTIN[builtin]
    return create_mapping(session, project_id=project_id, actor=actor, source_ip=source_ip, name=name or builtin,
                          source_kind=spec["source_kind"], rules=spec["mapping"])


def list_mappings(session: Session, project_id: int) -> list[FhirMapping]:
    return list(session.scalars(select(FhirMapping).where(FhirMapping.project_id == project_id)
                                .order_by(FhirMapping.id)))


def get_mapping(session: Session, project_id: int, mapping_id: int) -> FhirMapping:
    m = session.get(FhirMapping, mapping_id)
    if m is None or m.project_id != project_id:
        raise NotFound(f"找不到對應規則 {mapping_id}")
    return m


def update_mapping(session: Session, *, project_id: int, mapping_id: int, actor: str, source_ip: str | None,
                   name: str | None, rules: dict | None) -> FhirMapping:
    m = get_mapping(session, project_id, mapping_id)
    if name is not None:
        name = _clean_name(name)
        if _name_taken(session, FhirMapping, project_id, name, except_id=m.id):
            raise Conflict(f"對應規則名稱 {name} 已存在")
        m.name = name
    if rules is not None:
        _check_rules(m.source_kind, rules)
        m.rules = rules
    m.updated_at = utcnow()
    _audit(session, actor=actor, action="fhir.mapping.update", target=f"project:{project_id}/mapping:{m.id}",
           source_ip=source_ip, detail={"name": m.name})
    session.commit()
    return m


def delete_mapping(session: Session, *, project_id: int, mapping_id: int, actor: str, source_ip: str | None
                   ) -> None:
    m = get_mapping(session, project_id, mapping_id)
    if session.scalar(select(FhirSchedule.id).where(FhirSchedule.mapping_id == mapping_id)) is not None:
        raise Conflict("仍有排程使用這組對應規則，請先刪除排程")
    _audit(session, actor=actor, action="fhir.mapping.delete", target=f"project:{project_id}/mapping:{m.id}",
           source_ip=source_ip, detail={"name": m.name})
    session.execute(update(FhirRun).where(FhirRun.mapping_id == mapping_id).values(mapping_id=None))
    session.delete(m)
    session.commit()


def preview(rules, records) -> list[dict]:
    """對應工具的預覽：逐筆回傳轉出的資源或拒絕原因，不寫入任何地方。"""
    problems = mapping_engine.validate_mapping(rules)
    if problems:
        raise Invalid("對應規則格式錯誤", {"problems": problems})
    if not isinstance(records, list) or not all(isinstance(r, dict) for r in records):
        raise Invalid("records 必須是物件陣列")
    if len(records) > MAX_PREVIEW_RECORDS:
        raise Invalid(f"預覽最多 {MAX_PREVIEW_RECORDS} 筆")
    out = []
    for index, row in enumerate(records):
        try:
            items = mapping_engine.apply(rules, row)
        except mapping_engine.RecordRejected as exc:
            out.append({"index": index, "ok": False, "reasons": exc.reasons, "resources": []})
            continue
        issues = [f"{i.resource['resourceType']}：{msg}" for i in items for msg in validate(i.resource)]
        out.append({"index": index, "ok": not issues, "reasons": issues, "resources": [i.resource for i in items]})
    return out


# ---------- 執行紀錄 ----------

def run_out(r: FhirRun) -> dict:
    deviation = None
    if r.planned_at is not None:
        deviation = round((_aware(r.started_at) - _aware(r.planned_at)).total_seconds(), 3)
    return {"id": r.id, "project_id": r.project_id, "trigger": r.trigger, "source_id": r.source_id,
            "mapping_id": r.mapping_id, "schedule_id": r.schedule_id, "actor": r.actor, "status": r.status,
            "records_read": r.records_read, "resources_written": r.resources_written, "errors": r.errors,
            "planned_at": _iso(r.planned_at), "started_at": _iso(r.started_at), "finished_at": _iso(r.finished_at),
            "deviation_seconds": deviation}


def _aware(value):
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)   # SQLite 讀回來不帶時區


def list_runs(session: Session, project_id: int, *, schedule_id: int | None = None, limit: int = 100
              ) -> list[FhirRun]:
    q = select(FhirRun).where(FhirRun.project_id == project_id)
    if schedule_id is not None:
        q = q.where(FhirRun.schedule_id == schedule_id)
    return list(session.scalars(q.order_by(FhirRun.id.desc()).limit(limit)))


def get_run(session: Session, project_id: int, run_id: int) -> FhirRun:
    r = session.get(FhirRun, run_id)
    if r is None or r.project_id != project_id:
        raise NotFound(f"找不到執行紀錄 {run_id}")
    return r


def check_resource_type(resource_type: str) -> str:
    if resource_type not in SUPPORTED_TYPES:
        raise NotFound(f"不支援的資源型別 {resource_type}（支援：{'、'.join(SUPPORTED_TYPES)}）")
    return resource_type


# ---------- 排程 ----------

MAX_INTERVAL_MINUTES = 7 * 24 * 60


def schedule_out(session: Session, s: FhirSchedule) -> dict:
    last = session.scalar(select(FhirRun).where(FhirRun.schedule_id == s.id).order_by(FhirRun.id.desc()).limit(1))
    return {"id": s.id, "project_id": s.project_id, "name": s.name, "source_id": s.source_id,
            "mapping_id": s.mapping_id, "interval_minutes": s.interval_minutes, "enabled": s.enabled,
            "next_run_at": _iso(_aware(s.next_run_at)), "last_run_at": _iso(_aware(s.last_run_at)) if s.last_run_at
            else None, "created_by": s.created_by, "last_run": run_out(last) if last else None}


def _check_interval(minutes: int) -> int:
    if not 1 <= minutes <= MAX_INTERVAL_MINUTES:
        raise Invalid(f"interval_minutes 必須介於 1 與 {MAX_INTERVAL_MINUTES}")
    return minutes


def create_schedule(session: Session, *, project_id: int, actor: str, source_ip: str | None, name: str,
                    source_id: int, mapping_id: int, interval_minutes: int, enabled: bool = True,
                    start_at: datetime | None = None, now=utcnow) -> FhirSchedule:
    name = _clean_name(name)
    _check_interval(interval_minutes)
    source = get_source(session, project_id, source_id)
    mapping = get_mapping(session, project_id, mapping_id)
    if mapping.source_kind != source.kind:
        raise Invalid(f"對應規則適用的來源類型是 {mapping.source_kind}，與來源的 {source.kind} 不符")
    if _name_taken(session, FhirSchedule, project_id, name):
        raise Conflict(f"排程名稱 {name} 已存在")
    first = _aware(start_at) if start_at else now() + timedelta(minutes=interval_minutes)
    s = FhirSchedule(project_id=project_id, name=name, source_id=source_id, mapping_id=mapping_id,
                     interval_minutes=interval_minutes, enabled=enabled, next_run_at=first, created_by=actor)
    session.add(s)
    session.flush()
    _audit(session, actor=actor, action="fhir.schedule.create", target=f"project:{project_id}/schedule:{s.id}",
           source_ip=source_ip, detail={"name": name, "interval_minutes": interval_minutes,
                                        "source_id": source_id, "mapping_id": mapping_id})
    session.commit()
    return s


def list_schedules(session: Session, project_id: int) -> list[FhirSchedule]:
    return list(session.scalars(select(FhirSchedule).where(FhirSchedule.project_id == project_id)
                                .order_by(FhirSchedule.id)))


def get_schedule(session: Session, project_id: int, schedule_id: int) -> FhirSchedule:
    s = session.get(FhirSchedule, schedule_id)
    if s is None or s.project_id != project_id:
        raise NotFound(f"找不到排程 {schedule_id}")
    return s


def update_schedule(session: Session, *, project_id: int, schedule_id: int, actor: str, source_ip: str | None,
                    name: str | None = None, interval_minutes: int | None = None, enabled: bool | None = None,
                    now=utcnow) -> FhirSchedule:
    s = get_schedule(session, project_id, schedule_id)
    changes: dict = {}
    if name is not None:
        name = _clean_name(name)
        if _name_taken(session, FhirSchedule, project_id, name, except_id=s.id):
            raise Conflict(f"排程名稱 {name} 已存在")
        s.name = changes["name"] = name
    reschedule = False
    if interval_minutes is not None and interval_minutes != s.interval_minutes:
        s.interval_minutes = changes["interval_minutes"] = _check_interval(interval_minutes)
        reschedule = True
    if enabled is not None and enabled != s.enabled:
        s.enabled = changes["enabled"] = enabled
        reschedule = reschedule or enabled
    if reschedule:   # 改間隔或重新啟用：從現在起算，不補跑停用期間的時間點
        s.next_run_at = now() + timedelta(minutes=s.interval_minutes)
    _audit(session, actor=actor, action="fhir.schedule.update", target=f"project:{project_id}/schedule:{s.id}",
           source_ip=source_ip, detail=changes)
    session.commit()
    return s


def delete_schedule(session: Session, *, project_id: int, schedule_id: int, actor: str, source_ip: str | None
                    ) -> None:
    s = get_schedule(session, project_id, schedule_id)
    _audit(session, actor=actor, action="fhir.schedule.delete", target=f"project:{project_id}/schedule:{s.id}",
           source_ip=source_ip, detail={"name": s.name})
    session.execute(update(FhirRun).where(FhirRun.schedule_id == schedule_id).values(schedule_id=None))
    session.delete(s)
    session.commit()
