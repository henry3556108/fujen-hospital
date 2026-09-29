"""結構式資料的業務邏輯：上傳驗證、資料集存取、DataFrame 載入快取、Target／Feature 設定。"""
import io
import json
import os
from collections import OrderedDict
from threading import Lock

import pandas as pd
from fastapi import HTTPException
from sqlalchemy import delete, select
from tabular.errors import TabularError
from tabular.modeling_config import TargetFeatureConfig
from tabular.preprocess import apply_pipeline
from tabular.schema import Schema
from tabular.validate import load_clean_csv, validate_and_load

from app.audit import AuditCategory, record
from app.deps import ProjectContext
from app.storage import ObjectStore
from app.tabular_api.models import TabularDataset, TabularTargetFeature

DEFAULT_MAX_UPLOAD_MB = 50


def max_upload_bytes(state) -> int:
    """app.state.tabular_max_upload_bytes > 環境變數 TABULAR_MAX_UPLOAD_MB > 50 MB。"""
    configured = getattr(state, "tabular_max_upload_bytes", None)
    if configured:
        return int(configured)
    return int(float(os.environ.get("TABULAR_MAX_UPLOAD_MB", DEFAULT_MAX_UPLOAD_MB)) * 1024 * 1024)


def too_large(limit: int) -> HTTPException:
    return HTTPException(413, f"檔案超過上限 {limit / 1024 / 1024:g} MB，請分批上傳")


def dataset_prefix(project_id: int, dataset_id: int) -> str:
    return f"projects/{project_id}/tabular/{dataset_id}/"


def dataset_out(ds: TabularDataset) -> dict:
    return {
        "id": ds.id, "project_id": ds.project_id, "name": ds.name, "original_filename": ds.original_filename,
        "object_key": ds.object_key, "original_key": ds.original_key, "schema": ds.schema,
        "total_rows": ds.total_rows, "valid_rows": ds.valid_rows, "rejected_rows": ds.rejected_rows,
        "created_by": ds.created_by, "created_at": ds.created_at.isoformat(),
    }


def _row_counts(report: dict) -> dict:
    return {"total_rows": report["total_rows"], "valid_rows": report["valid_rows"],
            "rejected_rows": report["rejected_row_count"]}


def create_dataset(ctx: ProjectContext, store: ObjectStore, *, raw: bytes, schema_text: str, name: str,
                   filename: str, source_ip: str | None) -> tuple[TabularDataset, dict]:
    schema = Schema.from_json(schema_text)
    report, frame = validate_and_load(io.BytesIO(raw), schema)
    session, project_id = ctx.session, ctx.project.id

    failure = None
    if report["errors"]:
        first = report["errors"][0]
        failure = TabularError(first["message"], code=first["code"], detail={"report": report})
    elif report["valid_rows"] == 0:
        failure = TabularError("沒有任何一列通過驗證，未建立資料集", code="no_valid_rows", detail={"report": report})
    if failure is not None:
        record(session, actor=ctx.user.username, category=AuditCategory.DATASET, action="tabular_upload",
               target=f"project:{project_id}", result="rejected", source_ip=source_ip,
               detail={"project_id": project_id, "name": name, "code": failure.code, **_row_counts(report)})
        session.commit()
        raise failure

    ds = TabularDataset(project_id=project_id, name=name, original_filename=filename, object_key="",
                        original_key="", schema=schema.to_dict(), created_by=ctx.user.username,
                        **_row_counts(report))
    session.add(ds)
    session.flush()  # 取得 id；同名在此觸發 IntegrityError（409），尚未寫任何物件
    prefix = dataset_prefix(project_id, ds.id)
    ds.object_key, ds.original_key = prefix + "clean.csv", prefix + "original.csv"
    try:
        store.put(ds.original_key, raw)
        store.put(ds.object_key, frame.to_csv(index=False, lineterminator="\n").encode("utf-8"))
        store.put(prefix + "report.json", json.dumps(report, ensure_ascii=False).encode("utf-8"))
        record(session, actor=ctx.user.username, category=AuditCategory.DATASET, action="tabular_upload",
               target=f"tabular_dataset:{ds.id}", source_ip=source_ip,
               detail={"project_id": project_id, "name": name, **_row_counts(report)})
        session.commit()
    except Exception:
        session.rollback()
        _delete_objects(store, prefix)
        raise
    return ds, report


def _delete_objects(store: ObjectStore, prefix: str) -> None:
    for key in store.list(prefix):
        store.delete(key)


def list_datasets(ctx: ProjectContext) -> list[TabularDataset]:
    return list(ctx.session.scalars(
        select(TabularDataset).where(TabularDataset.project_id == ctx.project.id).order_by(TabularDataset.id)))


