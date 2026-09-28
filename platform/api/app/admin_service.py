from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.audit import AuditCategory, record
from app.models import Membership, Project


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
