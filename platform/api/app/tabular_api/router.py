from collections.abc import Callable

from fastapi import APIRouter, Depends, File, Form, Request, UploadFile
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from tabular.errors import TabularError

from app.deps import ProjectContext, client_ip, require_project_permission
from app.permissions import Permission
from app.tabular_api import service


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
