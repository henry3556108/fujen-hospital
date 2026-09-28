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
