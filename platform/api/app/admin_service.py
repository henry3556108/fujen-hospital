from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.audit import AuditCategory, record
from app.identity import IdentityProvider
from app.models import Membership, Project, User
from app.permissions import AccountType


class Conflict(Exception):
    pass


class NotFound(Exception):
    pass


def _get(session: Session, model, obj_id: int):
    obj = session.get(model, obj_id)
    if obj is None:
        raise NotFound(f"找不到 {model.__tablename__} {obj_id}")
    return obj


def create_project(session: Session, *, actor: str, name: str, description: str = "",
                   gpu_group: str | None = None, source_ip: str | None = None) -> Project:
    if session.scalar(select(Project).where(Project.name == name)):
        raise Conflict(f"專案名稱「{name}」已存在")
    project = Project(name=name, description=description, gpu_group=gpu_group)
    session.add(project)
    session.flush()
    record(session, actor=actor, category=AuditCategory.PROJECT, action="create",
           target=f"project:{project.id}", source_ip=source_ip,
           detail={"name": name, "gpu_group": gpu_group})
    session.commit()
    return project


def update_project(session: Session, *, actor: str, project_id: int, changes: dict,
                   source_ip: str | None = None) -> Project:
    project = _get(session, Project, project_id)
    new_name = changes.get("name")
    if new_name and new_name != project.name and session.scalar(select(Project).where(Project.name == new_name)):
        raise Conflict(f"專案名稱「{new_name}」已存在")
    for key, value in changes.items():
        setattr(project, key, value)
    record(session, actor=actor, category=AuditCategory.PROJECT, action="update",
           target=f"project:{project.id}", source_ip=source_ip, detail=changes)
    session.commit()
    return project


def delete_project(session: Session, *, actor: str, project_id: int, source_ip: str | None = None) -> None:
    project = _get(session, Project, project_id)
    session.execute(delete(Membership).where(Membership.project_id == project_id))
    session.delete(project)
    record(session, actor=actor, category=AuditCategory.PROJECT, action="delete",
           target=f"project:{project_id}", source_ip=source_ip, detail={"name": project.name})
    session.commit()


def _admin_count(session: Session) -> int:
    return session.scalar(select(func.count()).select_from(User).where(User.account_type == AccountType.ADMIN))


def create_user(session: Session, idp: IdentityProvider, *, actor: str, username: str, password: str,
                account_type: AccountType, source_ip: str | None = None) -> User:
    if session.scalar(select(User).where(User.username == username)):
        raise Conflict(f"帳號「{username}」已存在")
    subject = idp.create_user(username, password)
    try:
        user = User(username=username, account_type=account_type.value, idp_subject=subject)
        session.add(user)
        session.flush()
        record(session, actor=actor, category=AuditCategory.ACCOUNT, action="create", target=f"user:{user.id}",
               source_ip=source_ip, detail={"username": username, "account_type": account_type.value})
        session.commit()
    except Exception:
        session.rollback()
        idp.delete_user(subject)  # 補償：資料庫失敗時不留下孤兒帳號
        raise
    return user


def update_user(session: Session, *, actor: str, user_id: int, account_type: AccountType,
                source_ip: str | None = None) -> User:
    user = _get(session, User, user_id)
    if user.account_type == AccountType.ADMIN and account_type != AccountType.ADMIN and _admin_count(session) <= 1:
        raise Conflict("至少要保留 1 個 Admin")
    before = user.account_type
    user.account_type = account_type.value
    record(session, actor=actor, category=AuditCategory.ACCOUNT, action="update", target=f"user:{user.id}",
           source_ip=source_ip, detail={"account_type": {"from": before, "to": account_type.value}})
    session.commit()
    return user


def delete_user(session: Session, idp: IdentityProvider, *, actor_user: User, user_id: int,
                source_ip: str | None = None) -> None:
    user = _get(session, User, user_id)
    if user.id == actor_user.id:
        raise Conflict("不能刪除自己的帳號")
    if user.account_type == AccountType.ADMIN and _admin_count(session) <= 1:
        raise Conflict("至少要保留 1 個 Admin")
    idp.delete_user(user.idp_subject)
    session.execute(delete(Membership).where(Membership.user_id == user_id))
    session.delete(user)
    record(session, actor=actor_user.username, category=AuditCategory.ACCOUNT, action="delete",
           target=f"user:{user_id}", source_ip=source_ip, detail={"username": user.username})
    session.commit()


def reset_password(session: Session, idp: IdentityProvider, *, actor: str, user_id: int, new_password: str,
                   source_ip: str | None = None) -> None:
    user = _get(session, User, user_id)
    idp.reset_password(user.idp_subject, new_password)
    record(session, actor=actor, category=AuditCategory.ACCOUNT, action="reset_password",
           target=f"user:{user_id}", source_ip=source_ip)
    session.commit()
