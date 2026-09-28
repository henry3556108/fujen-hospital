from sqlalchemy import select

from app.audit import AuditCategory, record
from app.models import AuditLog


def test_eight_audit_categories():
    assert {c.value for c in AuditCategory} == {
        "account", "role", "permission", "project", "dataset", "training", "inference", "data_exchange",
    }


def test_tc_ss_06_audit_record_has_required_fields(session):
    record(session, actor="admin01", category=AuditCategory.PROJECT, action="create",
           target="project:1", source_ip="10.0.0.5", detail={"name": "P1"})
    session.commit()

    entry = session.scalars(select(AuditLog)).one()
    assert entry.actor == "admin01"
    assert entry.category == "project"
    assert entry.action == "create"
    assert entry.target == "project:1"
    assert entry.result == "success"
    assert entry.source_ip == "10.0.0.5"
    assert entry.detail == {"name": "P1"}
    assert entry.at is not None


def test_audit_is_part_of_caller_transaction(session):
    record(session, actor="admin01", category=AuditCategory.ACCOUNT, action="create", target="user:9")
    session.rollback()
    assert session.scalars(select(AuditLog)).all() == []
