"""批次推論：送出後在背景的 Kubernetes Job（platform-trainer 映像的 trainer.batch）執行。

- 送出：決定要推論的列或影像 → 建推論紀錄（queued）與批次列 → 送排程工作 → 同一個交易寫 `inference.batch` 稽核。
  影像模型排進專案綁定的 GPU 群組（工作種類 inference），結構式模型排進 cpu-data（inference-cpu），不占 GPU。
- Job 容器只拿到這一筆推論的 I/O 位址與一次性 token：下載輸入包、回報原始預測。token 在定案時失效。
- 定案：容器回報時立即定案（組結果、存物件儲存、改狀態、寫 `inference.batch.finish`，同一個交易）；
  排程工作列（jobs）同時記為結束，不必等有人列出工作。沒有回報就結束的工作在查詢時依排程狀態記為失敗。
"""
from __future__ import annotations

import hashlib
import hmac
import io
import json
import os
import secrets
import tarfile
from typing import Any

from sqlalchemy.orm import Session

from app.audit import AuditCategory, record
from app.deps import ProjectContext
from app.models import Project, utcnow
from app.scheduling import service as scheduling
from app.scheduling.backend import JobBackend, Workload
from app.scheduling.models import Job
from app.scheduling.states import TERMINAL, JobStatus
from app.storage import ObjectNotFound, ObjectStore
from app.training import config as cfg, snapshot
from app.training.inference import InferenceError
from app.training.models import DatasetVersion, InferenceBatch, InferenceRecord, TrainedModel, TrainingRun
from app.training.service import (SUBSETS, Conflict, Invalid, NotFound, TrainingError, Unauthorized, Unavailable,
                                  _artifact, _read_csv, _splits, _store_result, _tabular_result, _write_csv,
                                  job_image, positive_label)

DONE = {s.value for s in TERMINAL}
MEMORY_MB = {"image": 2048, "tabular": 1024}
MAX_ANSWER_BYTES = int(os.environ.get("INFERENCE_MAX_ANSWER_MB", "256")) * 1024 * 1024


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _image(model: TrainedModel) -> bool:
    return model.kind in cfg.IMAGE_KINDS


def _version(session: Session, model: TrainedModel) -> DatasetVersion:
    run = session.get(TrainingRun, model.run_id)
    return session.get(DatasetVersion, run.dataset_version_id)


def _blob(store: ObjectStore, model: TrainedModel, ref: dict) -> bytes:
    return store.get(snapshot.blob_key(model.project_id, ref["blob"]))


def _tabular_input(store: ObjectStore, model: TrainedModel, manifest: dict,
                   picked: list[int], *, with_target: bool = False) -> tuple[list[str], list[list[str]]]:
    """凍結資料中選定的列。送進模型的輸入去掉目標欄（推論不送答案，避免洩漏）；
    with_target=True 時保留（結果把實際值放回原本的位置，讓使用者對照預測對不對）。"""
    header, rows = _read_csv(_blob(store, model, manifest["items"][0]["files"]["csv"]))
    keep = [i for i, name in enumerate(header) if with_target or name != model.card.get("target")]
    return [header[i] for i in keep], [[rows[r][i] for i in keep] for r in picked]


def _plan(session: Session, store: ObjectStore, model: TrainedModel, subset: Any) -> dict[str, Any]:
    """只讀 manifest 與切分紀錄，決定要推論的列或影像；內容等 Job 來下載時才讀。"""
    if subset not in SUBSETS:
        raise Invalid(f"subset 必須是：{'、'.join(SUBSETS)}")
    version = _version(session, model)
    manifest = snapshot.load_manifest(store, version)
    splits = _splits(store, session, model) if subset != "all" else {}
    base = {"subset": subset, "dataset_version_id": version.id, "dataset_hash": version.content_hash}
    if not _image(model):
        _, rows = _read_csv(_blob(store, model, manifest["items"][0]["files"]["csv"]))
        picked = list(range(len(rows))) if subset == "all" else [i for i in splits[subset] if i < len(rows)]
        if not picked:
            raise Conflict(f"「{subset}」切分沒有資料")
        return base | {"rows": picked}
    wanted = None if subset == "all" else {str(s).split("#")[0] for s in splits[subset]}
    items = [i["id"] for i in manifest["items"] if wanted is None or i["id"] in wanted]
    if not items:
        raise Conflict(f"「{subset}」切分沒有資料")
    return base | {"items": items}


