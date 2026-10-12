from collections.abc import Callable, Iterator
from dataclasses import dataclass

from fastapi import Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.identity import Identity, TokenError
from app.authz import effective_permissions
from app.models import Project, User
from app.permissions import AccountType, Permission


def get_session(request: Request) -> Iterator[Session]:
    with request.app.state.sessionmaker() as session:
        yield session


def client_ip(request: Request) -> str | None:
    # Gateway 會把它看到的來源附加在最右邊；左邊的值是用戶端自己帶的，不可信。
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[-1].strip()
    return request.client.host if request.client else None


def current_identity(request: Request) -> Identity:
    auth = request.headers.get("authorization", "")
    if not auth.lower().startswith("bearer "):
        raise HTTPException(401, "未登入")
    try:
        return request.app.state.verifier.verify(auth[7:])
    except TokenError:
        raise HTTPException(401, "登入已失效，請重新登入")


def current_user(identity: Identity = Depends(current_identity), session: Session = Depends(get_session)) -> User:
    user = session.scalar(select(User).where(User.idp_subject == identity.subject))
    if user is None:
        raise HTTPException(401, "帳號不存在或已停用")
    return user


def require_admin(user: User = Depends(current_user)) -> User:
    if user.account_type != AccountType.ADMIN:
        raise HTTPException(403, "需要 Admin 權限")
    return user


@dataclass(frozen=True)
class ProjectContext:
    user: User
    project: Project
    session: Session


def require_project_permission(permission: Permission, *others: Permission) -> Callable[..., ProjectContext]:
    """專案範圍 API 的共用檢查：路徑需含 {project_id}。給多個權限時，有其中任一個即可。
    非 Admin 查不存在的專案一律回 403（不透露專案是否存在）；Admin 回 404。"""
    wanted = (permission, *others)
    names = "或".join(p.value for p in wanted)

    def dependency(project_id: int, user: User = Depends(current_user),
                   session: Session = Depends(get_session)) -> ProjectContext:
        project = session.get(Project, project_id)
        if user.account_type == AccountType.ADMIN and project is None:
            raise HTTPException(404, f"找不到專案 {project_id}")
        if project is None or not set(wanted) & effective_permissions(session, user, project_id):
            raise HTTPException(403, {"code": "forbidden", "permission": permission.value,
                                      "message": f"你沒有 {names} 權限"})
        return ProjectContext(user=user, project=project, session=session)

    return dependency
