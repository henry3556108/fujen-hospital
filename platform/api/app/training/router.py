"""訓練、模型、推論、部署的端點，以及只給 Job 容器用的工作 I/O 端點。"""
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from fastapi import APIRouter, Body, Depends, File, Header, HTTPException, Request, Response, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app import scanning
from app.deps import ProjectContext, client_ip, current_user, get_session, require_project_permission
from app.models import User
from app.permissions import Permission
from app.scheduling.backend import JobBackend
from app.scheduling.backend import backend_from_env
from app.scheduling.router import get_backend
from app.training import batch, config as cfg, service, snapshot

router = APIRouter()

can_train = require_project_permission(Permission.TRAINING)
can_code = require_project_permission(Permission.CODING)
can_predict = require_project_permission(Permission.PREDICTION)
BASE = "/api/projects/{project_id}"


@contextmanager
def _errors() -> Iterator[None]:
    try:
        yield
    except service.TrainingError as exc:
        raise HTTPException(exc.status_code, str(exc))
    except cfg.ConfigError as exc:
        raise HTTPException(422, str(exc))


def _download(data: bytes, filename: str, media_type: str = "application/octet-stream") -> Response:
    return Response(content=data, media_type=media_type,
                    headers={"Content-Disposition": f'attachment; filename="{filename}"'})


# ---------------------------------------------------------------- 設定

class SettingIn(BaseModel):
    name: str
    config: dict[str, Any]


@router.get(BASE + "/training/catalogue")
def catalogue(ctx: ProjectContext = Depends(can_train)) -> dict:
    return cfg.catalogue()


@router.post(BASE + "/training/settings", status_code=201)
def create_setting(body: SettingIn, request: Request, ctx: ProjectContext = Depends(can_train)) -> dict:
    with _errors():
        return service.setting_out(service.create_setting(ctx, name=body.name, config=body.config,
                                                          source_ip=client_ip(request)))


@router.get(BASE + "/training/settings")
def list_settings(ctx: ProjectContext = Depends(can_train)) -> list[dict]:
    return [service.setting_out(s) for s in service.list_settings(ctx.session, ctx.project.id)]


@router.get(BASE + "/training/settings/{setting_id}")
def get_setting(setting_id: int, ctx: ProjectContext = Depends(can_train)) -> dict:
    with _errors():
        return service.setting_out(service.get_setting(ctx.session, ctx.project.id, setting_id))


@router.put(BASE + "/training/settings/{setting_id}")
def update_setting(setting_id: int, body: SettingIn, request: Request,
                   ctx: ProjectContext = Depends(can_train)) -> dict:
    with _errors():
        return service.setting_out(service.update_setting(ctx, setting_id, name=body.name, config=body.config,
                                                          source_ip=client_ip(request)))


@router.delete(BASE + "/training/settings/{setting_id}", status_code=204)
def delete_setting(setting_id: int, request: Request, ctx: ProjectContext = Depends(can_train)) -> Response:
    with _errors():
        service.delete_setting(ctx, setting_id, source_ip=client_ip(request))
    return Response(status_code=204)


# ---------------------------------------------------------------- 訓練

class RunIn(BaseModel):
    executor: str = "template"


def _created(ctx: ProjectContext, request: Request, backend: JobBackend, run) -> dict:
    return service.refresh_run(ctx.session, request.app.state, backend, ctx.project.id, run.id)


@router.post(BASE + "/training/settings/{setting_id}/runs", status_code=201)
def submit_run(setting_id: int, request: Request, body: RunIn | None = None,
               ctx: ProjectContext = Depends(can_train), backend: JobBackend = Depends(get_backend)) -> dict:
    with _errors():
        setting = service.get_setting(ctx.session, ctx.project.id, setting_id)
        run = service.submit_run(ctx, request.app.state, backend, setting=setting,
                                 executor=(body or RunIn()).executor, source_ip=client_ip(request))
        return _created(ctx, request, backend, run)


@router.get(BASE + "/training/runs")
def list_runs(request: Request, ctx: ProjectContext = Depends(can_train),
              backend: JobBackend = Depends(get_backend)) -> list[dict]:
    return service.list_runs(ctx.session, request.app.state, backend, ctx.project.id)


