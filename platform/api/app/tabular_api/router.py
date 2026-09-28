from collections.abc import Callable

from fastapi import APIRouter, Depends, File, Form, Request, Response, UploadFile
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from tabular import explore
from tabular.errors import TabularError

from app.deps import ProjectContext, client_ip, require_project_permission
from app.permissions import Permission
from app.tabular_api import service
from app.tabular_api.models import TabularDataset


class TabularRoute(APIRoute):
    """函式庫的 TabularError（可預期的輸入錯誤）一律轉成 422，body 為 {"detail": err.to_dict()}。"""

    def get_route_handler(self) -> Callable:
        handler = super().get_route_handler()

        async def route_handler(request: Request):
            try:
                return await handler(request)
            except TabularError as exc:
                return JSONResponse(status_code=422, content={"detail": exc.to_dict()})

        return route_handler


router = APIRouter(prefix="/api/projects/{project_id}/tabular", route_class=TabularRoute)

read_access = require_project_permission(Permission.PROJECT)


def _dataset(dataset_id: int, ctx: ProjectContext = Depends(read_access)) -> TabularDataset:
    return service.get_dataset(ctx, dataset_id)


def _frames(request: Request) -> service.FrameCache:
    return service.frame_cache(request.app.state)


@router.post("/datasets", status_code=201)
def upload_dataset(request: Request, file: UploadFile = File(...), schema_text: str = Form(..., alias="schema"),
                   name: str | None = Form(None), ctx: ProjectContext = Depends(read_access)) -> dict:
    limit = service.max_upload_bytes(request.app.state)
    raw = file.file.read(limit + 1)
    if len(raw) > limit:
        raise service.too_large(limit)
    filename = file.filename or "data.csv"
    ds, report = service.create_dataset(ctx, request.app.state.store, raw=raw, schema_text=schema_text,
                                        name=(name or "").strip() or filename, filename=filename,
                                        source_ip=client_ip(request))
    return {"dataset": service.dataset_out(ds), "report": report}


@router.get("/datasets")
def list_datasets(ctx: ProjectContext = Depends(read_access)) -> list[dict]:
    return [service.dataset_out(ds) for ds in service.list_datasets(ctx)]


@router.get("/datasets/{dataset_id}")
def get_dataset(ds: TabularDataset = Depends(_dataset), frames: service.FrameCache = Depends(_frames)) -> dict:
    return {**service.dataset_out(ds), "columns": explore.column_info(frames.load(ds))}


@router.get("/datasets/{dataset_id}/report")
def get_report(request: Request, ds: TabularDataset = Depends(_dataset)) -> dict:
    return service.get_report(request.app.state.store, ds)


@router.delete("/datasets/{dataset_id}", status_code=204)
def delete_dataset(request: Request, ds: TabularDataset = Depends(_dataset),
                   ctx: ProjectContext = Depends(read_access),
                   frames: service.FrameCache = Depends(_frames)) -> Response:
    service.delete_dataset(ctx, request.app.state.store, frames, ds, client_ip(request))
    return Response(status_code=204)
