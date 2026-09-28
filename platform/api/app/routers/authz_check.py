from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy.orm import Session

from app.authz import effective_permissions, match_rule
from app.deps import current_user, get_session
from app.models import User

router = APIRouter()


@router.get("/authz/check")
def check(request: Request, user: User = Depends(current_user), session: Session = Depends(get_session)) -> Response:
    rule = match_rule(request.headers.get("x-forwarded-uri", ""))
    if rule is None:
        raise HTTPException(403, "此路徑未開放")
    project_id, permission = rule
    if permission not in effective_permissions(session, user, project_id):
        raise HTTPException(403, f"你沒有 {permission.value} 權限")
    return Response(status_code=200, headers={"X-User": user.username})
