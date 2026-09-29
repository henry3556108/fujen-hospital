from sqlalchemy import func, select

from app.models import Membership, Project, User
from app.seed import DEV_PASSWORD, reset_and_seed


def test_seed_creates_baseline(session, idp):
    idp.create_user("admin01", "Admin01-dev!")
    summary = reset_and_seed(session, idp, admin_username="admin01")

    assert sorted(summary["projects"]) == ["P1-lung-ct", "P2-tabular", "P3-llm"]
    assert session.scalar(select(func.count()).select_from(User)) == 8
    assert session.scalar(select(func.count()).select_from(Membership)) == 5
    assert idp.check_password("vw01", DEV_PASSWORD)
    p1 = session.scalar(select(Project).where(Project.name == "P1-lung-ct"))
    assert p1.gpu_group == "gpu-exclusive"


def test_seed_is_repeatable(session, idp):
    idp.create_user("admin01", "Admin01-dev!")
    reset_and_seed(session, idp, admin_username="admin01")
    reset_and_seed(session, idp, admin_username="admin01")
    assert session.scalar(select(func.count()).select_from(User)) == 8
    assert idp.check_password("admin01", "Admin01-dev!")  # Admin 不被重設


def test_seed_resyncs_admin_subject_after_identity_provider_reset(session, idp):
    old = idp.create_user("admin01", "Admin01-dev!")
    reset_and_seed(session, idp, admin_username="admin01")
    idp.delete_user(old)                       # 例如 Keycloak 資料庫重建
    new = idp.create_user("admin01", "Admin01-dev!")
    reset_and_seed(session, idp, admin_username="admin01")
    admin = session.scalar(select(User).where(User.username == "admin01"))
    assert admin.idp_subject == new


def test_seed_reset_writes_audit(session, idp):
    from app.models import AuditLog

    idp.create_user("admin01", "Admin01-dev!")
    reset_and_seed(session, idp, admin_username="admin01")
    reset_and_seed(session, idp, admin_username="admin01")

    resets = session.scalars(select(AuditLog).where(AuditLog.action == "seed.reset").order_by(AuditLog.id)).all()
    assert len(resets) == 2                                  # 每次重設 1 筆；稽核表本身不被清掉
    first, second = resets
    assert (first.actor, first.category, first.target, first.result) == ("admin01", "project", "baseline", "success")
    assert first.detail == {"removed": {"users": 0, "projects": 0, "memberships": 0}}
    assert second.detail == {"removed": {"users": 7, "projects": 3, "memberships": 5}}


def test_seed_audit_rows_carry_a_source(session, idp):
    """種子沒有網路來源，稽核來源欄記 local:seed 而不是留空（TC-D01-05 欄位缺漏 0）。"""
    from app.models import AuditLog
    from app.seed import SEED_SOURCE, reset_and_seed

    idp.create_user("admin01", "x")
    reset_and_seed(session, idp, admin_username="admin01")
    rows = session.scalars(select(AuditLog)).all()
    assert rows and {r.source_ip for r in rows} == {SEED_SOURCE}
