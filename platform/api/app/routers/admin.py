from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import admin_service, project_cleanup
from app.deps import client_ip, get_session, require_admin
from app.models import Project, User
from app.permissions import AccountType, Permission, Role, split_permissions

router = APIRouter(prefix="/api/admin")


class ProjectIn(BaseModel):
    name: str = Field(min_length=1)
    description: str = ""
    gpu_group: str | None = None


class ProjectPatch(BaseModel):
    # name、description 省略代表不改；明確給 null 會被拒絕（欄位不可為空）。gpu_group 可設為 null 表示解除綁定。
    name: str = Field(default=None, min_length=1)
    description: str = Field(default=None)
    gpu_group: str | None = None


def project_out(p: Project) -> dict:
    return {"id": p.id, "name": p.name, "description": p.description, "gpu_group": p.gpu_group}


@router.get("/projects")
def list_projects(admin: User = Depends(require_admin), session: Session = Depends(get_session)) -> list[dict]:
    return [project_out(p) for p in session.scalars(select(Project).order_by(Project.id))]


@router.post("/projects", status_code=201)
def create_project(body: ProjectIn, request: Request, admin: User = Depends(require_admin),
                   session: Session = Depends(get_session)) -> dict:
    p = admin_service.create_project(session, actor=admin.username, source_ip=client_ip(request), **body.model_dump())
    return project_out(p)


@router.patch("/projects/{project_id}")
def update_project(project_id: int, body: ProjectPatch, request: Request, admin: User = Depends(require_admin),
                   session: Session = Depends(get_session)) -> dict:
    p = admin_service.update_project(session, actor=admin.username, project_id=project_id,
                                     changes=body.model_dump(exclude_unset=True), source_ip=client_ip(request))
    return project_out(p)


@router.delete("/projects/{project_id}", status_code=204)
def delete_project(project_id: int, request: Request, admin: User = Depends(require_admin),
                   session: Session = Depends(get_session)) -> Response:
    state = request.app.state
    admin_service.delete_project(session, actor=admin.username, project_id=project_id, source_ip=client_ip(request),
                                 store=state.store, orthanc=getattr(state, "orthanc", None),
                                 fhir=project_cleanup.fhir_client(state), jobs=project_cleanup.job_backend(state))
    frames = getattr(state, "tabular_frames", None)
    if frames is not None:  # 專案的 DataFrame 快取一併清掉
        frames.evict_prefix(project_cleanup.project_prefix(project_id))
    return Response(status_code=204)


class UserIn(BaseModel):
    username: str = Field(min_length=1)
    password: str = Field(min_length=1)
    account_type: AccountType


class UserPatch(BaseModel):
    account_type: AccountType


class PasswordReset(BaseModel):
    new_password: str = Field(min_length=1)


def user_out(u: User) -> dict:
    return {"id": u.id, "username": u.username, "account_type": u.account_type}


@router.get("/users")
def list_users(admin: User = Depends(require_admin), session: Session = Depends(get_session)) -> list[dict]:
    return [user_out(u) for u in session.scalars(select(User).order_by(User.id))]


@router.post("/users", status_code=201)
def create_user(body: UserIn, request: Request, admin: User = Depends(require_admin),
                session: Session = Depends(get_session)) -> dict:
    u = admin_service.create_user(session, request.app.state.idp, actor=admin.username,
                                  source_ip=client_ip(request), **body.model_dump())
    return user_out(u)


@router.patch("/users/{user_id}")
def update_user(user_id: int, body: UserPatch, request: Request, admin: User = Depends(require_admin),
                session: Session = Depends(get_session)) -> dict:
    u = admin_service.update_user(session, actor=admin.username, user_id=user_id,
                                  account_type=body.account_type, source_ip=client_ip(request))
    return user_out(u)


@router.delete("/users/{user_id}", status_code=204)
def delete_user(user_id: int, request: Request, admin: User = Depends(require_admin),
                session: Session = Depends(get_session)) -> Response:
    admin_service.delete_user(session, request.app.state.idp, actor_user=admin, user_id=user_id,
                              source_ip=client_ip(request))
    return Response(status_code=204)


@router.post("/users/{user_id}/reset-password", status_code=204)
def reset_password(user_id: int, body: PasswordReset, request: Request, admin: User = Depends(require_admin),
                   session: Session = Depends(get_session)) -> Response:
    admin_service.reset_password(session, request.app.state.idp, actor=admin.username, user_id=user_id,
                                 new_password=body.new_password, source_ip=client_ip(request))
    return Response(status_code=204)


class MembershipIn(BaseModel):
    role: Role
    permissions: list[Permission] | None = None


@router.get("/projects/{project_id}/members")
def list_members(project_id: int, admin: User = Depends(require_admin),
                 session: Session = Depends(get_session)) -> list[dict]:
    out = []
    for u, m in admin_service.list_members(session, project_id=project_id):
        known, unknown = split_permissions(m.permissions)
        row = {"user_id": u.id, "username": u.username, "role": m.role, "permissions": sorted(p.value for p in known)}
        if unknown:  # 只有資料異常時才多這個欄位，提醒管理者重新指派
            row["unknown_permissions"] = unknown
        out.append(row)
    return out


@router.put("/projects/{project_id}/members/{user_id}")
def set_member(project_id: int, user_id: int, body: MembershipIn, request: Request,
               admin: User = Depends(require_admin), session: Session = Depends(get_session)) -> dict:
    m = admin_service.set_membership(
        session, actor=admin.username, project_id=project_id, user_id=user_id, role=body.role,
        permissions=set(body.permissions) if body.permissions is not None else None,
        source_ip=client_ip(request),
    )
    return {"project_id": m.project_id, "user_id": m.user_id, "role": m.role, "permissions": m.permissions}


@router.delete("/projects/{project_id}/members/{user_id}", status_code=204)
def remove_member(project_id: int, user_id: int, request: Request, admin: User = Depends(require_admin),
                  session: Session = Depends(get_session)) -> Response:
    admin_service.remove_membership(session, actor=admin.username, project_id=project_id, user_id=user_id,
                                    source_ip=client_ip(request))
    return Response(status_code=204)