def _workload(state, row: InferenceRecord, model: TrainedModel, token: str) -> Workload:
    image = job_image(state, gpu=_image(model))
    base = (getattr(state, "job_io_url", None) or os.environ.get("JOB_IO_BASE_URL", "http://api:8000")).rstrip("/")
    # 容器只拿到這三個值加上執行緒數；token 只對這一筆推論有效，不是平台憑證
    env = {"INFERENCE_ID": str(row.id), "JOB_IO_URL": f"{base}/api/job-io/inference/{row.id}",
           "JOB_IO_TOKEN": token, "TRAIN_THREADS": "1"}
    return Workload(image=image, command=("python", "-m", "trainer.batch"), env=env,
                    memory_mb=MEMORY_MB["image" if _image(model) else "tabular"], cpu_request="250m",
                    expected_seconds=30)


def submit(ctx: ProjectContext, state, backend: JobBackend, *, model: TrainedModel, subset: Any,
           source_ip: str | None) -> InferenceRecord:
    session = ctx.session
    input_ = _plan(session, state.store, model, subset)
    scheduling.ensure_defaults(session)
    count = len(input_.get("rows") or input_.get("items") or [])
    row = InferenceRecord(project_id=model.project_id, model_id=model.id, mode="batch", status="queued",
                          user=ctx.user.username, count=count, input=input_)
    session.add(row)
    session.flush()
    token = secrets.token_urlsafe(32)
    job_batch = InferenceBatch(record_id=row.id, project_id=row.project_id, io_token_hash=_token_hash(token))
    session.add(job_batch)
    record(session, actor=ctx.user.username, category=AuditCategory.INFERENCE, action="inference.batch",
           target=f"inference:{row.id}", source_ip=source_ip,
           detail={"project_id": row.project_id, "model_id": model.id, "mode": "batch", "subset": input_["subset"],
                   "count": count, "dataset_hash": input_["dataset_hash"]})

    def link(job: Job) -> None:
        job_batch.job_id = job.id

    try:
        scheduling.submit_job(session, backend, project=ctx.project, actor=ctx.user.username,
                              kind="inference" if _image(model) else "inference-cpu", source_ip=source_ip,
                              workload=_workload(state, row, model, token), on_created=link)
    except scheduling.SchedulingError as exc:
        session.rollback()
        raise (Unavailable if exc.status_code == 503 else Conflict)(str(exc)) from exc
    session.expire(row, ["batch"])
    return row


# ---------------------------------------------------------------- 狀態

def _finish(session: Session, row: InferenceRecord, job_batch: InferenceBatch, *, status: str, message: str = "",
            actor: str | None = None, finished_at=None) -> None:
    """定案：狀態、結束時間、token 失效、稽核。不 commit，由呼叫端與其他變更一起 commit。"""
    row.status, row.message = status, message[:1024]
    job_batch.io_closed = True
    job_batch.finished_at = finished_at or utcnow()
    if status == JobStatus.CANCELLED.value:
        return
    record(session, actor=actor or row.user, category=AuditCategory.INFERENCE, action="inference.batch.finish",
           target=f"inference:{row.id}", result="success" if status == "succeeded" else "failure",
           detail={"project_id": row.project_id, "model_id": row.model_id, "mode": "batch", "status": status,
                   "count": row.count, **({"message": message[:500]} if message else {})})