@router.get(BASE + "/training/runs/{run_id}")
def get_run(run_id: int, request: Request, ctx: ProjectContext = Depends(can_train),
            backend: JobBackend = Depends(get_backend)) -> dict:
    with _errors():
        return service.refresh_run(ctx.session, request.app.state, backend, ctx.project.id, run_id)


@router.post(BASE + "/training/runs/{run_id}/rerun", status_code=201)
def rerun(run_id: int, request: Request, ctx: ProjectContext = Depends(can_train),
          backend: JobBackend = Depends(get_backend)) -> dict:
    with _errors():
        run = service.get_run(ctx.session, ctx.project.id, run_id)
        if run.source_key and Permission.CODING not in _permissions(ctx):
            raise HTTPException(403, {"code": "forbidden", "permission": "coding",
                                      "message": "重跑使用者原始碼的訓練需要 coding 權限"})
        return _created(ctx, request, backend, service.rerun(ctx, request.app.state, backend, run=run,
                                                             source_ip=client_ip(request)))


def _permissions(ctx: ProjectContext):
    from app.authz import effective_permissions

    return effective_permissions(ctx.session, ctx.user, ctx.project.id)


@router.post(BASE + "/training/runs/{run_id}/cancel")
def cancel_run(run_id: int, request: Request, ctx: ProjectContext = Depends(can_train),
               backend: JobBackend = Depends(get_backend)) -> dict:
    with _errors():
        return service.cancel_run(ctx, request.app.state, backend, run_id, source_ip=client_ip(request))


@router.get(BASE + "/training/runs/{run_id}/log")
def run_log(run_id: int, request: Request, ctx: ProjectContext = Depends(can_train)) -> dict:
    with _errors():
        run = service.get_run(ctx.session, ctx.project.id, run_id)
        return {"run_id": run.id, "status": run.status, "log": service.run_log(request.app.state.store, run)}


@router.get(BASE + "/training/runs/{run_id}/charts")
def run_charts(run_id: int, request: Request, ctx: ProjectContext = Depends(can_train)) -> dict:
    with _errors():
        run = service.get_run(ctx.session, ctx.project.id, run_id)
        return service.run_charts(request.app.state.store, run)


@router.get(BASE + "/training/runs/{run_id}/report")
def run_report(run_id: int, request: Request, ctx: ProjectContext = Depends(can_train),
               backend: JobBackend = Depends(get_backend)) -> Response:
    with _errors():
        run = service.get_run(ctx.session, ctx.project.id, run_id)
        data = service.run_report(ctx, request.app.state, backend, run, source_ip=client_ip(request))
    return _download(data, f"training-run-{run_id}-report.html", "text/html; charset=utf-8")


@router.get(BASE + "/training/runs/{run_id}/source")
def export_source(run_id: int, request: Request, ctx: ProjectContext = Depends(can_code)) -> Response:
    with _errors():
        run = service.get_run(ctx.session, ctx.project.id, run_id)
        data = service.export_source(ctx, request.app.state, run, source_ip=client_ip(request))
    return _download(data, f"training-run-{run_id}-source.zip", "application/zip")


@router.post(BASE + "/training/runs/{run_id}/source-runs", status_code=201)
def run_source(run_id: int, request: Request, file: UploadFile = File(...),
               ctx: ProjectContext = Depends(can_code), backend: JobBackend = Depends(get_backend)) -> dict:
    # 執行自己改過的程式同時需要 coding（改程式）與 training（占用排程資源）
    if Permission.TRAINING not in _permissions(ctx):
        raise HTTPException(403, {"code": "forbidden", "permission": "training", "message": "你沒有 training 權限"})
    data = file.file.read(service.bundle.MAX_SOURCE_BYTES + 1)
    scanning.ensure_clean(request, file.filename or "source.zip", data)   # 不乾淨回 422 並寫 malware_blocked 稽核
    with _errors():
        run = service.get_run(ctx.session, ctx.project.id, run_id)
        child = service.run_with_source(ctx, request.app.state, backend, run=run, data=data,
                                        source_ip=client_ip(request))
        return _created(ctx, request, backend, child)


