"""/api/projects/{project_id}/labels/*：標註、評分、CSV 自動分類、自動標註。"""
import os
from contextlib import contextmanager
from typing import Any, Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, Response, UploadFile
from pydantic import BaseModel, Field, StrictInt

from app import scanning
from app.deps import ProjectContext, client_ip, require_project_permission
from app.labeling import datasets as label_datasets
from app.labeling import service
from app.labeling.autolabel import AutolabelClient, autolabel_from_env
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
    except service.AutolabelFailed as exc:
        raise HTTPException(exc.status, exc.message)


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
                       dataset_id: int | None = Form(None), dataset_name: str | None = Form(None),
                       ctx: ProjectContext = Depends(can_label)) -> dict:
    """以 CSV 診斷結果，依病歷號（patient_id）或影像編號（accession_number）自動做研究層級的分類標註。
    dataset_id：加入既有的分類標註資料集；dataset_name：建立新資料集；都不給：回預設分類資料集。"""
    data = file.file.read()
    scanning.ensure_clean(request, file.filename or "diagnosis.csv", data)
    with _errors():
        return service.classify_from_csv(
            ctx.session, project_id=ctx.project.id, actor=ctx.user.username, source_ip=client_ip(request),
            filename=file.filename or "", data=data, key=key,
            key_column=key_column or None, label_column=label_column or None,
            dataset_id=dataset_id, dataset_name=dataset_name or None)


@router.post("/annotations/{annotation_id}/confirm")
def confirm_annotation(annotation_id: int, request: Request, ctx: ProjectContext = Depends(can_label)) -> dict:
    a = service.confirm_annotation(ctx.session, project_id=ctx.project.id, annotation_id=annotation_id,
                                   actor=ctx.user.username, source_ip=client_ip(request))
    return service.annotation_out(a)


# ---------- 標註資料集 ----------

Task = Literal["classification", "detection", "segmentation"]
can_version = require_project_permission(Permission.LABELING, Permission.TRAINING)


class DatasetIn(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    task: Task
    scope_id: int | None = None
    classes: list[str] | None = None


@router.get("/datasets")
def list_datasets(ctx: ProjectContext = Depends(can_read)) -> list[dict]:
    label_datasets.ensure_defaults(ctx.session, ctx.project.id, ctx.user.username)
    return [label_datasets.dataset_out(ctx.session, ds)
            for ds in label_datasets.list_datasets(ctx.session, ctx.project.id)]


@router.post("/datasets", status_code=201)
def create_dataset(body: DatasetIn, request: Request, ctx: ProjectContext = Depends(can_label)) -> dict:
    with _errors():
        ds = label_datasets.create_dataset(ctx.session, project_id=ctx.project.id, actor=ctx.user.username,
                                           source_ip=client_ip(request), name=body.name, task=body.task,
                                           scope_id=body.scope_id, classes=body.classes)
    return label_datasets.dataset_out(ctx.session, ds)


@router.get("/datasets/{dataset_id}")
def get_dataset(dataset_id: int, ctx: ProjectContext = Depends(can_read)) -> dict:
    return label_datasets.dataset_out(ctx.session, label_datasets.get_dataset(ctx.session, ctx.project.id, dataset_id))


@router.put("/datasets/{dataset_id}")
def update_dataset(dataset_id: int, body: dict[str, Any], request: Request,
                   ctx: ProjectContext = Depends(can_label)) -> dict:
    """可改 name、scope_id、classes（只改有給的欄位；scope_id 給 null＝不限範圍）。任務不可改。"""
    current = label_datasets.get_dataset(ctx.session, ctx.project.id, dataset_id)
    if "task" in body and body["task"] != current.task:
        raise HTTPException(422, "標註資料集的任務不可修改")
    fields = {k: body[k] for k in ("name", "scope_id", "classes") if k in body}
    with _errors():
        ds = label_datasets.update_dataset(ctx.session, project_id=ctx.project.id, dataset_id=dataset_id,
                                           actor=ctx.user.username, source_ip=client_ip(request), **fields)
    return label_datasets.dataset_out(ctx.session, ds)


@router.delete("/datasets/{dataset_id}", status_code=204)
def delete_dataset(dataset_id: int, request: Request, ctx: ProjectContext = Depends(can_label)) -> Response:
    label_datasets.delete_dataset(ctx.session, project_id=ctx.project.id, dataset_id=dataset_id,
                                  actor=ctx.user.username, source_ip=client_ip(request))
    return Response(status_code=204)


@router.get("/datasets/{dataset_id}/items")
def dataset_items(dataset_id: int, offset: int = Query(0, ge=0), limit: int = Query(50, ge=1, le=500),
                  ctx: ProjectContext = Depends(can_read)) -> dict:
    ds = label_datasets.get_dataset(ctx.session, ctx.project.id, dataset_id)
    return label_datasets.items(ctx.session, ds, offset=offset, limit=limit)


@router.get("/datasets/{dataset_id}/versions")
def dataset_versions(dataset_id: int, ctx: ProjectContext = Depends(can_read)) -> list[dict]:
    ds = label_datasets.get_dataset(ctx.session, ctx.project.id, dataset_id)
    return [label_datasets.version_out(v) for v in label_datasets.list_versions(ctx.session, ds)]


@router.post("/datasets/{dataset_id}/versions")
def create_version(dataset_id: int, request: Request, response: Response,
                   ctx: ProjectContext = Depends(can_version)) -> dict:
    """內容與最新版相同就回最新版（created: false），不同就建新版（created: true，201）。"""
    ds = label_datasets.get_dataset(ctx.session, ctx.project.id, dataset_id)
    with _errors():
        version, created = label_datasets.ensure_version(ctx.session, ds, actor=ctx.user.username,
                                                         source_ip=client_ip(request))
    response.status_code = 201 if created else 200
    return label_datasets.version_out(version) | {"created": created}


# ---------- 自動標註 ----------

def get_autolabel(request: Request) -> AutolabelClient:
    client = getattr(request.app.state, "autolabel", None)
    if client is None:
        client = autolabel_from_env(os.environ)
        if client is None:
            raise HTTPException(503, "自動標註服務尚未設定（AUTOLABEL_URL）")
        request.app.state.autolabel = client
    return client


class AutolabelIn(BaseModel):
    model: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_.-]+$")
    study_instance_uid: str = Field(pattern=_UID, max_length=64)
    sop_instance_uid: str = Field(pattern=_UID, max_length=64)


@router.get("/autolabel/models")
def autolabel_models(ctx: ProjectContext = Depends(can_read),
                     client: AutolabelClient = Depends(get_autolabel)) -> list[dict]:
    with _errors():
        return service.autolabel_models(client)


@router.post("/autolabel", status_code=201)
def submit_autolabel(body: AutolabelIn, request: Request, ctx: ProjectContext = Depends(can_label),
                     client: AutolabelClient = Depends(get_autolabel)) -> dict:
    with _errors():
        run, annotation = service.submit_autolabel(
            ctx.session, client, project_id=ctx.project.id, actor=ctx.user.username, source_ip=client_ip(request),
            model=body.model, study_uid=body.study_instance_uid, sop_uid=body.sop_instance_uid)
    return {"run": service.run_out(run), "annotation": service.annotation_out(annotation)}


@router.get("/autolabel/runs")
def autolabel_runs(ctx: ProjectContext = Depends(can_read)) -> list[dict]:
    return [service.run_out(r) for r in service.list_runs(ctx.session, ctx.project.id)]
