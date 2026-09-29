"""/api/projects/{project_id}/labels/*：標註、評分、CSV 自動分類、自動標註。"""
from contextlib import contextmanager
from typing import Any, Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, Response, UploadFile
from pydantic import BaseModel, Field, StrictInt

from app.deps import ProjectContext, client_ip, require_project_permission
from app.labeling import service
from app.labeling.csv_labels import CsvError
from app.labeling.payloads import InvalidPayload
from app.permissions import Permission

router = APIRouter(prefix="/api/projects/{project_id}/labels", tags=["labeling"])

can_read = require_project_permission(Permission.PROJECT)
can_label = require_project_permission(Permission.LABELING)

Kind = Literal["classification", "segmentation", "detection"]
Source = Literal["manual", "csv", "autolabel"]
_UID = r"^[0-9]+(\.[0-9]+)*$"


@contextmanager
def _errors():
    try:
        yield
    except (InvalidPayload, CsvError) as exc:
        raise HTTPException(422, str(exc))


class AnnotationIn(BaseModel):
    study_instance_uid: str = Field(pattern=_UID, max_length=64)
    series_instance_uid: str | None = Field(default=None, pattern=_UID, max_length=64)
    sop_instance_uid: str | None = Field(default=None, pattern=_UID, max_length=64)
    kind: Kind
    payload: dict[str, Any]


class PayloadIn(BaseModel):
    payload: dict[str, Any]


@router.get("/annotations")
def list_annotations(study_uid: str | None = None, sop_uid: str | None = None, kind: Kind | None = None,
                     source: Source | None = None, ctx: ProjectContext = Depends(can_read)) -> list[dict]:
    rows = service.list_annotations(ctx.session, ctx.project.id, study_uid=study_uid, sop_uid=sop_uid,
                                    kind=kind, source=source)
    return [service.annotation_out(a) for a in rows]


@router.post("/annotations", status_code=201)
def create_annotation(body: AnnotationIn, request: Request, ctx: ProjectContext = Depends(can_label)) -> dict:
    with _errors():
        a = service.create_annotation(
            ctx.session, project_id=ctx.project.id, actor=ctx.user.username, source_ip=client_ip(request),
            study_uid=body.study_instance_uid, series_uid=body.series_instance_uid, sop_uid=body.sop_instance_uid,
            kind=body.kind, payload=body.payload)
    return service.annotation_out(a)


@router.get("/annotations/{annotation_id}")
def get_annotation(annotation_id: int, ctx: ProjectContext = Depends(can_read)) -> dict:
    return service.annotation_out(service.get_annotation(ctx.session, ctx.project.id, annotation_id))


@router.put("/annotations/{annotation_id}")
def update_annotation(annotation_id: int, body: PayloadIn, request: Request,
                      ctx: ProjectContext = Depends(can_label)) -> dict:
    with _errors():
        a = service.update_annotation(ctx.session, project_id=ctx.project.id, annotation_id=annotation_id,
                                      actor=ctx.user.username, source_ip=client_ip(request), payload=body.payload)
    return service.annotation_out(a)


@router.delete("/annotations/{annotation_id}", status_code=204)
def delete_annotation(annotation_id: int, request: Request, ctx: ProjectContext = Depends(can_label)) -> Response:
    service.delete_annotation(ctx.session, project_id=ctx.project.id, annotation_id=annotation_id,
                              actor=ctx.user.username, source_ip=client_ip(request))
    return Response(status_code=204)


class RatingIn(BaseModel):
    rating: StrictInt | None = Field(ge=1, le=5)


@router.put("/annotations/{annotation_id}/rating")
def rate_annotation(annotation_id: int, body: RatingIn, request: Request,
                    ctx: ProjectContext = Depends(can_label)) -> dict:
    a = service.rate_annotation(ctx.session, project_id=ctx.project.id, annotation_id=annotation_id,
                                actor=ctx.user.username, source_ip=client_ip(request), rating=body.rating)
    return service.annotation_out(a)


@router.get("/summary")
def summary(ctx: ProjectContext = Depends(can_read)) -> dict:
    return service.summary(ctx.session, ctx.project.id)


@router.post("/classification-csv", status_code=201)
def classification_csv(request: Request, file: UploadFile = File(...), key: str = Form(...),
                       key_column: str | None = Form(None), label_column: str | None = Form(None),
                       ctx: ProjectContext = Depends(can_label)) -> dict:
    """以 CSV 診斷結果，依病歷號（patient_id）或影像編號（accession_number）自動做研究層級的分類標註。"""
    with _errors():
        return service.classify_from_csv(
            ctx.session, project_id=ctx.project.id, actor=ctx.user.username, source_ip=client_ip(request),
            filename=file.filename or "", data=file.file.read(), key=key,
            key_column=key_column or None, label_column=label_column or None)
