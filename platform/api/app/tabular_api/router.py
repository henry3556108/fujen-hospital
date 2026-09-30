from collections.abc import Callable

import pandas as pd
from fastapi import APIRouter, Body, Depends, File, Form, Query, Request, Response, UploadFile
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from pydantic import BaseModel
from tabular import explore, preprocess, stats
from tabular.errors import TabularError

from app import scanning
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
    scanning.ensure_clean(request, filename, raw)
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


# ------------------------------------------------------------------ 欄位顯示設定（TC-B04-02）

class ColumnViewIn(BaseModel):
    hidden: list[str]


@router.get("/datasets/{dataset_id}/column-view")
def get_column_view(ds: TabularDataset = Depends(_dataset), ctx: ProjectContext = Depends(read_access)) -> dict:
    """目前使用者在這個資料集隱藏的欄位；saved=false 表示還沒存過。"""
    return service.get_column_view(ctx, ds)


@router.put("/datasets/{dataset_id}/column-view")
def put_column_view(body: ColumnViewIn, ds: TabularDataset = Depends(_dataset),
                    ctx: ProjectContext = Depends(read_access),
                    frames: service.FrameCache = Depends(_frames)) -> dict:
    return service.save_column_view(ctx, frames, ds, body.hidden)


# ------------------------------------------------------------------ 探索（TC-B04-01、02、05、08）

def _frame(ds: TabularDataset = Depends(_dataset), frames: service.FrameCache = Depends(_frames)) -> pd.DataFrame:
    return frames.load(ds)


@router.get("/datasets/{dataset_id}/describe")
def describe(df: pd.DataFrame = Depends(_frame)) -> dict:
    return explore.describe(df)


@router.get("/datasets/{dataset_id}/histogram")
def histogram(column: str, bins: int = 10, df: pd.DataFrame = Depends(_frame)) -> dict:
    return explore.histogram(df, column, bins)


@router.get("/datasets/{dataset_id}/value-counts")
def value_counts(column: str, limit: int = 50, df: pd.DataFrame = Depends(_frame)) -> dict:
    return explore.value_counts(df, column, limit)


@router.get("/datasets/{dataset_id}/preview")
def preview(offset: int = 0, limit: int = 50, columns: list[str] | None = Query(None),
            df: pd.DataFrame = Depends(_frame)) -> dict:
    """columns 可重複，代表目前可見（未隱藏）的欄位；省略為全部欄位。"""
    return explore.preview(df, offset, limit, columns)


@router.get("/datasets/{dataset_id}/correlation")
def correlation(columns: list[str] | None = Query(None), method: str = "pearson",
                df: pd.DataFrame = Depends(_frame)) -> dict:
    return explore.correlation(df, columns, method)


@router.get("/datasets/{dataset_id}/scatter")
def scatter(x: str, y: str, limit: int = Query(5000, ge=1, le=20000), df: pd.DataFrame = Depends(_frame)) -> dict:
    return explore.scatter(df, x, y, limit)


# ------------------------------------------------------------------ 前處理（TC-B04-04、06）

class PipelinePreviewIn(BaseModel):
    steps: list[dict] = []
    offset: int = 0
    limit: int = 50
    columns: list[str] | None = None


@router.get("/preprocessing/catalogue")
def preprocessing_catalogue(ctx: ProjectContext = Depends(read_access)) -> list[dict]:
    return preprocess.catalogue()


@router.post("/datasets/{dataset_id}/preprocess/preview")
def pipeline_preview(body: PipelinePreviewIn, df: pd.DataFrame = Depends(_frame)) -> dict:
    """在資料副本上套用步驟後預覽；不改動已儲存的資料集。"""
    out = preprocess.apply_pipeline(df, body.steps)
    return {"row_count": int(len(out)), "columns": explore.column_info(out),
            "preview": explore.preview(out, body.offset, body.limit, body.columns)}


# ------------------------------------------------------------------ Target／Feature 設定（TC-B04-03）

training_access = require_project_permission(Permission.TRAINING)


@router.put("/datasets/{dataset_id}/target-feature")
def save_target_feature(dataset_id: int, request: Request, body: dict = Body(...),
                        ctx: ProjectContext = Depends(training_access),
                        frames: service.FrameCache = Depends(_frames)) -> dict:
    """body 為 TargetFeatureConfig：{target, features, steps?}；回傳正規化後（補上預設參數）的設定。"""
    ds = service.get_dataset(ctx, dataset_id)
    row = service.save_target_feature(ctx, frames, ds, body, client_ip(request))
    return service.target_feature_out(row)


@router.get("/datasets/{dataset_id}/target-feature")
def get_target_feature(ds: TabularDataset = Depends(_dataset), ctx: ProjectContext = Depends(read_access)) -> dict:
    return service.target_feature_out(service.get_target_feature(ctx, ds))


# ------------------------------------------------------------------ 醫學統計（TC-B04-07、08）
# steps 選填：先在資料副本上套用前處理（例如以 onehot 編碼類別欄位）再建模。

class RegressionIn(BaseModel):
    target: str
    features: list[str]
    steps: list[dict] = []


class KaplanMeierIn(BaseModel):
    duration: str
    event: str
    group: str | None = None
    steps: list[dict] = []


class CoxIn(BaseModel):
    duration: str
    event: str
    covariates: list[str]
    steps: list[dict] = []


@router.post("/datasets/{dataset_id}/stats/logistic")
def stats_logistic(body: RegressionIn, df: pd.DataFrame = Depends(_frame)) -> dict:
    return stats.logistic(preprocess.apply_pipeline(df, body.steps), body.target, body.features)


@router.post("/datasets/{dataset_id}/stats/linear")
def stats_linear(body: RegressionIn, df: pd.DataFrame = Depends(_frame)) -> dict:
    return stats.linear(preprocess.apply_pipeline(df, body.steps), body.target, body.features)


@router.post("/datasets/{dataset_id}/stats/kaplan-meier")
def stats_kaplan_meier(body: KaplanMeierIn, df: pd.DataFrame = Depends(_frame)) -> dict:
    return stats.kaplan_meier(preprocess.apply_pipeline(df, body.steps), body.duration, body.event, body.group)


@router.post("/datasets/{dataset_id}/stats/cox")
def stats_cox(body: CoxIn, df: pd.DataFrame = Depends(_frame)) -> dict:
    return stats.cox(preprocess.apply_pipeline(df, body.steps), body.duration, body.event, body.covariates)
