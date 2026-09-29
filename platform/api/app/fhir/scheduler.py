"""排程：定時抓取、轉換、轉存。由獨立的 worker 程序輪詢（app/fhir/worker.py）。

認領與執行分兩步：先在一個交易裡把到期的排程鎖住並推進 next_run_at（多份 worker 同時跑也不會重複認領），
再逐一執行。執行紀錄記下排定時間（planned_at）與實際開始時間，偏差＝兩者相減（TC-C03-06）。
"""
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.fhir import etl
from app.fhir.client import FhirClient
from app.fhir.models import FhirMapping, FhirRun, FhirSchedule, FhirSource
from app.models import Project, utcnow

SCHEDULER_ACTOR = "fhir-scheduler"


@dataclass(frozen=True)
class Claim:
    schedule_id: int
    planned_at: datetime


def aware(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)   # SQLite 讀回來不帶時區


def next_slot(planned: datetime, interval_minutes: int, now: datetime) -> datetime:
    """下一個晚於 now 的時間點。worker 停機期間錯過的時間點不補跑，只跑一次。"""
    step = timedelta(minutes=interval_minutes)
    following = aware(planned) + step
    if following <= now:
        missed = (now - following) // step + 1
        following += step * missed
    return following


def claim_due(session: Session, now: datetime) -> list[Claim]:
    rows = session.scalars(
        select(FhirSchedule).where(FhirSchedule.enabled.is_(True), FhirSchedule.next_run_at <= now)
        .order_by(FhirSchedule.next_run_at).with_for_update(skip_locked=True)).all()
    claims = []
    for schedule in rows:
        claims.append(Claim(schedule.id, aware(schedule.next_run_at)))
        schedule.next_run_at = next_slot(schedule.next_run_at, schedule.interval_minutes, now)
        schedule.last_run_at = now
    session.commit()
    return claims


def run_claim(session: Session, client: FhirClient, claim: Claim, now=utcnow,
              source_ip: str | None = None) -> FhirRun | None:
    schedule = session.get(FhirSchedule, claim.schedule_id)
    if schedule is None:
        return None
    project = session.get(Project, schedule.project_id)
    source = session.get(FhirSource, schedule.source_id)
    mapping = session.get(FhirMapping, schedule.mapping_id)
    if project is None or source is None or mapping is None:
        return None
    return etl.run_etl(session, client, project=project, source=source, mapping=mapping, actor=SCHEDULER_ACTOR,
                       source_ip=source_ip, trigger="schedule", schedule_id=schedule.id, planned_at=claim.planned_at, now=now)


def run_due(make_session: sessionmaker, client: FhirClient, now=utcnow, source_ip: str | None = None) -> list[int]:
    """執行所有到期的排程，回傳執行紀錄編號。單一排程出錯不影響其他排程。
    source_ip：稽核的來源 IP，排程由 worker 發起，記 worker 自己的位址。"""
    with make_session() as session:
        claims = claim_due(session, now())
    run_ids = []
    for claim in claims:
        with make_session() as session:
            run = run_claim(session, client, claim, now=now, source_ip=source_ip)
            if run is not None:
                run_ids.append(run.id)
    return run_ids
