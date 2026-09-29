"""資料交換的執行：來源 → 對應規則 → 驗證 → 一個 Transaction。

不論成功、資料不合格（rejected）或寫入失敗（failed），都留下一筆 FhirRun 與一筆 data_exchange 稽核，
兩者在同一個資料庫交易內。寫入 FHIR 伺服器只有一次呼叫（整批），所以不會有寫到一半的狀態。
"""
from collections import Counter
from datetime import datetime

from sqlalchemy.orm import Session

from app.audit import AuditCategory, record
from app.fhir import hl7v2, mapping as mapping_engine
from app.fhir.client import FhirClient, FhirError, FhirUnavailable
from app.fhir.mapping import BUILTIN, Mapped, RecordRejected
from app.fhir.models import FhirMapping, FhirRun, FhirSource
from app.fhir.resources import validate
from app.fhir.sources import SourceError, read_records
from app.models import Project, utcnow

MAX_ERRORS = 50          # FhirRun.errors 最多保留幾筆原因
MAX_VITALS_BATCH = 500   # 一次請求最多幾筆監視器讀數
VITAL_FIELDS = ("device_id", "patient_id", "sequence", "timestamp", "heart_rate", "spo2", "resp_rate")


def build_bundle(mapped: list[Mapped]) -> dict:
    """同一批內相同條件（同一識別碼）的資源只留最後一筆：來源若重複列出同一個病人，以後者為準。"""
    latest: dict[str, Mapped] = {}
    for item in mapped:
        latest.pop(item.condition, None)
        latest[item.condition] = item
    return {"resourceType": "Bundle", "type": "transaction", "entry": [
        {"resource": item.resource, "request": {"method": "PUT", "url": condition}}
        for condition, item in latest.items()]}


def map_records(rules: dict, records: list[dict]) -> tuple[list[Mapped], list[dict]]:
    """回傳（資源, 錯誤）。錯誤每筆含來源記錄的索引（0 起算）與原因。"""
    mapped: list[Mapped] = []
    errors: list[dict] = []
    for index, row in enumerate(records):
        try:
            items = mapping_engine.apply(rules, row)
        except RecordRejected as exc:
            errors.append({"index": index, "reasons": exc.reasons})
            continue
        issues = [f"{item.resource['resourceType']}：{issue}" for item in items for issue in validate(item.resource)]
        if issues:
            errors.append({"index": index, "reasons": issues})
        else:
            mapped.extend(items)
    return mapped, errors


def _finish(session: Session, run: FhirRun, *, status: str, action: str, target: str, source_ip: str | None,
            errors: list[dict] | None = None, written: dict | None = None, now=utcnow, detail: dict | None = None
            ) -> FhirRun:
    run.status = status
    run.errors = (errors or [])[:MAX_ERRORS]
    run.resources_written = written or {}
    run.finished_at = now()
    session.add(run)
    session.flush()
    record(session, actor=run.actor, category=AuditCategory.DATA_EXCHANGE, action=action, target=target,
           result="success" if status == "succeeded" else status, source_ip=source_ip,
           detail={"run_id": run.id, "trigger": run.trigger, "records_read": run.records_read,
                   "resources_written": run.resources_written, "error_count": len(errors or []),
                   **(detail or {})})
    session.commit()
    return run


def _write(session: Session, client: FhirClient, run: FhirRun, mapped: list[Mapped], *, action: str, target: str,
           source_ip: str | None, now, detail: dict | None = None) -> FhirRun:
    bundle = build_bundle(mapped)
    try:
        client.ensure_tenant(run.project_id)
        client.transaction(run.project_id, bundle)
    except FhirUnavailable as exc:
        return _finish(session, run, status="failed", action=action, target=target, source_ip=source_ip, now=now,
                       errors=[{"reasons": [exc.message, "整批未寫入；若連線在送出後中斷，請以查詢確認"]}],
                       detail={**(detail or {}), "unavailable": True})
    except FhirError as exc:
        return _finish(session, run, status="failed", action=action, target=target, source_ip=source_ip, now=now,
                       errors=[{"reasons": [exc.message]}], detail=detail)
    written = dict(Counter(e["resource"]["resourceType"] for e in bundle["entry"]))
    return _finish(session, run, status="succeeded", action=action, target=target, source_ip=source_ip,
                   written=written, now=now, detail=detail)


