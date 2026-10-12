from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app import admin_service, project_cleanup
from app.audit import AuditCategory, record
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


# 種子由命令列執行，沒有網路來源；稽核的來源欄記成這個標記，而不是留空（TC-D01-05 要求欄位無缺漏）
SEED_SOURCE = "local:seed"


def _fresh_user(session: Session, idp: IdentityProvider, actor: str, username: str) -> User:
    stale = idp.find_subject(username)
    if stale:
        idp.delete_user(stale)
    return admin_service.create_user(session, idp, actor=actor, username=username,
                                     password=DEV_PASSWORD, account_type=AccountType.USER,
                                     source_ip=SEED_SOURCE)


def reset_and_seed(session: Session, idp: IdentityProvider, *, admin_username: str, store=None,
                   orthanc=None, fhir=None, jobs=None, inference=None) -> dict:
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

    others = session.scalars(select(User).where(User.id != admin.id)).all()
    removed = {"users": len(others),
               "projects": session.scalar(select(func.count()).select_from(Project)),
               "memberships": session.scalar(select(func.count()).select_from(Membership))}
    session.execute(delete(Membership))
    for user in others:
        idp.delete_user(user.idp_subject)
        session.delete(user)
    for project_id in session.scalars(select(Project.id)).all():
        project_cleanup.stage(session, project_id, fhir=fhir is not None,   # 索引列與待清理清單；外部資料在 commit 後才清
                              inference=inference is not None)
    session.execute(delete(Project))
    # 稽核表不清；重設本身記 1 筆（管理設定歸 project 類），與清除同一個交易
    record(session, actor=admin.username, category=AuditCategory.PROJECT, action="seed.reset",
           target="baseline", source_ip=SEED_SOURCE, detail={"removed": removed})
    session.commit()
    project_cleanup.run_pending(session, store, orthanc, actor=admin.username, source_ip=SEED_SOURCE, fhir=fhir,
                                jobs=jobs, inference=inference)

    actor = admin.username
    projects = {
        name: admin_service.create_project(session, actor=actor, name=name, description=desc, gpu_group=group,
                                           source_ip=SEED_SOURCE)
        for name, desc, group in PROJECTS
    }
    for username, role in P1_MEMBERS:
        user = _fresh_user(session, idp, actor, username)
        admin_service.set_membership(session, actor=actor, project_id=projects["P1-lung-ct"].id,
                                     user_id=user.id, role=role, source_ip=SEED_SOURCE)
    for username in OUTSIDERS:
        _fresh_user(session, idp, actor, username)

    return {"projects": list(projects), "users": [admin_username] + [u for u, _ in P1_MEMBERS] + OUTSIDERS}


if __name__ == "__main__":
    import json
    import os

    from app.asgi import app, idp

    with app.state.sessionmaker() as s:
        print(json.dumps(reset_and_seed(s, idp, admin_username=os.environ.get("SEED_ADMIN", "admin01"),
                                        store=app.state.store, orthanc=getattr(app.state, "orthanc", None),
                                        fhir=project_cleanup.fhir_client(app.state),
                                        jobs=project_cleanup.job_backend(app.state),
                                        inference=project_cleanup.inference_backend(app.state)),
                         ensure_ascii=False, indent=2))