def sync(session: Session, backend: JobBackend | None, row: InferenceRecord) -> None:
    """以排程工作的實際狀態更新推論紀錄。不 commit。"""
    job_batch = row.batch
    if row.mode != "batch" or row.status in DONE or job_batch is None or backend is None:
        return
    job = session.get(Job, job_batch.job_id) if job_batch.job_id else None
    if job is None:
        _finish(session, row, job_batch, status="failed", message="排程工作不存在")
        return
    scheduling.sync_job(backend, job)
    job_batch.started_at = job_batch.started_at or job.started_at
    if job.status == JobStatus.SUCCEEDED.value:
        _finish(session, row, job_batch, status="failed", message="工作結束，但沒有回報推論結果",
                finished_at=job.finished_at)
    elif job.status == JobStatus.FAILED.value:
        _finish(session, row, job_batch, status="failed", message=job.message or "批次推論工作失敗",
                finished_at=job.finished_at)
    elif job.status == JobStatus.CANCELLED.value:
        _finish(session, row, job_batch, status="cancelled", message=job.message, finished_at=job.finished_at)
    elif not (row.status == JobStatus.RUNNING.value and job.status == JobStatus.QUEUED.value):
        row.status = job.status     # 已下載輸入包（running）但排程還沒看到 Pod ready 時，不退回 queued


def sync_all(session: Session, backend: JobBackend | None, rows: list[InferenceRecord]) -> None:
    pending = [r for r in rows if r.mode == "batch" and r.status not in DONE]
    for row in pending:
        sync(session, backend, row)
    if pending:
        session.commit()


def cancel(ctx: ProjectContext, backend: JobBackend, row: InferenceRecord, *, source_ip: str | None) -> InferenceRecord:
    session = ctx.session
    if row.mode != "batch" or row.batch is None:
        raise Conflict(f"推論 {row.id} 不是批次推論，無法取消")
    sync(session, backend, row)
    if row.status in DONE:
        session.commit()
        raise Conflict(f"推論 {row.id} 已結束（{row.status}），無法取消")
    job_batch = row.batch
    job = session.get(Job, job_batch.job_id)
    try:
        scheduling.mark_cancelled(session, backend, job, actor=ctx.user.username, source_ip=source_ip)
    except scheduling.SchedulingError as exc:
        session.rollback()
        raise Unavailable(str(exc)) from exc
    _finish(session, row, job_batch, status="cancelled", message=f"由 {ctx.user.username} 取消")
    record(session, actor=ctx.user.username, category=AuditCategory.INFERENCE, action="inference.batch.cancel",
           target=f"inference:{row.id}", result="cancelled", source_ip=source_ip,
           detail={"project_id": row.project_id, "model_id": row.model_id, "job_id": job.id})
    session.commit()
    return row


# ---------------------------------------------------------------- 工作 I/O（Job 容器）

def io_record(session: Session, record_id: int, token: str | None) -> InferenceRecord:
    """驗證 token。不存在的推論（包括專案已刪除）與錯誤的 token 回同樣的 401。"""
    row = session.get(InferenceRecord, record_id)
    job_batch = row.batch if row is not None else None
    expected = job_batch.io_token_hash if job_batch is not None else "0" * 64
    ok = bool(token) and hmac.compare_digest(_token_hash(token or ""), expected)
    if job_batch is None or not ok or not job_batch.io_token_hash:
        raise Unauthorized("工作憑證無效")
    if session.get(Project, row.project_id) is None:     # 專案已刪除（資料列由外鍵 CASCADE 或清理流程移除）
        raise Unauthorized("工作憑證無效")
    if job_batch.io_closed or row.status in DONE:
        raise Unauthorized("工作憑證已失效（推論已結束）")
    return row


def _add(archive: tarfile.TarFile, name: str, data: bytes) -> None:
    info = tarfile.TarInfo(name)
    info.size, info.mode = len(data), 0o644
    archive.addfile(info, io.BytesIO(data))


def io_bundle(session: Session, store: ObjectStore, row: InferenceRecord) -> bytes:
    try:
        return _bundle(session, store, row)
    except ObjectNotFound as exc:
        raise Conflict(f"推論 {row.id} 的模型或輸入資料已不存在") from exc


