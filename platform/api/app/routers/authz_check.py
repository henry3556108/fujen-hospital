from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy.orm import Session

from app.authz import effective_permissions, match_dicomweb, match_rule
from app.deps import current_user, get_session
from app.fhir.gateway import check_fhir
from app.imaging.service import dicomweb_allowed
from app.models import User
from app.permissions import Permission

router = APIRouter()

_READ_METHODS = {"GET", "HEAD"}


@router.get("/authz/check")
def check(request: Request, user: User = Depends(current_user), session: Session = Depends(get_session)) -> Response:
    uri = request.headers.get("x-forwarded-uri", "")
    if uri.startswith("/dicomweb/"):
        return _check_dicomweb(request, uri, user, session)
    if uri.startswith("/fhir/"):
        return check_fhir(request, uri, user, session)
    rule = match_rule(uri)
    if rule is None:
        raise HTTPException(403, "此路徑未開放")
    project_id, permission = rule
    if permission not in effective_permissions(session, user, project_id):
        raise HTTPException(403, f"你沒有 {permission.value} 權限")
    return Response(status_code=200, headers={"X-User": user.username})


def _check_dicomweb(request: Request, uri: str, user: User, session: Session) -> Response:
    """DICOMweb 唯讀；研究必須在專案索引內，且（若有清單）Accession 在清單內；series／instance 必須屬於該研究。"""
    if request.headers.get("x-forwarded-method", "").upper() not in _READ_METHODS:
        raise HTTPException(403, "DICOMweb 僅允許讀取")
    target = match_dicomweb(uri)
    if target is None:
        raise HTTPException(403, "此路徑未開放")
    if Permission.PROJECT not in effective_permissions(session, user, target.project_id):
        raise HTTPException(403, f"你沒有 {Permission.PROJECT.value} 權限")
    if not dicomweb_allowed(session, target):
        raise HTTPException(403, "研究不在本專案，或不在 Accession 清單內")
    return Response(status_code=200, headers={"X-User": user.username})