@router.get(BASE + "/training/dataset-versions/{version_id}")
def dataset_version(version_id: int, request: Request, ctx: ProjectContext = Depends(can_train)) -> dict:
    with _errors():
        version = service.get_version(ctx.session, ctx.project.id, version_id)
    manifest = snapshot.load_manifest(request.app.state.store, version)
    return snapshot.version_out(version) | {
        "label_names": manifest["label_names"],
        "items": [{"id": i["id"], "group": i.get("group"), "label": i.get("label"),
                   "boxes": len(i.get("boxes") or []),
                   "files": {k: {"sha256": f["blob"], "format": f["format"], "size": f["size"]}
                             for k, f in i["files"].items()}} for i in manifest["items"]]}


# ---------------------------------------------------------------- 模型

@router.get(BASE + "/models")
def list_models(ctx: ProjectContext = Depends(can_predict)) -> list[dict]:
    shared = service.shared_with(ctx.session, ctx.project.id, ctx.user.username)
    titles = service.model_titles(ctx.session, ctx.project.id, ctx.user.username)
    return [service.model_out(m) | {"shared_with_me": m.id in shared, "shared_by": shared.get(m.id),
                                    "title": titles.get(m.id)}
            for m in service.list_models(ctx.session, ctx.project.id)]


@router.get(BASE + "/models/{model_id}")
def get_model(model_id: int, ctx: ProjectContext = Depends(can_predict)) -> dict:
    with _errors():
        model = service.get_model(ctx.session, ctx.project.id, model_id)
        title = service.model_titles(ctx.session, ctx.project.id, ctx.user.username).get(model.id)
        return service.model_out(model) | {"title": title}


@router.get(BASE + "/models/{model_id}/download")
def download_model(model_id: int, request: Request, ctx: ProjectContext = Depends(can_train)) -> Response:
    with _errors():
        model = service.get_model(ctx.session, ctx.project.id, model_id)
        data = service.download_model(ctx, request.app.state.store, model, source_ip=client_ip(request))
        out = service.model_out(model)
    response = _download(data, out["filename"])
    response.headers["X-Content-SHA256"] = model.sha256
    return response


# ---------------------------------------------------------------- 推論

class BatchIn(BaseModel):
    subset: str = "test"


def _optional_backend(request: Request) -> JobBackend | None:
    """查詢推論時同步批次狀態用；沒有設定排程後端時不同步（上傳、線上推論不需要排程）。"""
    backend = getattr(request.app.state, "job_backend", None)
    if backend is None:
        backend = backend_from_env()
        if backend is not None:
            request.app.state.job_backend = backend
    return backend


@router.post(BASE + "/models/{model_id}/inference/batch", status_code=202)
def batch_inference(model_id: int, request: Request, body: BatchIn | None = None,
                    ctx: ProjectContext = Depends(can_predict), backend: JobBackend = Depends(get_backend)) -> dict:
    """送出批次推論，立即回傳推論紀錄（status: queued）。之後以 GET /inference/{id} 查狀態與結果。"""
    with _errors():
        model = service.get_model(ctx.session, ctx.project.id, model_id)
        row = batch.submit(ctx, request.app.state, backend, model=model, subset=(body or BatchIn()).subset,
                           source_ip=client_ip(request))
        return service.result_view(request.app.state.store, row)


@router.post(BASE + "/inference/{record_id}/cancel")
def cancel_inference(record_id: int, request: Request, ctx: ProjectContext = Depends(can_predict),
                     backend: JobBackend = Depends(get_backend)) -> dict:
    with _errors():
        row = service.get_record(ctx.session, ctx.project.id, record_id)
        return service.record_out(batch.cancel(ctx, backend, row, source_ip=client_ip(request)))


def _scan(request: Request, model, uploads: list[tuple[str, bytes]]) -> tuple[list[tuple[str, bytes]], list[dict]]:
    """上傳推論的掃毒。結構式只有一個 CSV：不乾淨整個請求拒絕。影像是一批：被攔下的檔案單獨失敗、
    列在結果的 blocked，其餘照常推論；全部被攔下時拒絕。"""
    if not model.kind.startswith("image_"):
        for name, data in uploads:
            scanning.ensure_clean(request, name, data)
        return uploads, []
    clean, blocked = [], []
    for name, data in uploads:
        reason = scanning.blocked_reason(request, name, data)
        if reason:
            blocked.append({"name": name, "reason": reason})
        else:
            clean.append((name, data))
    if not clean:
        raise HTTPException(422, {"code": "all_files_blocked", "message": "所有檔案都未通過掃毒，已拒絕",
                                  "blocked": blocked})
    return clean, blocked