def get_dataset(ctx: ProjectContext, dataset_id: int) -> TabularDataset:
    ds = ctx.session.get(TabularDataset, dataset_id)
    if ds is None or ds.project_id != ctx.project.id:
        raise HTTPException(404, f"找不到資料集 {dataset_id}")
    return ds


def get_report(store: ObjectStore, ds: TabularDataset) -> dict:
    return json.loads(store.get(dataset_prefix(ds.project_id, ds.id) + "report.json"))


def delete_dataset(ctx: ProjectContext, store: ObjectStore, frames: "FrameCache", ds: TabularDataset,
                   source_ip: str | None) -> None:
    session = ctx.session
    session.execute(delete(TabularTargetFeature).where(TabularTargetFeature.dataset_id == ds.id))
    session.delete(ds)
    record(session, actor=ctx.user.username, category=AuditCategory.DATASET, action="tabular_delete",
           target=f"tabular_dataset:{ds.id}", source_ip=source_ip,
           detail={"project_id": ds.project_id, "name": ds.name, "total_rows": ds.total_rows,
                   "valid_rows": ds.valid_rows, "rejected_rows": ds.rejected_rows})
    session.commit()
    frames.evict(ds.object_key)
    _delete_objects(store, dataset_prefix(ds.project_id, ds.id))


def save_target_feature(ctx: ProjectContext, frames: "FrameCache", ds: TabularDataset, data: dict,
                        source_ip: str | None) -> TabularTargetFeature:
    """正規化設定、套用前處理步驟後確認 target／features 都存在，再覆寫這個資料集的設定。"""
    config = TargetFeatureConfig.from_dict(data)
    config.validate_against(apply_pipeline(frames.load(ds), config.steps).columns)
    session = ctx.session
    row = session.scalar(select(TabularTargetFeature).where(TabularTargetFeature.dataset_id == ds.id))
    if row is None:
        row = TabularTargetFeature(dataset_id=ds.id, config={}, updated_by="")
        session.add(row)
    row.config, row.updated_by = config.to_dict(), ctx.user.username
    record(session, actor=ctx.user.username, category=AuditCategory.TRAINING, action="target_feature_save",
           target=f"tabular_dataset:{ds.id}", source_ip=source_ip,
           detail={"project_id": ds.project_id, "target": config.target, "features": config.features,
                   "steps": [s["id"] for s in config.steps], "total_rows": ds.total_rows,
                   "valid_rows": ds.valid_rows, "rejected_rows": ds.rejected_rows})
    session.commit()
    return row


def get_target_feature(ctx: ProjectContext, ds: TabularDataset) -> TabularTargetFeature:
    row = ctx.session.scalar(select(TabularTargetFeature).where(TabularTargetFeature.dataset_id == ds.id))
    if row is None:
        raise HTTPException(404, f"資料集 {ds.id} 尚未設定 Target 與 Feature")
    return row


def target_feature_out(row: TabularTargetFeature) -> dict:
    return {"dataset_id": row.dataset_id, "config": row.config, "updated_by": row.updated_by,
            "updated_at": row.updated_at.isoformat()}


class FrameCache:
    """以資料集結構定義重新載入乾淨檔（型別與上傳時一致）。資料集不可修改，所以以 object_key 為鍵快取。"""

    def __init__(self, store: ObjectStore, size: int = 8):
        self.store, self.size = store, size
        self._items: OrderedDict[str, pd.DataFrame] = OrderedDict()
        self._lock = Lock()

    def load(self, ds: TabularDataset) -> pd.DataFrame:
        with self._lock:
            if ds.object_key in self._items:
                self._items.move_to_end(ds.object_key)
                return self._items[ds.object_key]
        frame = load_clean_csv(io.BytesIO(self.store.get(ds.object_key)), Schema.from_dict(ds.schema))
        with self._lock:
            self._items[ds.object_key] = frame
            while len(self._items) > self.size:
                self._items.popitem(last=False)
        return frame

    def evict(self, key: str) -> None:
        with self._lock:
            self._items.pop(key, None)

    def evict_prefix(self, prefix: str) -> None:
        with self._lock:
            for key in [k for k in self._items if k.startswith(prefix)]:
                del self._items[key]


def frame_cache(state) -> FrameCache:
    """每個 app 一份快取；換了 store（測試）就重建。"""
    cache = getattr(state, "tabular_frames", None)
    if cache is None or cache.store is not state.store:
        cache = state.tabular_frames = FrameCache(state.store)
    return cache
