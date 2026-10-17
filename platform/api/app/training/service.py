"""訓練、模型、推論、部署的業務邏輯。稽核與業務變更同一個交易。"""
from __future__ import annotations

import csv
import hashlib
import hmac
import io
import json
import os
import re
import secrets
from datetime import timezone
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.audit import AuditCategory, record
from app.deps import ProjectContext
from app.models import Membership, Project, User, utcnow
from app.permissions import Permission
from app.scheduling import service as scheduling
from app.scheduling.backend import JobBackend, Workload
from app.scheduling.models import Job
from app.scheduling.states import TERMINAL, JobStatus
from app.storage import ObjectNotFound, ObjectStore
from app.training import bundle, config as cfg, report, snapshot, tracking
from app.training.inference import (ImageInput, InferenceBackend, InferenceError, InferenceRejected,
                                    ModelNotLoaded)
from app.training.models import (DatasetVersion, Deployment, DeploymentTitle, InferenceRecord, RunStages, TrainedModel,
                                 TrainingRun, TrainingSetting)

ARTIFACTS = ("model.h5", "model.pkl", "preprocess.pkl", "metrics.json", "splits.json", "model_card.json",
             "train.log", "charts.json")
MAX_ARTIFACT_BYTES = int(os.environ.get("TRAINING_MAX_ARTIFACT_MB", "512")) * 1024 * 1024
MAX_INFERENCE_BYTES = int(os.environ.get("INFERENCE_MAX_UPLOAD_MB", "50")) * 1024 * 1024
MAX_ONLINE_ROWS = 1000
SUBSETS = ("train", "validation", "test", "all")
MEMORY_MB = {"image": 2048, "tabular": 1024, "fake": 512}
FORMATS = {".dcm": "dicom", ".dicom": "dicom", ".nii": "nifti", ".nii.gz": "nifti", ".mha": "itk", ".png": "png",
           ".npy": "npy"}
