from sqlalchemy import func, select

from app.bootstrap_admin import ensure_admin
from app.models import AuditLog, Project, User
from app.permissions import AccountType


def test_registers_initial_admin_without_test_data(session, idp):
    subject = idp.create_user("admin01", "x")
    assert ensure_admin(session, idp, "admin01") == {"admin": "admin01", "changed": True, "created": True}
    admin = session.scalar(select(User).where(User.username == "admin01"))
    assert admin.idp_subject == subject and admin.account_type == AccountType.ADMIN.value
    assert session.scalar(select(func.count()).select_from(User)) == 1
    assert session.scalar(select(func.count()).select_from(Project)) == 0
    audit = session.scalars(select(AuditLog).where(AuditLog.action == "admin.bootstrap")).all()
    assert len(audit) == 1 and audit[0].category == "account"


def test_is_repeatable_and_resyncs_subject(session, idp):
    old = idp.create_user("admin01", "x")
    ensure_admin(session, idp, "admin01")
    assert ensure_admin(session, idp, "admin01")["changed"] is False
    idp.delete_user(old)
    new = idp.create_user("admin01", "x")
    assert ensure_admin(session, idp, "admin01")["created"] is False
    assert session.scalar(select(User).where(User.username == "admin01")).idp_subject == new
    assert session.scalar(select(func.count()).select_from(User)) == 1


def test_missing_identity_fails(session, idp):
    import pytest

    with pytest.raises(RuntimeError):
        ensure_admin(session, idp, "admin01")
