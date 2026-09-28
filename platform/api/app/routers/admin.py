from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import admin_service
from app.deps import client_ip, get_session, require_admin
from app.models import Project, User
from app.permissions import AccountType

router = APIRouter(prefix="/api/admin")


class ProjectIn(BaseModel):
    name: str
    description: str = ""
    gpu_group: str | None = None


class ProjectPatch(BaseModel):
    name: str | None = None
    description: str | None = None
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
    admin_service.delete_project(session, actor=admin.username, project_id=project_id, source_ip=client_ip(request))
    return Response(status_code=204)


class UserIn(BaseModel):
    username: str
    password: str
    account_type: AccountType


class UserPatch(BaseModel):
    account_type: AccountType


class PasswordReset(BaseModel):
    new_password: str


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
