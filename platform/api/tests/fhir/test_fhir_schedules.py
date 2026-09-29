from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from app.fhir import scheduler, service
from app.fhir.models import FhirRun, FhirSchedule
from app.models import AuditLog

T0 = datetime(2026, 10, 1, 8, 0, 0, tzinfo=timezone.utc)


class Clock:
    def __init__(self, now=T0):
        self.now = now

    def __call__(self):
        return self.now

    def advance(self, **kwargs):
        self.now += timedelta(**kwargs)


@pytest.fixture
def p1(make_project):
    return make_project("P1-lung-ct")


@pytest.fixture
def base(p1):
    return f"/api/projects/{p1.id}/fhir"


@pytest.fixture
def pairs(client, admin, base, clinical, his_dsn):
    """三組（來源, 對應規則）：SQL→Patient、CSV→Encounter、JSON→Observation。"""
    specs = [("sql", "sql-patient", {"config": {"dsn": his_dsn, "query": "SELECT * FROM patients"}}),
             ("csv", "csv-encounter", {"content": (clinical / "encounters.csv").read_text(encoding="utf-8")}),
             ("json", "json-lab-observation", {"content": (clinical / "labs.json").read_text(encoding="utf-8")})]
    out = []
    for kind, builtin, extra in specs:
        source = client.post(f"{base}/sources", headers=admin, json={"name": kind, "kind": kind, **extra}).json()
        mapping = client.post(f"{base}/mappings", headers=admin, json={"builtin": builtin}).json()
        out.append((source["id"], mapping["id"]))
    return out


def test_next_slot_skips_missed_runs():
    assert scheduler.next_slot(T0, 5, T0) == T0 + timedelta(minutes=5)
    assert scheduler.next_slot(T0, 5, T0 + timedelta(minutes=4)) == T0 + timedelta(minutes=5)
    assert scheduler.next_slot(T0, 5, T0 + timedelta(minutes=5)) == T0 + timedelta(minutes=10)
    assert scheduler.next_slot(T0, 5, T0 + timedelta(hours=2, seconds=1)) == T0 + timedelta(minutes=125)
    assert scheduler.next_slot(T0.replace(tzinfo=None), 1, T0) == T0 + timedelta(minutes=1)


def test_tc_c03_06_three_schedules_run_within_five_minutes_of_plan(app, session, fhir, p1, pairs):
    clock = Clock()
    intervals = [1, 5, 15]
    for (source_id, mapping_id), minutes in zip(pairs, intervals):
        service.create_schedule(session, project_id=p1.id, actor="admin01", source_ip=None, name=f"every-{minutes}",
                                source_id=source_id, mapping_id=mapping_id, interval_minutes=minutes, now=clock)
    make_session = app.state.sessionmaker
    assert scheduler.run_due(make_session, fhir, now=clock) == []      # 還沒到時間
    for _ in range(31 * 12):                                              # worker 每 5 秒檢查一次，共 31 分鐘
        clock.advance(seconds=5)
        scheduler.run_due(make_session, fhir, now=clock)
    runs = list(session.scalars(select(FhirRun).order_by(FhirRun.id)))
    by_schedule = {}
    for run in runs:
        by_schedule.setdefault(run.schedule_id, []).append(run)
    assert sorted(len(v) for v in by_schedule.values()) == [2, 6, 31]
    for run in runs:
        out = service.run_out(run)
        assert out["trigger"] == "schedule" and out["actor"] == "fhir-scheduler"
        assert 0 <= out["deviation_seconds"] < 300, out
    # 第一次執行時病人還沒寫入的就診、檢驗會整批失敗；病人排程跑過之後就成功
    assert {r.status for r in by_schedule[1]} == {"succeeded"}
    assert by_schedule[2][-1].status == "succeeded" and by_schedule[3][-1].status == "succeeded"
    assert fhir.count(p1.id, "Patient") == 20 and fhir.count(p1.id, "Encounter") == 20
    planned = [scheduler.aware(r.planned_at) for r in by_schedule[2]]
    assert planned == [T0 + timedelta(minutes=5 * i) for i in range(1, 7)]


def test_two_workers_do_not_run_the_same_slot_twice(app, session, fhir, p1, pairs):
    clock = Clock()
    service.create_schedule(session, project_id=p1.id, actor="admin01", source_ip=None, name="s", now=clock,
                            source_id=pairs[0][0], mapping_id=pairs[0][1], interval_minutes=1)
    clock.advance(seconds=61)
    first = scheduler.run_due(app.state.sessionmaker, fhir, now=clock, source_ip="172.18.0.5")
    second = scheduler.run_due(app.state.sessionmaker, fhir, now=clock)   # 另一份 worker 同一時間檢查
    assert len(first) == 1 and second == []
    audit = session.scalars(select(AuditLog).where(AuditLog.action == "fhir.etl.run")).one()
    assert (audit.actor, audit.source_ip) == ("fhir-scheduler", "172.18.0.5")