def _bundle(session: Session, store: ObjectStore, row: InferenceRecord) -> bytes:
    model = session.get(TrainedModel, row.model_id)
    run = session.get(TrainingRun, model.run_id)
    manifest = snapshot.load_manifest(store, _version(session, model))
    meta: dict[str, Any] = {"inference_id": row.id, "kind": model.kind, "format": model.format, "card": model.card}
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w") as archive:
        _add(archive, f"model.{model.format}", store.get(model.object_key))
        if _image(model):
            items = {i["id"]: i for i in manifest["items"]}
            meta["images"] = []
            for n, item_id in enumerate(row.input["items"]):
                ref = items[item_id]["files"]["image"]
                meta["images"].append({"name": item_id, "path": f"images/{n}", "format": ref["format"]})
                _add(archive, f"images/{n}", _blob(store, model, ref))
        else:
            preprocess = _artifact(store, run, "preprocess.pkl")
            if preprocess is not None:
                _add(archive, "preprocess.pkl", preprocess)
            _add(archive, "schema.json", _blob(store, model, manifest["items"][0]["files"]["schema"]))
            header, rows = _tabular_input(store, model, manifest, row.input["rows"])
            _add(archive, "input.csv", _write_csv(header, rows))
        _add(archive, "batch.json", json.dumps(meta, ensure_ascii=False).encode("utf-8"))
    # Job 來下載輸入包就表示容器已在執行；小批次可能在下一次查詢前就結束，所以在這裡記下開始時間
    row.status = JobStatus.RUNNING.value
    row.batch.started_at = row.batch.started_at or utcnow()
    session.commit()
    return buffer.getvalue()


def _result(session: Session, store: ObjectStore, row: InferenceRecord, answer: Any) -> tuple[bytes, str, int, dict]:
    if not isinstance(answer, dict):
        raise Invalid("answer 必須是物件")
    model = session.get(TrainedModel, row.model_id)
    if not _image(model):
        manifest = snapshot.load_manifest(store, _version(session, model))
        header, rows = _tabular_input(store, model, manifest, row.input["rows"], with_target=True)
        predictions = answer.get("predictions")
        if not isinstance(predictions, list) or len(predictions) != len(rows):
            got = len(predictions) if isinstance(predictions, list) else 0
            raise InferenceError(f"批次推論工作回傳 {got} 筆，輸入是 {len(rows)} 筆")
        data, extra = _tabular_result(header, rows, answer, target=(model.card or {}).get("target"),
                                      positive=positive_label(model))
        return data, "csv", len(rows), extra
    results = answer.get("results")
    if not isinstance(results, list):
        raise InferenceError("批次推論工作沒有回傳影像結果")
    body = {"model_id": model.id, "kind": model.kind, "label_names": model.card.get("label_names", []),
            "results": results, "blocked": []}
    return json.dumps(body, ensure_ascii=False).encode("utf-8"), "json", len(results), {}


def _job_reported(session: Session, job_batch: InferenceBatch, status: str, message: str) -> None:
    """排程工作列與推論紀錄同時定案，不必等有人列出工作。記的是容器的結果（之後的結束碼）：
    回報 succeeded 但結果不合格時，推論紀錄是失敗、工作本身仍是成功。"""
    job = session.get(Job, job_batch.job_id) if job_batch.job_id else None
    if job is None:
        return
    job.started_at = job.started_at or job_batch.started_at
    scheduling.mark_reported(job, JobStatus(status), message if status == "failed" else "")


def io_complete(session: Session, store: ObjectStore, row: InferenceRecord, *, status: str, message: str,
                answer: Any) -> None:
    if status not in ("succeeded", "failed"):
        raise Invalid("status 必須是 succeeded 或 failed")
    job_batch = row.batch
    _job_reported(session, job_batch, status, message)
    if status == "failed":
        _finish(session, row, job_batch, status="failed", message=message or "批次推論工作回報失敗")
        session.commit()
        return
    try:
        data, fmt, count, extra = _result(session, store, row, answer)
    except (InferenceError, TrainingError) as exc:
        _finish(session, row, job_batch, status="failed", message=str(exc))
        session.commit()
        return
    row.count, row.input = count, {**row.input, **extra}
    _store_result(store, row, data, fmt)
    _finish(session, row, job_batch, status="succeeded")
    session.commit()


def get_batch_record(session: Session, project_id: int, record_id: int) -> InferenceRecord:
    row = session.get(InferenceRecord, record_id)
    if row is None or row.project_id != project_id:
        raise NotFound(f"找不到推論紀錄 {record_id}")
    return row