def _read_uploads(files: list[UploadFile]) -> list[tuple[str, bytes]]:
    out, total = [], 0
    for f in files:
        data = f.file.read(service.MAX_INFERENCE_BYTES + 1)
        total += len(data)
        if total > service.MAX_INFERENCE_BYTES:
            raise HTTPException(413, f"上傳檔案超過上限 {service.MAX_INFERENCE_BYTES // 1024 // 1024} MB")
        out.append((f.filename or "upload", data))
    return out


@router.post(BASE + "/models/{model_id}/inference/upload", status_code=201)
def upload_inference(model_id: int, request: Request, files: list[UploadFile] = File(...),
                     ctx: ProjectContext = Depends(can_predict)) -> dict:
    uploads = _read_uploads(files)
    with _errors():
        model = service.get_model(ctx.session, ctx.project.id, model_id)
    uploads, blocked = _scan(request, model, uploads)
    with _errors():
        row = service.upload_inference(ctx, request.app.state, model=model, files=uploads, blocked=blocked,
                                       source_ip=client_ip(request))
        return service.result_view(request.app.state.store, row)


@router.get(BASE + "/models/{model_id}/inference")
def inference_history(model_id: int, request: Request, ctx: ProjectContext = Depends(can_predict)) -> list[dict]:
    with _errors():
        model = service.get_model(ctx.session, ctx.project.id, model_id)
        rows = service.list_records(ctx.session, model)
        batch.sync_all(ctx.session, _optional_backend(request), rows)
        return [service.record_out(r) for r in rows]


@router.get(BASE + "/inference/{record_id}")
def inference_result(record_id: int, request: Request, ctx: ProjectContext = Depends(can_predict)) -> dict:
    with _errors():
        row = service.get_record(ctx.session, ctx.project.id, record_id)
        batch.sync_all(ctx.session, _optional_backend(request), [row])
        return service.result_view(request.app.state.store, row)


@router.get(BASE + "/inference/{record_id}/download")
def inference_download(record_id: int, request: Request, ctx: ProjectContext = Depends(can_predict)) -> Response:
    with _errors():
        row = service.get_record(ctx.session, ctx.project.id, record_id)
        batch.sync_all(ctx.session, _optional_backend(request), [row])
        data = service.result_bytes(request.app.state.store, row)
    media = "text/csv; charset=utf-8" if row.result_format == "csv" else "application/json"
    return _download(data, f"inference-{row.id}.{row.result_format}", media)


# ---------------------------------------------------------------- 線上部署

class DeploymentIn(BaseModel):
    model_id: int
    name: str | None = None        # 技術名稱（網址上的）；省略時自動產生 model-{模型編號}
    title: str | None = None       # 顯示名稱，可用中文；省略時用模型名稱
    allowed_users: list[str] = []


class AccessIn(BaseModel):
    allowed_users: list[str]


@router.post(BASE + "/deployments", status_code=201)
def create_deployment(body: DeploymentIn, request: Request, ctx: ProjectContext = Depends(can_train)) -> dict:
    with _errors():
        model = service.get_model(ctx.session, ctx.project.id, body.model_id)
        row = service.create_deployment(ctx, request.app.state, model=model, name=body.name, title=body.title,
                                        allowed_users=body.allowed_users, source_ip=client_ip(request))
        return service.deployment_out(row, ctx.session)


@router.get(BASE + "/deployments")
def list_deployments(ctx: ProjectContext = Depends(can_train)) -> list[dict]:
    return [service.deployment_out(d, ctx.session) for d in service.list_deployments(ctx.session, ctx.project.id)]


@router.put(BASE + "/deployments/{deployment_id}/access")
def set_access(deployment_id: int, body: AccessIn, request: Request,
               ctx: ProjectContext = Depends(can_train)) -> dict:
    with _errors():
        deployment = service.get_deployment(ctx.session, ctx.project.id, deployment_id)
        return service.deployment_out(service.set_access(ctx, deployment, allowed_users=body.allowed_users,
                                                         source_ip=client_ip(request)), ctx.session)