_NAME = re.compile(r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$")


class TrainingError(Exception):
    status_code = 400


class NotFound(TrainingError):
    status_code = 404


class Conflict(TrainingError):
    status_code = 409


class Invalid(TrainingError):
    status_code = 422


class Forbidden(TrainingError):
    status_code = 403


class Unauthorized(TrainingError):
    status_code = 401


class TooLarge(TrainingError):
    status_code = 413


class Unavailable(TrainingError):
    status_code = 503


def _iso(value) -> str | None:
    """一律輸出帶時區的 UTC 時間：SQLite 讀回來的時間沒有時區資訊，不補的話重新載入會與存檔時不同。"""
    if value is None:
        return None
    return (value if value.tzinfo else value.replace(tzinfo=timezone.utc)).isoformat()


# ---------------------------------------------------------------- 設定

def setting_out(row: TrainingSetting) -> dict[str, Any]:
    return {"id": row.id, "project_id": row.project_id, "name": row.name, "kind": row.kind, "config": row.config,
            "created_by": row.created_by, "updated_by": row.updated_by, "created_at": _iso(row.created_at),
            "updated_at": _iso(row.updated_at)}


def _check_name(name: Any) -> str:
    if not isinstance(name, str) or not name.strip() or len(name.strip()) > 128:
        raise Invalid("請輸入設定名稱（1 到 128 個字）")
    return name.strip()


def get_setting(session: Session, project_id: int, setting_id: int) -> TrainingSetting:
    row = session.get(TrainingSetting, setting_id)
    if row is None or row.project_id != project_id:
        raise NotFound(f"找不到訓練設定 {setting_id}")
    return row


def list_settings(session: Session, project_id: int) -> list[TrainingSetting]:
    return list(session.scalars(select(TrainingSetting).where(TrainingSetting.project_id == project_id)
                                .order_by(TrainingSetting.id)))


def _same_name(session: Session, project_id: int, name: str, *, exclude: int | None = None) -> None:
    other = session.scalar(select(TrainingSetting).where(TrainingSetting.project_id == project_id,
                                                         TrainingSetting.name == name))
    if other is not None and other.id != exclude:
        raise Conflict(f"訓練設定「{name}」已存在")


def create_setting(ctx: ProjectContext, *, name: Any, config: Any, source_ip: str | None,
                   detail: dict[str, Any] | None = None) -> TrainingSetting:
    name, normal = _check_name(name), cfg.normalise(config)
    _same_name(ctx.session, ctx.project.id, name)
    row = TrainingSetting(project_id=ctx.project.id, name=name, kind=normal["kind"], config=normal,
                          created_by=ctx.user.username, updated_by=ctx.user.username)
    ctx.session.add(row)
    ctx.session.flush()
    record(ctx.session, actor=ctx.user.username, category=AuditCategory.TRAINING, action="training_setting.create",
           target=f"training_setting:{row.id}", source_ip=source_ip,
           detail={"project_id": ctx.project.id, "name": name, "kind": row.kind, **(detail or {})})
    ctx.session.commit()
    return row


def update_setting(ctx: ProjectContext, setting_id: int, *, name: Any, config: Any,
                   source_ip: str | None) -> TrainingSetting:
    row = get_setting(ctx.session, ctx.project.id, setting_id)
    name, normal = _check_name(name), cfg.normalise(config)
    _same_name(ctx.session, ctx.project.id, name, exclude=row.id)
    from app.training import stages

    locked = stages.locked_changes(ctx.session, row, normal)
    if locked:
        raise Conflict(f"「{'、'.join(locked)}」環節由匯入的檔案控制，不能在介面修改；"
                       "要修改請到「流程程式碼」編輯，或按「改回用介面設定」")
    row.name, row.kind, row.config, row.updated_by = name, normal["kind"], normal, ctx.user.username
    record(ctx.session, actor=ctx.user.username, category=AuditCategory.TRAINING, action="training_setting.update",
           target=f"training_setting:{row.id}", source_ip=source_ip,
           detail={"project_id": ctx.project.id, "name": name, "kind": row.kind})
    ctx.session.commit()
    return row


def delete_setting(ctx: ProjectContext, setting_id: int, *, source_ip: str | None, store: ObjectStore | None = None
                   ) -> None:
    row = get_setting(ctx.session, ctx.project.id, setting_id)
    if store is not None:
        from app.training import stages

        stages.delete_files(ctx.session, store, row.id)       # 匯入控制的環節檔
        ctx.session.flush()
    ctx.session.delete(row)
    record(ctx.session, actor=ctx.user.username, category=AuditCategory.TRAINING, action="training_setting.delete",
           target=f"training_setting:{setting_id}", source_ip=source_ip,
           detail={"project_id": ctx.project.id, "name": row.name})
    ctx.session.commit()


# ---------------------------------------------------------------- 訓練

def run_prefix(run: TrainingRun) -> str:
    return f"projects/{run.project_id}/training/runs/{run.id}/"


def run_out(run: TrainingRun, version: DatasetVersion | None = None, model: TrainedModel | None = None) -> dict:
    out = {"id": run.id, "project_id": run.project_id, "setting_id": run.setting_id, "name": run.name,
           "kind": run.kind, "executor": run.executor, "status": run.status, "message": run.message,
           "seed": run.seed, "config": run.config, "dataset_version_id": run.dataset_version_id,
           "job_id": run.job_id, "parent_run_id": run.parent_run_id, "metrics": run.metrics,
           "artifacts": {name: {"sha256": a["sha256"], "size": a["size"]} for name, a in run.artifacts.items()},
           "tracking_run_id": run.tracking_run_id, "created_by": run.created_by,
           "created_at": _iso(run.created_at), "started_at": _iso(run.started_at),
           "finished_at": _iso(run.finished_at), "custom_source": run.source_key is not None,
           # 送出時由匯入檔控制的環節（例如 ["preprocess", "train"]）；沒有時是空清單
           "imported_stages": sorted(run.imported.stages) if run.imported is not None else []}
    if version is not None:
        out["dataset_version"] = snapshot.version_out(version)
    out["model_id"] = model.id if model is not None else None
    return out


_UNSET = object()


def get_tracker(state) -> tracking.Tracker | None:
    """app.state.tracker 有設定就用它（測試）；否則第一次使用時依 MLFLOW_TRACKING_URI 建立，未設定則不記錄。"""
    current = getattr(state, "tracker", _UNSET)
    if current is _UNSET:
        current = state.tracker = tracking.tracker_from_env(os.environ)
    return current


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def job_image(state, *, gpu: bool) -> str:
    """Job 映像。Keras 影像工作（訓練、批次推論）用 GPU 映像 TRAINING_GPU_IMAGE（NGC TensorFlow＋PyTorch），
    沒設定就用 TRAINING_IMAGE；結構式與假訓練一律用 TRAINING_IMAGE，scikit-learn 版本才會與推論服務一致。"""
    cpu = getattr(state, "training_image", None) or os.environ.get("TRAINING_IMAGE", "platform-trainer:dev")
    if not gpu:
        return cpu
    return getattr(state, "training_gpu_image", None) or os.environ.get("TRAINING_GPU_IMAGE") or cpu


IMPORTED_CODE_TIMEOUT = int(os.environ.get("TRAINING_IMPORTED_CODE_TIMEOUT_SECONDS", str(6 * 3600)))


def _workload(state, run: TrainingRun, token: str, *, timeout: int | None = None) -> Workload:
    image = job_image(state, gpu=run.executor != "fake" and run.kind in cfg.IMAGE_KINDS)
    base = (getattr(state, "job_io_url", None) or os.environ.get("JOB_IO_BASE_URL", "http://api:8000")).rstrip("/")
    size = "fake" if run.executor == "fake" else ("image" if run.kind in cfg.IMAGE_KINDS else "tabular")
    # 容器只拿到這三個值加上執行緒數；token 只對這一次訓練的資料包與產出有效，不是平台憑證
    env = {"RUN_ID": str(run.id), "JOB_IO_URL": f"{base}/api/job-io/runs/{run.id}", "JOB_IO_TOKEN": token,
           "TRAIN_THREADS": "1"}
    if timeout:
        env["JOB_TIMEOUT_SECONDS"] = str(timeout)     # runner 在時限到時停止使用者程式（匯入的環節程式）
    return Workload(image=image, command=("python", "-m", "trainer.runner"), env=env, memory_mb=MEMORY_MB[size],
                    cpu_request="250m", expected_seconds=60, training_id=run.id)


def _start(ctx: ProjectContext, state, backend: JobBackend, *, run: TrainingRun, version: DatasetVersion,
           action: str, source_ip: str | None, detail: dict[str, Any], timeout: int | None = None) -> TrainingRun:
    session = ctx.session
    session.add(run)
    session.flush()
    token = secrets.token_urlsafe(32)
    run.io_token_hash = _token_hash(token)
    tracker = get_tracker(state)
    if tracker is not None:
        try:
            run.tracking_run_id = tracker.start_run(
                experiment=f"project-{run.project_id}", name=f"run-{run.id}-{run.kind}",
                params=tracking.params_of(run.config),
                tags={"platform.run_id": str(run.id), "platform.project_id": str(run.project_id),
                      "platform.user": run.created_by, "platform.dataset_hash": version.content_hash,
                      "platform.executor": run.executor})
        except tracking.TrackingError as exc:
            run.message = f"訓練紀錄未寫入 MLflow：{exc}"
    record(session, actor=ctx.user.username, category=AuditCategory.TRAINING, action=action,
           target=f"training_run:{run.id}", source_ip=source_ip,
           detail={"project_id": run.project_id, "kind": run.kind, "executor": run.executor, "seed": run.seed,
                   "dataset_version_id": version.id, "dataset_hash": version.content_hash, **detail})

    def link(job: Job) -> None:
        run.job_id = job.id

    try:
        scheduling.submit_job(session, backend, project=ctx.project, actor=ctx.user.username, kind="training",
                              source_ip=source_ip, workload=_workload(state, run, token, timeout=timeout),
                              on_created=link)
    except scheduling.SchedulingError as exc:
        session.rollback()
        error = Unavailable if exc.status_code == 503 else Conflict
        raise error(str(exc)) from exc
    return run


def _executor(value: Any) -> str:
    executor = value or "template"
    if executor not in cfg.EXECUTORS:
        raise Invalid(f"executor 必須是：{'、'.join(cfg.EXECUTORS)}")
    return executor


def _translate(exc: Exception) -> TrainingError:
    if isinstance(exc, cfg.ConfigError):
        return Invalid(str(exc))
    if isinstance(exc, bundle.SourceError):
        return Invalid(str(exc))
    return Conflict(str(exc))


APPLY_HINT = "資料集的 Target／Feature 或前處理可能已修改；請在訓練設定按「套用資料集設定」，或重新選擇欄位。"


def check_tabular(store: ObjectStore, project_id: int, manifest: dict[str, Any], setting: dict[str, Any]) -> None:
    """送出前先用凍結的資料檢查結構式設定，避免排隊後才失敗：欄位存在、目標欄位可訓練、特徵不是識別碼。
    文字／類別特徵不用先編碼（範本會在 scikit-learn Pipeline 內自動 One-Hot）。"""
    from tabular.schema import Schema
    from tabular.validate import load_clean_csv

    files = manifest["items"][0]["files"]
    schema = Schema.from_dict(json.loads(store.get(snapshot.blob_key(project_id, files["schema"]["blob"]))))
    frame = load_clean_csv(io.BytesIO(store.get(snapshot.blob_key(project_id, files["csv"]["blob"]))), schema)
    check_tabular_frame(frame, setting)


def check_tabular_frame(frame, setting: dict[str, Any]) -> None:
    """check_tabular 的欄位檢查（資料表已載入）。流程程式碼套用時也用它檢查合併後的設定。"""
    import pandas as pd
    from tabular.errors import TabularError
    from tabular.fitted import fit_pipeline

    spec = setting["tabular"]
    try:
        _, out = fit_pipeline(frame, spec.get("steps") or [])
    except TabularError as exc:
        raise Invalid(f"前處理步驟無法套用在資料集上：{exc}。{APPLY_HINT}") from exc
    missing = [c for c in [spec["target"], *spec["features"]] if c not in out.columns]
    encoded = {c for s in spec.get("steps") or [] if s.get("id") == "onehot" for c in s.get("columns") or []}
    converted = [c for c in missing if c in encoded and c != spec["target"]]
    if converted:
        parts = []
        for c in converted:
            made = [o for o in out.columns if str(o).startswith(f"{c}_") and o not in frame.columns]
            parts.append(f"「{c}」已轉成 {'、'.join(map(str, made))}（One-Hot）")
        raise Invalid(f"{'；'.join(parts)}，請取消勾選原本的欄位，改用轉換後的欄位（在訓練設定勾選「{converted[0]}」那一項即可）。")
    if missing:
        raise Invalid(f"訓練設定與資料集不一致：前處理後找不到欄位「{'、'.join(missing)}」。{APPLY_HINT}")
    ids = [c for c in spec["features"]
           if not pd.api.types.is_numeric_dtype(out[c]) and not pd.api.types.is_bool_dtype(out[c])
           and out[c].nunique() > max(20, len(out) // 2)]
    if ids:
        raise Invalid(f"特徵欄位「{'、'.join(ids)}」幾乎每一列都不同（像病歷號或自由文字），不能當作特徵，"
                      "請在訓練設定取消勾選。")
    target = out[spec["target"]].dropna()
    if setting["kind"] == "tabular_classification" and target.astype(str).nunique() < 2:
        raise Invalid(f"目標欄位「{spec['target']}」只有一種類別，無法訓練分類模型")
    if setting["kind"] == "tabular_regression" and not pd.api.types.is_numeric_dtype(target):
        raise Invalid(f"目標欄位「{spec['target']}」不是數值，無法訓練迴歸模型；請改用「結構式分類」")


def submit_run(ctx: ProjectContext, state, backend: JobBackend, *, setting: TrainingSetting, executor: Any,
               source_ip: str | None) -> TrainingRun:
    executor = _executor(executor)
    scheduling.ensure_defaults(ctx.session)
    try:
        version, manifest = snapshot.freeze(ctx.session, state.store, orthanc=getattr(state, "orthanc", None),
                                            state=state, project_id=ctx.project.id, setting=setting.config,
                                            actor=ctx.user.username)
    except (cfg.ConfigError, snapshot.SnapshotError) as exc:
        ctx.session.rollback()
        raise _translate(exc) from exc
    # 流程程式碼：匯入控制的環節。整份設定要通過檢核；有改過程式的環節時組成原始碼 zip，以 executor=source 執行
    from app.training import stages

    problem = stages.setting_problem(ctx.session, state, setting)
    if problem:
        ctx.session.rollback()
        raise Conflict(f"匯入控制的環節需要處理，處理完才能送出訓練：{problem}")
    custom = stages.custom_stages(ctx.session, setting.id)
    # 標註或前處理用了自訂程式時，欄位可能由程式產生，留到訓練時檢查
    if setting.kind in cfg.TABULAR_KINDS and not (custom.get("labels") or custom.get("preprocess")):
        try:
            check_tabular(state.store, ctx.project.id, manifest, setting.config)
        except Invalid:
            ctx.session.rollback()
            raise
    source, used = stages.compose_source(ctx.session, state.store, setting)
    if source is not None and executor == "template":
        executor = "source"
    config = cfg.job_config(setting.config, executor=executor, label_names=manifest["label_names"])
    run = TrainingRun(project_id=ctx.project.id, setting_id=setting.id, dataset_version_id=version.id,
                      name=setting.name, kind=setting.kind, executor=executor, config=config, seed=config["seed"],
                      created_by=ctx.user.username)
    detail: dict[str, Any] = {"setting_id": setting.id, "items": version.item_count}
    if used:
        ctx.session.add(run)
        ctx.session.flush()
        ctx.session.add(RunStages(run_id=run.id, project_id=run.project_id, stages=used))
        detail["stages"] = {name: entry["sha256"] for name, entry in used.items()}
    if executor == "source":
        run.source_key = run_prefix(run) + "source.zip"
        state.store.put(run.source_key, source)
        detail["source_sha256"] = hashlib.sha256(source).hexdigest()
    try:
        out = _start(ctx, state, backend, run=run, version=version, action="training.submit", source_ip=source_ip,
                     detail=detail, timeout=IMPORTED_CODE_TIMEOUT if executor == "source" else None)
    except TrainingError:
        if run.source_key:
            state.store.delete(run.source_key)
        raise
    ctx.session.expire(out, ["imported"])
    return out


def rerun(ctx: ProjectContext, state, backend: JobBackend, *, run: TrainingRun,
          source_ip: str | None) -> TrainingRun:
    """重現：同一個資料版本、同一份設定、同一個亂數種子。"""
    scheduling.ensure_defaults(ctx.session)
    version = ctx.session.get(DatasetVersion, run.dataset_version_id)
    clone = TrainingRun(project_id=run.project_id, setting_id=run.setting_id, dataset_version_id=version.id,
                        parent_run_id=run.id, name=run.name, kind=run.kind, executor=run.executor,
                        config=json.loads(json.dumps(run.config)), seed=run.seed, source_key=run.source_key,
                        created_by=ctx.user.username)
    return _start(ctx, state, backend, run=clone, version=version, action="training.rerun", source_ip=source_ip,
                  detail={"parent_run_id": run.id})


def run_with_source(ctx: ProjectContext, state, backend: JobBackend, *, run: TrainingRun, data: bytes,
                    source_ip: str | None) -> TrainingRun:
    """以使用者修改後的原始碼執行。資料沿用原訓練凍結的版本；zip 內若有 config.json 則採用（種類不可改）。"""
    scheduling.ensure_defaults(ctx.session)
    try:
        files = bundle.read_source(data)
        config = json.loads(json.dumps(run.config))
        edited = bundle.source_config(files)
        if edited is not None:
            if edited.get("kind") != run.kind:
                raise bundle.SourceError(f"config.json 的訓練種類必須維持 {run.kind}")
            edited.pop("executor", None)
            source = ctx.session.get(DatasetVersion, run.dataset_version_id).source
            normal = cfg.normalise({**edited, "source": source})
            config = cfg.job_config(normal, executor="source",
                                    label_names=(run.config.get("image") or {}).get("labels"))
    except (bundle.SourceError, cfg.ConfigError) as exc:
        raise _translate(exc) from exc
    config["executor"] = "source"
    version = ctx.session.get(DatasetVersion, run.dataset_version_id)
    child = TrainingRun(project_id=run.project_id, setting_id=run.setting_id, dataset_version_id=version.id,
                        parent_run_id=run.id, name=f"{run.name}（修改後的原始碼）"[:128], kind=run.kind,
                        executor="source", config=config, seed=config["seed"], created_by=ctx.user.username)
    ctx.session.add(child)
    ctx.session.flush()
    child.source_key = run_prefix(child) + "source.zip"
    state.store.put(child.source_key, data)
    digest = hashlib.sha256(data).hexdigest()
    try:
        return _start(ctx, state, backend, run=child, version=version, action="training.run_source",
                      source_ip=source_ip, detail={"parent_run_id": run.id, "source_sha256": digest,
                                                   "files": sorted(files)})
    except TrainingError:
        state.store.delete(child.source_key)
        raise


def get_run(session: Session, project_id: int, run_id: int) -> TrainingRun:
    run = session.get(TrainingRun, run_id)
    if run is None or run.project_id != project_id:
        raise NotFound(f"找不到訓練 {run_id}")
    return run


def _artifact(store: ObjectStore, run: TrainingRun, name: str) -> bytes | None:
    entry = run.artifacts.get(name)
    if entry is None:
        return None
    try:
        return store.get(entry["key"])
    except ObjectNotFound:
        return None


def _json_artifact(store: ObjectStore, run: TrainingRun, name: str) -> dict | None:
    data = _artifact(store, run, name)
    try:
        value = json.loads(data) if data is not None else None
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def _finalise(session: Session, state, run: TrainingRun) -> None:
    """Job 成功後登記模型。沒有模型或模型卡就算失敗：成功的訓練一定有可下載的模型。"""
    store: ObjectStore = state.store
    fmt = cfg.MODEL_FORMAT[run.kind]
    card = _json_artifact(store, run, "model_card.json")
    entry = run.artifacts.get(f"model.{fmt}")
    if run.reported != "succeeded" or entry is None or card is None:
        run.status = JobStatus.FAILED.value
        run.message = run.message or "工作結束，但沒有上傳模型或模型卡"
        return
    run.status = JobStatus.SUCCEEDED.value
    run.metrics = card.get("metrics") or _json_artifact(store, run, "metrics.json") or {}
    version = session.get(DatasetVersion, run.dataset_version_id)
    card = {**card, "dataset_version_id": version.id, "dataset_content_hash": version.content_hash,
            "run_id": run.id, "executor": run.executor}
    session.add(TrainedModel(project_id=run.project_id, run_id=run.id, name=f"{run.name}-run{run.id}"[:128],
                             kind=run.kind, format=fmt, object_key=entry["key"], sha256=entry["sha256"],
                             size=entry["size"], card=card, created_by=run.created_by))


def sync_run(session: Session, state, backend: JobBackend, run: TrainingRun) -> None:
    if run.status in {s.value for s in TERMINAL}:
        return
    job = session.get(Job, run.job_id) if run.job_id else None
    if job is None:
        run.status, run.message = JobStatus.FAILED.value, "排程工作不存在"
    else:
        scheduling.sync_job(backend, job)
        run.started_at = job.started_at
        if job.status == JobStatus.SUCCEEDED.value:
            _finalise(session, state, run)
        else:
            run.status = job.status
            if job.status == JobStatus.FAILED.value:
                run.message = run.message or job.message or "訓練工作失敗"
    if run.status in {s.value for s in TERMINAL}:
        run.finished_at = (job.finished_at if job else None) or utcnow()
        run.io_closed = True
        record(session, actor=run.created_by, category=AuditCategory.TRAINING, action="training.finish",
               target=f"training_run:{run.id}", result="success" if run.status == "succeeded" else run.status,
               detail={"project_id": run.project_id, "status": run.status, "message": run.message})
        _track_finish(state, run)


def _track_finish(state, run: TrainingRun) -> None:
    tracker = get_tracker(state)
    if tracker is None or not run.tracking_run_id:
        return
    status = {"succeeded": "FINISHED", "failed": "FAILED", "cancelled": "KILLED"}[run.status]
    model = run.artifacts.get(f"model.{cfg.MODEL_FORMAT[run.kind]}") or {}
    try:
        tracker.finish_run(run.tracking_run_id, status=status, metrics=tracking.metrics_of(run.metrics),
                           tags={"platform.status": run.status, "platform.model_sha256": model.get("sha256", "")})
    except tracking.TrackingError as exc:
        run.message = (run.message + "；" if run.message else "") + f"訓練結果未寫入 MLflow：{exc}"


def _model_of(session: Session, run: TrainingRun) -> TrainedModel | None:
    return session.scalar(select(TrainedModel).where(TrainedModel.run_id == run.id))


def refresh_run(session: Session, state, backend: JobBackend, project_id: int, run_id: int) -> dict:
    run = get_run(session, project_id, run_id)
    sync_run(session, state, backend, run)
    session.commit()
    return run_out(run, session.get(DatasetVersion, run.dataset_version_id), _model_of(session, run))


def list_runs(session: Session, state, backend: JobBackend, project_id: int) -> list[dict]:
    runs = session.scalars(select(TrainingRun).where(TrainingRun.project_id == project_id)
                           .order_by(TrainingRun.id)).all()
    for run in runs:
        sync_run(session, state, backend, run)
    session.commit()
    return [run_out(r, model=_model_of(session, r)) for r in runs]


def page_runs(session: Session, state, backend: JobBackend, project_id: int, *, limit: int, offset: int = 0,
              created_by: str | None = None) -> tuple[int, list[dict]]:
    """訓練紀錄分頁：依編號由新到舊；created_by 只列這位使用者送出的。只同步這一頁的狀態。"""
    where = [TrainingRun.project_id == project_id]
    if created_by is not None:
        where.append(TrainingRun.created_by == created_by)
    total = session.scalar(select(func.count()).select_from(TrainingRun).where(*where)) or 0
    runs = session.scalars(select(TrainingRun).where(*where).order_by(TrainingRun.id.desc())
                           .limit(limit).offset(offset)).all()
    for run in runs:
        sync_run(session, state, backend, run)
    session.commit()
    return total, [run_out(r, model=_model_of(session, r)) for r in runs]


def cancel_run(ctx: ProjectContext, state, backend: JobBackend, run_id: int, *, source_ip: str | None) -> dict:
    run = get_run(ctx.session, ctx.project.id, run_id)
    sync_run(ctx.session, state, backend, run)
    if run.status in {s.value for s in TERMINAL}:
        ctx.session.commit()
        raise Conflict(f"訓練 {run_id} 已結束（{run.status}），無法取消")
    try:
        scheduling.cancel_job(ctx.session, backend, project_id=ctx.project.id, job_id=run.job_id,
                              actor=ctx.user.username, source_ip=source_ip)
    except scheduling.SchedulingError as exc:
        raise (Unavailable if exc.status_code == 503 else Conflict)(str(exc)) from exc
    run.status, run.io_closed, run.finished_at = JobStatus.CANCELLED.value, True, utcnow()
    run.message = f"由 {ctx.user.username} 取消"
    _track_finish(state, run)
    ctx.session.commit()
    return run_out(run)


def _scheduling_error(exc: scheduling.SchedulingError) -> TrainingError:
    error = {503: Unavailable, 403: Forbidden, 404: NotFound}.get(exc.status_code, Conflict)
    return error(str(exc))


def _queue_action(ctx: ProjectContext, state, backend: JobBackend, run_id: int, action, *,
                  source_ip: str | None) -> dict:
    run = get_run(ctx.session, ctx.project.id, run_id)
    sync_run(ctx.session, state, backend, run)
    job = ctx.session.get(Job, run.job_id) if run.job_id else None
    if run.status in {s.value for s in TERMINAL} or job is None:
        ctx.session.commit()
        raise Conflict(f"訓練 {run_id} 已結束（{run.status}）")
    try:
        scheduling.check_owner(job, ctx.user)
        action(ctx.session, backend, job, actor=ctx.user.username, source_ip=source_ip)
    except scheduling.SchedulingError as exc:
        ctx.session.rollback()
        raise _scheduling_error(exc) from exc
    run.status = job.status
    ctx.session.commit()
    return run_out(run)


def hold_run(ctx: ProjectContext, state, backend: JobBackend, run_id: int, *, source_ip: str | None) -> dict:
    """暫存排隊中的訓練：移出佇列、保留完整的工作定義（資料版本、設定、工作憑證都不變），稍後恢復排隊。
    已開始訓練的不能暫存（不支援中途保存進度）。"""
    run = get_run(ctx.session, ctx.project.id, run_id)
    sync_run(ctx.session, state, backend, run)
    if run.status == JobStatus.RUNNING.value:
        ctx.session.commit()
        raise Conflict(f"訓練 {run_id} 已開始訓練，無法暫存（訓練中無法中途保存進度，只能取消）")
    return _queue_action(ctx, state, backend, run_id, scheduling.mark_held, source_ip=source_ip)


def resume_run(ctx: ProjectContext, state, backend: JobBackend, run_id: int, *, source_ip: str | None) -> dict:
    """恢復排隊：以暫存的定義重新送出，排到佇列最後。"""
    return _queue_action(ctx, state, backend, run_id, scheduling.mark_resumed, source_ip=source_ip)


def save_run_as_setting(ctx: ProjectContext, run_id: int, *, name: Any, source_ip: str | None) -> TrainingSetting:
    """把訓練用的設定另存成新的訓練設定：Job 設定去掉執行方式，加回資料版本記下的資料來源。
    資料來源指向目前的資料（不是當時凍結的版本），之後送出會重新凍結。"""
    run = get_run(ctx.session, ctx.project.id, run_id)
    version = ctx.session.get(DatasetVersion, run.dataset_version_id)
    config = {k: v for k, v in run.config.items() if k != "executor"}
    try:
        normal = cfg.normalise({**config, "source": version.source})
    except cfg.ConfigError as exc:
        raise Invalid(f"訓練 {run_id} 的設定無法另存：{exc}") from exc
    return create_setting(ctx, name=name, config=normal, source_ip=source_ip, detail={"from_run_id": run.id})


def run_log(store: ObjectStore, run: TrainingRun) -> str:
    data = _artifact(store, run, "train.log")
    return data.decode("utf-8", "replace") if data is not None else ""


def run_charts(store: ObjectStore, run: TrainingRun) -> dict[str, Any]:
    """結果圖表資料（範本另外寫的 charts.json）；影像、fake-trainer、舊訓練沒有時為 None。"""
    charts = _json_artifact(store, run, "charts.json") if run.status == JobStatus.SUCCEEDED.value else None
    return {"run_id": run.id, "kind": run.kind, "charts": charts}


def run_report(ctx: ProjectContext, state, backend: JobBackend, run: TrainingRun, *,
               source_ip: str | None) -> bytes:
    """可列印的 HTML 報表。只有完成的訓練才有；下載寫 training 稽核。"""
    sync_run(ctx.session, state, backend, run)
    if run.status in (JobStatus.QUEUED.value, JobStatus.RUNNING.value, JobStatus.HELD.value):
        ctx.session.commit()
        raise Conflict(f"訓練 {run.id} 尚未完成，完成後才能下載報表")
    if run.status != JobStatus.SUCCEEDED.value:
        ctx.session.commit()
        raise Conflict(f"訓練 {run.id} 沒有成功完成（{run.status}），沒有可下載的報表")
    model = _model_of(ctx.session, run)
    title = model_titles(ctx.session, run.project_id, ctx.user.username).get(model.id) if model else None
    html = report.build(run=run_out(run), charts=run_charts(state.store, run)["charts"],
                        generated_by=ctx.user.username, title=title, model_name=model.name if model else None)
    data = html.encode("utf-8")
    record(ctx.session, actor=ctx.user.username, category=AuditCategory.TRAINING, action="training.report",
           target=f"training_run:{run.id}", source_ip=source_ip,
           detail={"project_id": run.project_id, "sha256": hashlib.sha256(data).hexdigest()})
    ctx.session.commit()
    return data


def get_version(session: Session, project_id: int, version_id: int) -> DatasetVersion:
    version = session.get(DatasetVersion, version_id)
    if version is None or version.project_id != project_id:
        raise NotFound(f"找不到資料版本 {version_id}")
    return version


def export_source(ctx: ProjectContext, state, run: TrainingRun, *, source_ip: str | None) -> bytes:
    if run.source_key:
        data = state.store.get(run.source_key)        # 這次訓練用的就是使用者的版本
    else:
        data = bundle.export_source(run.kind, {k: v for k, v in run.config.items() if k != "executor"})
    record(ctx.session, actor=ctx.user.username, category=AuditCategory.TRAINING, action="training.export_source",
           target=f"training_run:{run.id}", source_ip=source_ip,
           detail={"project_id": run.project_id, "sha256": hashlib.sha256(data).hexdigest()})
    ctx.session.commit()
    return data


# ---------------------------------------------------------------- 工作 I/O（Job 容器）

def io_run(session: Session, run_id: int, token: str | None) -> TrainingRun:
    """驗證 run token。不存在的訓練與錯誤的 token 回同樣的 401，不透露訓練是否存在。"""
    run = session.get(TrainingRun, run_id)
    expected = run.io_token_hash if run is not None else "0" * 64
    ok = bool(token) and hmac.compare_digest(_token_hash(token or ""), expected)
    if run is None or not ok or not run.io_token_hash:
        raise Unauthorized("工作憑證無效")
    if run.io_closed or run.status in {s.value for s in TERMINAL}:
        raise Unauthorized("工作憑證已失效（訓練已結束）")
    return run


def io_bundle(session: Session, store: ObjectStore, run: TrainingRun) -> bytes:
    version = session.get(DatasetVersion, run.dataset_version_id)
    source = store.get(run.source_key) if run.source_key else None
    return bundle.build_bundle(store, project_id=run.project_id, config=run.config,
                               manifest=snapshot.load_manifest(store, version), source=source)


def io_artifact(session: Session, store: ObjectStore, run: TrainingRun, name: str, data: bytes) -> dict:
    if name not in ARTIFACTS:
        raise Invalid(f"不接受的產出檔名：{name}（可用：{'、'.join(ARTIFACTS)}）")
    if len(data) > MAX_ARTIFACT_BYTES:
        raise TooLarge(f"產出檔超過上限 {MAX_ARTIFACT_BYTES // 1024 // 1024} MB")
    key = run_prefix(run) + name
    store.put(key, data)
    entry = {"key": key, "sha256": hashlib.sha256(data).hexdigest(), "size": len(data)}
    run.artifacts = {**run.artifacts, name: entry}
    session.commit()
    return {"name": name, "sha256": entry["sha256"], "size": entry["size"]}


def io_complete(session: Session, run: TrainingRun, *, status: str, message: str) -> None:
    if status not in ("succeeded", "failed"):
        raise Invalid("status 必須是 succeeded 或 failed")
    run.reported, run.io_closed = status, True
    if message:
        run.message = message[:1024]
    session.commit()


# ---------------------------------------------------------------- 模型

def model_out(model: TrainedModel) -> dict[str, Any]:
    return {"id": model.id, "project_id": model.project_id, "run_id": model.run_id, "name": model.name,
            "kind": model.kind, "format": model.format, "sha256": model.sha256, "size": model.size,
            "filename": f"{_slug(model.name)}.{model.format}", "card": model.card, "created_by": model.created_by,
            "created_at": _iso(model.created_at)}


def _slug(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip("-") or "model"


def ensure_deployable(model: TrainedModel) -> None:
    """使用者程式產生、引用了平台不允許類別的模型（runner 在訓練結束時檢查，寫在模型卡）：只能下載，
    不能在平台推論或部署。平台範本的模型卡沒有 deployable，一律可以。"""
    card = model.card or {}
    if card.get("deployable") is False:
        raise Conflict(card.get("deploy_blocked") or "這個模型使用自訂程式，不能在平台推論或部署，只能下載在平台外使用")


def get_model(session: Session, project_id: int, model_id: int) -> TrainedModel:
    model = session.get(TrainedModel, model_id)
    if model is None or model.project_id != project_id:
        raise NotFound(f"找不到模型 {model_id}")
    return model


def list_models(session: Session, project_id: int) -> list[TrainedModel]:
    return list(session.scalars(select(TrainedModel).where(TrainedModel.project_id == project_id)
                                .order_by(TrainedModel.id)))


def download_model(ctx: ProjectContext, store: ObjectStore, model: TrainedModel, *,
                   source_ip: str | None) -> bytes:
    try:
        data = store.get(model.object_key)
    except ObjectNotFound:
        raise NotFound(f"模型 {model.id} 的檔案已不存在") from None
    if hashlib.sha256(data).hexdigest() != model.sha256:
        raise Conflict(f"模型 {model.id} 的檔案與登記的雜湊不符，請重新訓練")
    record(ctx.session, actor=ctx.user.username, category=AuditCategory.TRAINING, action="model.download",
           target=f"model:{model.id}", source_ip=source_ip,
           detail={"project_id": model.project_id, "sha256": model.sha256, "format": model.format})
    ctx.session.commit()
    return data


# ---------------------------------------------------------------- 推論

def _load(backend: InferenceBackend, session: Session, store: ObjectStore, model: TrainedModel) -> None:
    run = session.get(TrainingRun, model.run_id)
    schema = None
    if model.kind in cfg.TABULAR_KINDS:
        manifest = snapshot.load_manifest(store, session.get(DatasetVersion, run.dataset_version_id))
        ref = manifest["items"][0]["files"]["schema"]
        schema = json.loads(store.get(snapshot.blob_key(model.project_id, ref["blob"])))
    backend.load(model.id, model=store.get(model.object_key), card=model.card,
                 preprocess=_artifact(store, run, "preprocess.pkl"), schema=schema)


def _predict(backend: InferenceBackend, session: Session, store: ObjectStore, model: TrainedModel, call):
    """推論服務重啟後會忘記模型：查無模型時重新推送一次再重試。"""
    try:
        return call()
    except ModelNotLoaded:
        _load(backend, session, store, model)
        return call()


def _prediction_column(columns: list[str]) -> str:
    name, n = "prediction", 1
    while name in columns:
        n += 1
        name = f"prediction_{n}"
    return name


def _read_csv(data: bytes) -> tuple[list[str], list[list[str]]]:
    try:
        rows = list(csv.reader(io.StringIO(data.decode("utf-8-sig"))))
    except (UnicodeDecodeError, csv.Error) as exc:
        raise Invalid(f"CSV 無法解析：{exc}") from None
    if not rows or not rows[0]:
        raise Invalid("CSV 沒有標頭列")
    header = rows[0]
    body = [r for r in rows[1:] if r]
    if any(len(r) != len(header) for r in body):
        raise Invalid("CSV 有資料列的欄位數與標頭不同")
    return header, body


def _write_csv(header: list[str], rows: list[list[Any]]) -> bytes:
    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\n")
    writer.writerow(header)
    writer.writerows(rows)
    return out.getvalue().encode("utf-8")


def positive_label(model: TrainedModel) -> str | None:
    """二元分類的陽性類別：訓練資料的類別排序後的第二個（scikit-learn 的 classes_[1]；0／1 時是「1」），
    與 ROC、敏感度、metrics.json 的 labels.positive 相同。不是二元分類時為 None。"""
    classes = (model.card or {}).get("classes") or []
    return str(classes[1]) if model.kind == "tabular_classification" and len(classes) == 2 else None


def _same_label(a: Any, b: str) -> bool:
    if str(a) == b:
        return True
    try:
        return float(a) == float(b)
    except (TypeError, ValueError):
        return False


def _tabular_result(header: list[str], rows: list[list[str]], answer: dict[str, Any], *,
                    target: str | None = None, positive: str | None = None) -> tuple[bytes, dict]:
    """在原始資料後面加預測欄。分類模型另加「預測類別的機率」欄（0～1，`prediction_probability`，意義不變）；
    二元分類（positive 不是 None）再加「陽性類別的機率」欄 `prediction_positive_probability`，放在 `prediction`
    前面，最後三欄維持 `prediction, prediction_probability, prediction_note`（驗收測試與外部程式依賴）。
    陽性的機率由預測類別與其機率換算：預測為陽性時是 p，否則 1 − p（二元分類兩類機率相加為 1）。
    說明欄寫成中文：二元分類「diagnosis＝1 的機率 6%」，多類別「預測為「b」的機率 70%」；無法預測時寫原因。
    迴歸沒有機率欄。"""
    predictions, notes = answer.get("predictions", []), answer.get("notes") or [None] * len(rows)
    if len(predictions) != len(rows):
        raise InferenceError(f"推論服務回傳 {len(predictions)} 筆，輸入是 {len(rows)} 筆")
    probabilities = answer.get("probabilities") or [None] * len(rows)
    with_probability = any(p is not None for p in probabilities)
    binary = with_probability and positive is not None
    column = _prediction_column(header)
    out_header = (header + ([f"{column}_positive_probability"] if binary else []) + [column]
                  + ([f"{column}_probability"] if with_probability else []) + [f"{column}_note"])
    out_rows = []
    for row, p, prob, note in zip(rows, predictions, probabilities, notes):
        chance = None
        if p is not None and prob is not None and binary:
            chance = prob if _same_label(p, positive) else round(1 - prob, 4)
            note = f"{target or '結果'}＝{positive} 的機率 {chance:.0%}" + (f"（{note}）" if note else "")
        elif p is not None and prob is not None:   # 補過缺值的列：機率後面附上補了什麼
            note = f"預測為「{p}」的機率 {prob:.0%}" + (f"（{note}）" if note else "")
        out_rows.append(row + (["" if chance is None else chance] if binary else []) + ["" if p is None else p]
                        + (["" if prob is None else prob] if with_probability else []) + [note or ""])
    unpredicted = sum(1 for p in predictions if p is None)
    extra = {"prediction_column": column, "unpredicted": unpredicted}
    if binary:
        extra["positive_label"] = positive
    return _write_csv(out_header, out_rows), extra


def _record(session: Session, *, model: TrainedModel, mode: str, user: str, status: str, count: int,
            input_: dict, message: str = "", deployment: Deployment | None = None,
            source_ip: str | None, action: str) -> InferenceRecord:
    row = InferenceRecord(project_id=model.project_id, model_id=model.id, mode=mode, status=status, user=user,
                          count=count, input=input_, message=message[:1024],
                          deployment_id=deployment.id if deployment else None)
    session.add(row)
    session.flush()
    record(session, actor=user, category=AuditCategory.INFERENCE, action=action, target=f"inference:{row.id}",
           result="success" if status == "succeeded" else "failure", source_ip=source_ip,
           detail={"project_id": model.project_id, "model_id": model.id, "mode": mode, "count": count,
                   "deployment": deployment.name if deployment else None, **({"message": message} if message else {})})
    return row


def _store_result(store: ObjectStore, row: InferenceRecord, data: bytes, fmt: str) -> None:
    row.result_key = f"projects/{row.project_id}/inference/{row.id}/result.{fmt}"
    row.result_format = fmt
    store.put(row.result_key, data)


def _run_inference(session: Session, state, backend: InferenceBackend, *, model: TrainedModel, mode: str,
                   user: str, input_: dict, source_ip: str | None, action: str, tabular: bytes | None = None,
                   images: list[ImageInput] | None = None, deployment: Deployment | None = None) -> InferenceRecord:
    store: ObjectStore = state.store
    try:
        if tabular is not None:
            header, rows = _read_csv(tabular)
            answer = _predict(backend, session, store, model, lambda: backend.predict_tabular(model.id, tabular))
            data, extra = _tabular_result(header, rows, answer, target=(model.card or {}).get("target"),
                                          positive=positive_label(model))
            fmt, count = "csv", len(rows)
        else:
            answer = _predict(backend, session, store, model, lambda: backend.predict_images(model.id, images))
            results = answer.get("results", [])
            body = {"model_id": model.id, "kind": model.kind, "label_names": model.card.get("label_names", []),
                    "results": results, "blocked": input_.get("blocked", [])}
            data, fmt, count, extra = json.dumps(body, ensure_ascii=False).encode("utf-8"), "json", len(results), {}
    except (InferenceError, TrainingError) as exc:
        session.rollback()
        _record(session, model=model, mode=mode, user=user, status="failed", count=0, input_=input_,
                message=str(exc), deployment=deployment, source_ip=source_ip, action=action)
        session.commit()
        if isinstance(exc, TrainingError):
            raise
        raise _inference_error(exc) from exc
    row = _record(session, model=model, mode=mode, user=user, status="succeeded", count=count,
                  input_={**input_, **extra}, deployment=deployment, source_ip=source_ip, action=action)
    _store_result(store, row, data, fmt)
    session.commit()
    return row


class BadGateway(TrainingError):
    status_code = 502


def _inference_error(exc: InferenceError) -> TrainingError:
    if isinstance(exc, InferenceRejected):
        return Invalid(str(exc))
    return (Unavailable if exc.status_code == 503 else BadGateway)(str(exc))


def inference_backend(state) -> InferenceBackend:
    backend = getattr(state, "inference_backend", None)
    if backend is None:
        from app.training.inference import inference_from_env

        backend = inference_from_env(os.environ)
        if backend is None:
            raise Unavailable("推論服務尚未設定（INFERENCE_URL）")
        state.inference_backend = backend
    return backend


def _splits(store: ObjectStore, session: Session, model: TrainedModel) -> dict[str, Any]:
    splits = _json_artifact(store, session.get(TrainingRun, model.run_id), "splits.json")
    if splits is None:
        raise Conflict("這次訓練沒有留下切分紀錄，無法依切分做批次推論")
    return splits


def image_format(name: str, data: bytes) -> str:
    lower = name.lower()
    for suffix, fmt in sorted(FORMATS.items(), key=lambda kv: -len(kv[0])):
        if lower.endswith(suffix):
            return fmt
    if data[128:132] == b"DICM":
        return "dicom"
    raise Invalid(f"無法判斷「{name}」的影像格式（支援 .dcm、.nii、.nii.gz、.mha、.png、.npy）")


def upload_inference(ctx: ProjectContext, state, *, model: TrainedModel, files: list[tuple[str, bytes]],
                     source_ip: str | None, blocked: list[dict] | None = None,
                     source: str | None = None) -> InferenceRecord:
    if not files:
        raise Invalid("請上傳至少一個檔案")
    if sum(len(d) for _, d in files) > MAX_INFERENCE_BYTES:
        raise TooLarge(f"上傳檔案超過上限 {MAX_INFERENCE_BYTES // 1024 // 1024} MB")
    ensure_deployable(model)
    backend = inference_backend(state)
    input_ = {"files": [{"name": n, "size": len(d), "sha256": hashlib.sha256(d).hexdigest()} for n, d in files]}
    if blocked:
        input_["blocked"] = blocked          # 掃毒攔下的檔案：不推論，留在紀錄與結果裡
    if source:
        input_["source"] = source            # try＝網頁的單人試用；mode 仍是 upload，稽核不變
    common = dict(model=model, mode="upload", user=ctx.user.username, input_=input_, source_ip=source_ip,
                  action="inference.upload")
    if model.kind in cfg.TABULAR_KINDS:
        if len(files) != 1:
            raise Invalid("結構式模型一次只能上傳一個 CSV")
        return _run_inference(ctx.session, state, backend, tabular=files[0][1], **common)
    images = [ImageInput(name=n, data=d, format=image_format(n, d)) for n, d in files]
    return _run_inference(ctx.session, state, backend, images=images, **common)


def record_out(row: InferenceRecord) -> dict[str, Any]:
    batch = row.batch if row.mode == "batch" else None      # 批次推論的排程資訊；其他方式為 null
    return {"id": row.id, "project_id": row.project_id, "model_id": row.model_id,
            "deployment_id": row.deployment_id, "mode": row.mode, "status": row.status, "user": row.user,
            "count": row.count, "input": row.input, "message": row.message, "result_format": row.result_format,
            "has_result": bool(row.result_key), "created_at": _iso(row.created_at),
            "job_id": batch.job_id if batch else None, "started_at": _iso(batch.started_at) if batch else None,
            "finished_at": _iso(batch.finished_at) if batch else None}


def list_records(session: Session, model: TrainedModel) -> list[InferenceRecord]:
    return list(session.scalars(select(InferenceRecord).where(InferenceRecord.model_id == model.id)
                                .order_by(InferenceRecord.id.desc())))


def get_record(session: Session, project_id: int, record_id: int) -> InferenceRecord:
    row = session.get(InferenceRecord, record_id)
    if row is None or row.project_id != project_id:
        raise NotFound(f"找不到推論紀錄 {record_id}")
    return row


def result_bytes(store: ObjectStore, row: InferenceRecord) -> bytes:
    if row.status in ("queued", "running", "held"):
        label = {"queued": "排隊中", "running": "執行中", "held": "已暫存"}[row.status]
        raise Conflict(f"推論 {row.id} 尚未完成（{label}），請稍後再下載")
    if not row.result_key:
        raise NotFound(f"推論紀錄 {row.id} 沒有結果（{row.message or row.status}）")
    try:
        return store.get(row.result_key)
    except ObjectNotFound:
        raise NotFound(f"推論紀錄 {row.id} 的結果檔已不存在") from None


def result_view(store: ObjectStore, row: InferenceRecord) -> dict[str, Any]:
    out = record_out(row)
    if not row.result_key:
        return out | {"result": None}
    data = result_bytes(store, row)
    if row.result_format == "csv":
        header, rows = _read_csv(data)
        return out | {"result": {"columns": header, "rows": rows,
                                 "prediction_column": row.input.get("prediction_column"),
                                 "positive_label": row.input.get("positive_label")}}
    return out | {"result": json.loads(data)}


# ---------------------------------------------------------------- 線上部署

def _title(session: Session, row: Deployment) -> str:
    title = session.scalar(select(DeploymentTitle.title).where(DeploymentTitle.deployment_id == row.id))
    if title:
        return title
    model = session.get(TrainedModel, row.model_id)
    return model.name if model else row.name


def without_platform_access(session: Session, project_id: int, users: list[str]) -> list[str]:
    """授權帳號中不是本專案成員、或沒有 Prediction 權限的人：登入後在「推論服務管理」看不到這個模型，
    只能用程式呼叫線上端點。"""
    if not users:
        return []
    rows = session.execute(select(User.username, Membership.permissions)
                           .join(Membership, Membership.user_id == User.id)
                           .where(Membership.project_id == project_id, User.username.in_(users))).all()
    able = {name for name, perms in rows if Permission.PREDICTION.value in (perms or [])}
    return [u for u in users if u not in able]


def deployment_out(row: Deployment, session: Session | None = None) -> dict[str, Any]:
    out = {"id": row.id, "project_id": row.project_id, "model_id": row.model_id, "name": row.name,
           "allowed_users": row.allowed_users, "endpoint": f"/api/inference/{row.name}/predict",
           "created_by": row.created_by, "created_at": _iso(row.created_at)}
    if session is not None:
        model = session.get(TrainedModel, row.model_id)
        # 模型名稱與種類：清單顯示用，網頁的試呼叫依種類決定送 JSON rows 或上傳影像
        out["model_name"] = model.name if model else None
        out["model_kind"] = model.kind if model else None
        out["title"] = _title(session, row)
        out["cannot_use_in_platform"] = without_platform_access(session, row.project_id, list(row.allowed_users))
    return out


def model_titles(session: Session, project_id: int, username: str | None = None) -> dict[int, str]:
    """模型編號 → 顯示名稱（分享時取的名稱）。一個模型分享多次時：優先用分享給這位使用者的最新一次，
    否則用最新一次分享。沒有分享過的模型不在結果中（畫面改用模型名稱）。"""
    rows = session.execute(select(Deployment.model_id, Deployment.allowed_users, DeploymentTitle.title)
                           .join(DeploymentTitle, DeploymentTitle.deployment_id == Deployment.id)
                           .where(Deployment.project_id == project_id).order_by(Deployment.id)).all()
    newest: dict[int, str] = {}
    mine: dict[int, str] = {}
    for model_id, users, title in rows:
        newest[model_id] = title
        if username and username in (users or []):
            mine[model_id] = title
    return newest | mine


def shared_with(session: Session, project_id: int, username: str) -> dict[int, str]:
    """分享給這位使用者的模型（模型編號 → 分享者）：部署的授權帳號包含他。"""
    out: dict[int, str] = {}
    for row in list_deployments(session, project_id):
        if username in (row.allowed_users or []) and row.created_by != username:
            out.setdefault(row.model_id, row.created_by)
    return out


def _auto_name(session: Session, model: TrainedModel) -> str:
    base = f"model-{model.id}"
    taken = set(session.scalars(select(Deployment.name).where(Deployment.name.like(f"{base}%"))))
    if base not in taken:
        return base
    n = 2
    while f"{base}-{n}" in taken:
        n += 1
    return f"{base}-{n}"


def _users(session: Session, names: Any) -> list[str]:
    if not isinstance(names, list) or not all(isinstance(n, str) and n for n in names):
        raise Invalid("allowed_users 必須是帳號名稱的清單")
    names = sorted(set(names))
    known = set(session.scalars(select(User.username).where(User.username.in_(names)))) if names else set()
    missing = [n for n in names if n not in known]
    if missing:
        raise Invalid(f"帳號不存在：{'、'.join(missing)}")
    return names


def get_deployment(session: Session, project_id: int, deployment_id: int) -> Deployment:
    row = session.get(Deployment, deployment_id)
    if row is None or row.project_id != project_id:
        raise NotFound(f"找不到部署 {deployment_id}")
    return row


def list_deployments(session: Session, project_id: int) -> list[Deployment]:
    return list(session.scalars(select(Deployment).where(Deployment.project_id == project_id)
                                .order_by(Deployment.id)))


def create_deployment(ctx: ProjectContext, state, *, model: TrainedModel, name: Any, allowed_users: Any,
                      source_ip: str | None, title: Any = None) -> Deployment:
    """name 是網址上的技術名稱（小寫英數字與 -）；沒給時自動產生 model-{模型編號}。
    title 是給人看的顯示名稱（可用中文），沒給時用模型名稱。"""
    if name is None or name == "":
        name = _auto_name(ctx.session, model)
    if not isinstance(name, str) or not _NAME.match(name):
        raise Invalid("部署名稱只能用小寫英數字與連字號，開頭結尾必須是英數字，最多 63 字")
    if title is not None and (not isinstance(title, str) or len(title.strip()) > 128):
        raise Invalid("顯示名稱最多 128 字")
    ensure_deployable(model)
    title = (title or "").strip() or model.name
    users = _users(ctx.session, allowed_users)
    if ctx.session.scalar(select(Deployment).where(Deployment.name == name)):
        raise Conflict(f"部署名稱「{name}」已被使用")
    try:
        _load(inference_backend(state), ctx.session, state.store, model)
    except InferenceError as exc:
        raise _inference_error(exc) from exc
    row = Deployment(project_id=ctx.project.id, model_id=model.id, name=name, allowed_users=users,
                     created_by=ctx.user.username)
    ctx.session.add(row)
    ctx.session.flush()
    ctx.session.add(DeploymentTitle(deployment_id=row.id, project_id=ctx.project.id, title=title[:128]))
    record(ctx.session, actor=ctx.user.username, category=AuditCategory.INFERENCE, action="deployment.create",
           target=f"deployment:{row.id}", source_ip=source_ip,
           detail={"project_id": ctx.project.id, "model_id": model.id, "name": name, "allowed_users": users})
    ctx.session.commit()
    return row


def set_access(ctx: ProjectContext, deployment: Deployment, *, allowed_users: Any,
               source_ip: str | None) -> Deployment:
    users = _users(ctx.session, allowed_users)
    before = list(deployment.allowed_users)
    deployment.allowed_users = users
    record(ctx.session, actor=ctx.user.username, category=AuditCategory.INFERENCE, action="deployment.access",
           target=f"deployment:{deployment.id}", source_ip=source_ip,
           detail={"project_id": deployment.project_id, "name": deployment.name, "before": before, "after": users})
    ctx.session.commit()
    return deployment


def delete_deployment(ctx: ProjectContext, state, deployment: Deployment, *, source_ip: str | None) -> None:
    for title in ctx.session.scalars(select(DeploymentTitle).where(DeploymentTitle.deployment_id == deployment.id)):
        ctx.session.delete(title)
    ctx.session.flush()
    ctx.session.delete(deployment)
    record(ctx.session, actor=ctx.user.username, category=AuditCategory.INFERENCE, action="deployment.delete",
           target=f"deployment:{deployment.id}", source_ip=source_ip,
           detail={"project_id": deployment.project_id, "name": deployment.name})
    ctx.session.commit()


def rows_to_csv(model: TrainedModel, rows: Any) -> bytes:
    if not isinstance(rows, list) or not rows or not all(isinstance(r, dict) for r in rows):
        raise Invalid("rows 必須是非空的物件清單，每個物件是一筆資料（欄位名稱 → 值）")
    if len(rows) > MAX_ONLINE_ROWS:
        raise Invalid(f"一次最多 {MAX_ONLINE_ROWS} 筆")
    header: list[str] = []
    for row in rows:
        for key in row:
            if key not in header:
                header.append(str(key))
    return _write_csv(header, [["" if row.get(k) is None else row.get(k) for k in header] for row in rows])


def authorised_deployment(session: Session, *, name: str, user: User, source_ip: str | None) -> Deployment:
    deployment = session.scalar(select(Deployment).where(Deployment.name == name))
    if deployment is None or user.username not in deployment.allowed_users:
        # 不存在與未授權回同樣的 403，不透露部署是否存在；拒絕也留稽核
        record(session, actor=user.username, category=AuditCategory.INFERENCE, action="inference.online",
               target=f"deployment:{name}"[:128], result="denied", source_ip=source_ip,
               detail={"deployment": name[:128], "reason": "not_authorized"})
        session.commit()
        raise Forbidden("你沒有呼叫這個推論服務的授權")
    return deployment


def online_predict(session: Session, state, *, name: str, user: User, rows: Any = None,
                   files: list[tuple[str, bytes]] | None = None, source_ip: str | None,
                   blocked: list[dict] | None = None) -> dict[str, Any]:
    deployment = authorised_deployment(session, name=name, user=user, source_ip=source_ip)
    model = session.get(TrainedModel, deployment.model_id)
    backend = inference_backend(state)
    common = dict(model=model, mode="online", user=user.username, source_ip=source_ip, action="inference.online",
                  deployment=deployment)
    if model.kind in cfg.TABULAR_KINDS:
        data = rows_to_csv(model, rows)
        row = _run_inference(session, state, backend, tabular=data, input_={"rows": len(rows)}, **common)
        header, body = _read_csv(result_bytes(state.store, row))
        column = row.input["prediction_column"]
        index, note = header.index(column), header.index(f"{column}_note")
        prob = header.index(f"{column}_probability") if f"{column}_probability" in header else None
        out = {"inference_id": row.id, "deployment": name, "model_id": model.id,
               "predictions": [r[index] if r[index] != "" else None for r in body],
               "notes": [r[note] or None for r in body]}
        if prob is not None:
            out["probabilities"] = [float(r[prob]) if r[prob] != "" else None for r in body]
        positive = f"{column}_positive_probability"
        if row.input.get("positive_label") is not None and positive in header:   # 二元分類：陽性類別的機率
            at = header.index(positive)
            out["positive_label"] = row.input["positive_label"]
            out["positive_probabilities"] = [float(r[at]) if r[at] != "" else None for r in body]
        return out
    if not files:
        raise Invalid("請上傳至少一個影像檔")
    if sum(len(d) for _, d in files) > MAX_INFERENCE_BYTES:
        raise TooLarge(f"上傳檔案超過上限 {MAX_INFERENCE_BYTES // 1024 // 1024} MB")
    images = [ImageInput(name=n, data=d, format=image_format(n, d)) for n, d in files]
    input_ = {"files": [{"name": n, "size": len(d)} for n, d in files]} | ({"blocked": blocked} if blocked else {})
    row = _run_inference(session, state, backend, images=images, input_=input_, **common)
    body = json.loads(result_bytes(state.store, row))
    return {"inference_id": row.id, "deployment": name, "model_id": model.id, "results": body["results"],
            "blocked": body.get("blocked", [])}


def project_of(session: Session, project_id: int) -> Project | None:
    return session.get(Project, project_id)
