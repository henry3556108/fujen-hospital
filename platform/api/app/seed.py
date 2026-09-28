from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app import admin_service
from app.identity import IdentityProvider
from app.models import Membership, Project, User
from app.permissions import AccountType, Role

DEV_PASSWORD = "Dev-Passw0rd!"  # 只用於本機與測試環境的種子帳號

PROJECTS = [
    ("P1-lung-ct", "影像專案", "gpu-exclusive"),
    ("P2-tabular", "結構式資料專案", "gpu-shared"),
    ("P3-llm", "LLM 專案", "gpu-exclusive"),
]
P1_MEMBERS = [
    ("pi01", Role.PRINCIPAL_INVESTIGATOR),
    ("md01", Role.MEDICAL_DOCTOR),
    ("ra01", Role.RESEARCH_ASSISTANT),
    ("ca01", Role.CODER_ASSISTANT),
    ("vw01", Role.VIEWER),
]
OUTSIDERS = ["user01", "user02"]


def _fresh_user(session: Session, idp: IdentityProvider, actor: str, username: str) -> User:
    stale = idp.find_subject(username)
    if stale:
        idp.delete_user(stale)
    return admin_service.create_user(session, idp, actor=actor, username=username,
                                     password=DEV_PASSWORD, account_type=AccountType.USER)


def reset_and_seed(session: Session, idp: IdentityProvider, *, admin_username: str) -> dict:
    subject = idp.find_subject(admin_username)
    if subject is None:
        raise RuntimeError(f"身分提供者中找不到 {admin_username}")
    admin = session.scalar(select(User).where(User.username == admin_username))
    if admin is None:
        admin = User(username=admin_username, account_type=AccountType.ADMIN.value, idp_subject=subject)
        session.add(admin)
    else:
        admin.idp_subject = subject  # 身分提供者重建後 subject 會變，以它為準
        admin.account_type = AccountType.ADMIN.value
    session.commit()

    session.execute(delete(Membership))
    for user in session.scalars(select(User).where(User.id != admin.id)).all():
        idp.delete_user(user.idp_subject)
        session.delete(user)
    session.execute(delete(Project))
    session.commit()

    actor = admin.username
    projects = {
        name: admin_service.create_project(session, actor=actor, name=name, description=desc, gpu_group=group)
        for name, desc, group in PROJECTS
    }
    for username, role in P1_MEMBERS:
        user = _fresh_user(session, idp, actor, username)
        admin_service.set_membership(session, actor=actor, project_id=projects["P1-lung-ct"].id,
                                     user_id=user.id, role=role)
    for username in OUTSIDERS:
        _fresh_user(session, idp, actor, username)

    return {"projects": list(projects), "users": [admin_username] + [u for u, _ in P1_MEMBERS] + OUTSIDERS}


if __name__ == "__main__":
    import json
    import os

    from app.asgi import app, idp

    with app.state.sessionmaker() as s:
        print(json.dumps(reset_and_seed(s, idp, admin_username=os.environ.get("SEED_ADMIN", "admin01")),
                         ensure_ascii=False, indent=2))