def test_worker_downtime_runs_once_and_reports_the_delay(app, session, fhir, p1, pairs):
    clock = Clock()
    service.create_schedule(session, project_id=p1.id, actor="admin01", source_ip=None, name="s", now=clock,
                            source_id=pairs[0][0], mapping_id=pairs[0][1], interval_minutes=5)
    clock.advance(minutes=47)
    [run_id] = scheduler.run_due(app.state.sessionmaker, fhir, now=clock)
    out = service.run_out(session.get(FhirRun, run_id))
    assert out["deviation_seconds"] == 42 * 60          # 如實記錄延遲，不美化
    assert scheduler.aware(session.scalars(select(FhirSchedule)).one().next_run_at) == T0 + timedelta(minutes=50)


def test_disabled_schedule_does_not_run(app, session, fhir, p1, pairs):
    clock = Clock()
    s = service.create_schedule(session, project_id=p1.id, actor="admin01", source_ip=None, name="s", now=clock,
                                source_id=pairs[0][0], mapping_id=pairs[0][1], interval_minutes=1)
    service.update_schedule(session, project_id=p1.id, schedule_id=s.id, actor="admin01", source_ip=None,
                            enabled=False, now=clock)
    clock.advance(minutes=10)
    assert scheduler.run_due(app.state.sessionmaker, fhir, now=clock) == []
    service.update_schedule(session, project_id=p1.id, schedule_id=s.id, actor="admin01", source_ip=None,
                            enabled=True, now=clock)
    clock.advance(seconds=59)
    assert scheduler.run_due(app.state.sessionmaker, fhir, now=clock) == []
    clock.advance(seconds=2)
    assert len(scheduler.run_due(app.state.sessionmaker, fhir, now=clock)) == 1


def test_schedule_api_crud_and_reload(client, admin, base, pairs, session):
    created = []
    for index, (source_id, mapping_id) in enumerate(pairs):
        response = client.post(f"{base}/schedules", headers=admin, json={
            "name": f"sched-{index}", "source_id": source_id, "mapping_id": mapping_id,
            "interval_minutes": 5 * (index + 1)})
        assert response.status_code == 201, response.text
        created.append(response.json())
    listed = client.get(f"{base}/schedules", headers=admin).json()
    assert [(s["name"], s["interval_minutes"], s["enabled"]) for s in listed] == [
        ("sched-0", 5, True), ("sched-1", 10, True), ("sched-2", 15, True)]
    patched = client.patch(f"{base}/schedules/{created[0]['id']}", headers=admin,
                           json={"interval_minutes": 30, "enabled": False})
    assert patched.status_code == 200 and (patched.json()["interval_minutes"], patched.json()["enabled"]) == (30, False)
    assert client.delete(f"{base}/sources/{pairs[1][0]}", headers=admin).status_code == 409
    assert client.delete(f"{base}/mappings/{pairs[1][1]}", headers=admin).status_code == 409
    assert client.delete(f"{base}/schedules/{created[1]['id']}", headers=admin).status_code == 204
    assert client.delete(f"{base}/sources/{pairs[1][0]}", headers=admin).status_code == 204
    assert len(client.get(f"{base}/schedules", headers=admin).json()) == 2
    actions = [a.action for a in session.scalars(select(AuditLog).where(AuditLog.action.like("fhir.schedule.%")))]
    assert actions == ["fhir.schedule.create"] * 3 + ["fhir.schedule.update", "fhir.schedule.delete"]


@pytest.mark.parametrize("patch, status", [
    ({"interval_minutes": 0}, 422), ({"interval_minutes": 10081}, 422), ({"source_id": 999}, 404),
    ({"mapping_id": 999}, 404), ({"name": ""}, 422),
])
def test_invalid_schedules(client, admin, base, pairs, patch, status):
    body = {"name": "s", "source_id": pairs[0][0], "mapping_id": pairs[0][1], "interval_minutes": 5, **patch}
    assert client.post(f"{base}/schedules", headers=admin, json=body).status_code == status


def test_schedule_with_mismatched_mapping_is_rejected(client, admin, base, pairs):
    body = {"name": "s", "source_id": pairs[0][0], "mapping_id": pairs[1][1], "interval_minutes": 5}
    assert client.post(f"{base}/schedules", headers=admin, json=body).status_code == 422