def run_etl(session: Session, client: FhirClient, *, project: Project, source: FhirSource, mapping: FhirMapping,
            actor: str, source_ip: str | None = None, trigger: str = "manual", schedule_id: int | None = None,
            planned_at: datetime | None = None, now=utcnow) -> FhirRun:
    run = FhirRun(project_id=project.id, trigger=trigger, source_id=source.id, mapping_id=mapping.id,
                  schedule_id=schedule_id, actor=actor, status="running", planned_at=planned_at, started_at=now())
    action, target = "fhir.etl.run", f"project:{project.id}/source:{source.id}"
    detail = {"source": source.name, "source_kind": source.kind, "mapping": mapping.name}
    common = dict(action=action, target=target, source_ip=source_ip, now=now, detail=detail)
    if mapping.source_kind != source.kind:
        return _finish(session, run, status="rejected", **common, errors=[{"reasons": [
            f"對應規則適用的來源類型是 {mapping.source_kind}，與來源的 {source.kind} 不符"]}])
    try:
        records = read_records(source.kind, source.config or {}, source.content)
    except SourceError as exc:
        return _finish(session, run, status="rejected", **common,
                       errors=exc.items or [{"reasons": [exc.message]}])
    run.records_read = len(records)
    mapped, errors = map_records(mapping.rules, records)
    if errors:
        return _finish(session, run, status="rejected", **common, errors=errors)
    if not mapped:
        return _finish(session, run, status="succeeded", **common)
    return _write(session, client, run, mapped, **common)


def ingest_hl7(session: Session, client: FhirClient, *, project: Project, raw: str | bytes, actor: str,
               source_ip: str | None = None, rules: dict | None = None, now=utcnow) -> FhirRun:
    """單則 HL7 V2：一則訊息的 Patient 與 Encounter 在同一個 Transaction。"""
    run = FhirRun(project_id=project.id, trigger="hl7v2", actor=actor, status="running", started_at=now())
    action, target = "fhir.hl7v2.receive", f"project:{project.id}/hl7v2"
    try:
        row = hl7v2.to_record(raw)
    except hl7v2.Hl7Rejected as exc:
        return _finish(session, run, status="rejected", action=action, target=target, source_ip=source_ip, now=now,
                       errors=[{"control_id": exc.control_id, "reasons": exc.reasons}],
                       detail={"control_id": exc.control_id})
    run.records_read = 1
    detail = {"control_id": row["message_control_id"], "message_type": row["message_type"]}
    common = dict(action=action, target=target, source_ip=source_ip, now=now, detail=detail)
    mapped, errors = map_records(rules or BUILTIN["hl7v2-adt"]["mapping"], [row])
    if errors:
        return _finish(session, run, status="rejected", **common,
                       errors=[{"control_id": row["message_control_id"], "reasons": errors[0]["reasons"]}])
    return _write(session, client, run, mapped, **common)


def ingest_vitals(session: Session, client: FhirClient, *, project: Project, readings: list[dict], actor: str,
                  source_ip: str | None = None, now=utcnow) -> FhirRun:
    """生理監視器讀數：每筆讀數轉成心率、血氧、呼吸速率三個 Observation；同一次請求的讀數同一個 Transaction。"""
    run = FhirRun(project_id=project.id, trigger="vitals", actor=actor, status="running", started_at=now(),
                  records_read=len(readings))
    devices = sorted({str(r.get("device_id")) for r in readings if isinstance(r, dict) and r.get("device_id")})
    common = dict(action="fhir.vitals.receive", target=f"project:{project.id}/vitals", source_ip=source_ip,
                  now=now, detail={"devices": devices[:10]})
    errors = [{"index": i, "reasons": ["讀數必須是物件"]} for i, r in enumerate(readings) if not isinstance(r, dict)]
    if not errors:
        mapped, errors = map_records(BUILTIN["monitor-vitals"]["mapping"], readings)
    if errors:
        return _finish(session, run, status="rejected", **common, errors=errors)
    return _write(session, client, run, mapped, **common)
