"""結構式資料的業務邏輯：上傳驗證、資料集存取、DataFrame 載入快取、Target／Feature 設定。"""
import io
import json
import os

from fastapi import HTTPException
from tabular.errors import TabularError
from tabular.schema import Schema
from tabular.validate import validate_and_load

from app.audit import AuditCategory, record
from app.deps import ProjectContext
from app.storage import ObjectStore
from app.tabular_api.models import TabularDataset

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
