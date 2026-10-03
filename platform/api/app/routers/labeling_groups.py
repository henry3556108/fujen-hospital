"""標註群組 API：Admin 管理（/api/admin/projects/{pid}/labeling-groups），專案成員唯讀（/api/projects/{pid}/labeling-groups）。"""
from typing import Annotated

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, Field, StringConstraints
from sqlalchemy.orm import Session

from app import labeling_groups as service
from app.deps import ProjectContext, client_ip, get_session, require_admin, require_project_permission
from app.models import LabelGroup, User
from app.permissions import Permission

router = APIRouter(tags=["labeling-groups"])

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=128)]
Description = Annotated[str, StringConstraints(strip_whitespace=True, max_length=1024)]


class GroupIn(BaseModel):
    name: Name
    description: Description = ""
    member_ids: list[int] = Field(default_factory=list)


class GroupPatch(BaseModel):
    # 省略代表不改；名稱不可為空
    name: Name = None
    description: Description = None
    member_ids: list[int] = None


def group_out(group: LabelGroup, members: list[User]) -> dict:
    return {"id": group.id, "project_id": group.project_id, "name": group.name, "description": group.description,
            "created_by": group.created_by, "created_at": group.created_at,
            "members": [{"user_id": u.id, "username": u.username} for u in members]}


def _one(session: Session, group: LabelGroup) -> dict:
    return group_out(group, service.members_of(session, [group.id])[group.id])


@router.get("/api/admin/projects/{project_id}/labeling-groups")
def list_groups(project_id: int, admin: User = Depends(require_admin),
                session: Session = Depends(get_session)) -> list[dict]:
    return [group_out(g, members) for g, members in service.list_groups(session, project_id)]


@router.post("/api/admin/projects/{project_id}/labeling-groups", status_code=201)
def create_group(project_id: int, body: GroupIn, request: Request, admin: User = Depends(require_admin),
                 session: Session = Depends(get_session)) -> dict:
    group = service.create_group(session, actor=admin.username, project_id=project_id, name=body.name,
                                 description=body.description, member_ids=body.member_ids,
                                 source_ip=client_ip(request))
    return _one(session, group)


@router.patch("/api/admin/projects/{project_id}/labeling-groups/{group_id}")
def update_group(project_id: int, group_id: int, body: GroupPatch, request: Request,
                 admin: User = Depends(require_admin), session: Session = Depends(get_session)) -> dict:
    changes = body.model_dump(exclude_unset=True)
    for key in ("name", "description", "member_ids"):
        if key in changes and changes[key] is None:
            changes.pop(key)  # 明確給 null 視同不改
    group = service.update_group(session, actor=admin.username, project_id=project_id, group_id=group_id,
                                 source_ip=client_ip(request), **changes)
    return _one(session, group)


@router.delete("/api/admin/projects/{project_id}/labeling-groups/{group_id}", status_code=204)
def delete_group(project_id: int, group_id: int, request: Request, admin: User = Depends(require_admin),
                 session: Session = Depends(get_session)) -> Response:
    service.delete_group(session, actor=admin.username, project_id=project_id, group_id=group_id,
                         source_ip=client_ip(request))
    return Response(status_code=204)


@router.get("/api/projects/{project_id}/labeling-groups")
def project_groups(ctx: ProjectContext = Depends(require_project_permission(Permission.LABELING))) -> list[dict]:
    """B-02 分派標註工作用：專案內的群組與成員（唯讀）。"""
    return [group_out(g, members) for g, members in service.list_groups(ctx.session, ctx.project.id)]