@router.delete(BASE + "/deployments/{deployment_id}", status_code=204)
def delete_deployment(deployment_id: int, request: Request, ctx: ProjectContext = Depends(can_train)) -> Response:
    with _errors():
        deployment = service.get_deployment(ctx.session, ctx.project.id, deployment_id)
        service.delete_deployment(ctx, request.app.state, deployment, source_ip=client_ip(request))
    return Response(status_code=204)


@router.post("/api/inference/{name}/predict")
async def online_predict(name: str, request: Request, user: User = Depends(current_user),
                         session: Session = Depends(get_session)) -> dict:
    """線上即時推論。結構式：JSON {"rows": [{欄位: 值}]}；影像：multipart 的 files。"""
    rows, files = None, None
    content_type = request.headers.get("content-type", "")
    if content_type.startswith("multipart/form-data"):
        form = await request.form()
        files = []
        for value in form.getlist("files"):
            if hasattr(value, "read"):
                files.append((value.filename or "upload", await value.read()))
    else:
        try:
            body = await request.json()
        except ValueError:
            raise HTTPException(422, "請以 JSON 傳入 {\"rows\": [...]}，或以 multipart 上傳 files")
        rows = body.get("rows") if isinstance(body, dict) else None
    if files:
        with _errors():   # 先確認授權再掃毒：未授權的呼叫一律 403
            service.authorised_deployment(session, name=name, user=user, source_ip=client_ip(request))
        files, blocked = _scan(request, _ImageModel(), files)
    else:
        blocked = []
    with _errors():
        return service.online_predict(session, request.app.state, name=name, user=user, rows=rows, files=files,
                                      blocked=blocked, source_ip=client_ip(request))


class _ImageModel:
    """線上推論以 multipart 送檔案時一定是影像模型（結構式用 JSON rows）；掃毒時當成一批影像處理。"""
    kind = "image_"


# ---------------------------------------------------------------- 工作 I/O（只給 Job 容器）

def io_run(run_id: int, x_job_token: str | None = Header(default=None),
           session: Session = Depends(get_session)):
    with _errors():
        return service.io_run(session, run_id, x_job_token), session


@router.get("/api/job-io/runs/{run_id}/bundle")
def io_bundle(request: Request, found=Depends(io_run)) -> Response:
    run, session = found
    with _errors():
        data = service.io_bundle(session, request.app.state.store, run)
    return Response(content=data, media_type="application/x-tar")


@router.put("/api/job-io/runs/{run_id}/artifacts/{name}")
async def io_artifact(name: str, request: Request, found=Depends(io_run)) -> dict:
    run, session = found
    data = await request.body()
    with _errors():
        return service.io_artifact(session, request.app.state.store, run, name, data)


class CompleteIn(BaseModel):
    status: str
    message: str = ""


@router.post("/api/job-io/runs/{run_id}/complete")
def io_complete(body: CompleteIn = Body(...), found=Depends(io_run)) -> dict:
    run, session = found
    with _errors():
        service.io_complete(session, run, status=body.status, message=body.message)
    return {"run_id": run.id, "reported": run.reported}


# ---------------------------------------------------------------- 批次推論的工作 I/O（只給 Job 容器）

def io_inference(record_id: int, x_job_token: str | None = Header(default=None),
                 session: Session = Depends(get_session)):
    with _errors():
        return batch.io_record(session, record_id, x_job_token), session


@router.get("/api/job-io/inference/{record_id}/bundle")
def io_inference_bundle(request: Request, found=Depends(io_inference)) -> Response:
    row, session = found
    with _errors():
        data = batch.io_bundle(session, request.app.state.store, row)
    return Response(content=data, media_type="application/x-tar")


class BatchCompleteIn(BaseModel):
    status: str
    message: str = ""
    answer: dict[str, Any] | None = None


@router.post("/api/job-io/inference/{record_id}/complete")
def io_inference_complete(request: Request, body: BatchCompleteIn = Body(...), found=Depends(io_inference)) -> dict:
    row, session = found
    if int(request.headers.get("content-length") or 0) > batch.MAX_ANSWER_BYTES:
        raise HTTPException(413, f"推論結果超過上限 {batch.MAX_ANSWER_BYTES // 1024 // 1024} MB")
    with _errors():
        batch.io_complete(session, request.app.state.store, row, status=body.status, message=body.message,
                          answer=body.answer)
    return {"inference_id": row.id, "status": row.status}
