"""GET /api/projects/{project_id}/overview：專案首頁的資料。專案成員皆可呼叫，依權限回傳區塊，沒有權限的區塊不回傳。

- data（Project）：影像研究數、表格資料集數
- labeling（Labeling）：待處理、已確認、研究總數、這個人上次存過的標註
- training（Training）：最近 5 筆訓練（含排隊位置）、7 天內完成的訓練（最多 3 筆）
- models、predictions（Prediction）：可以使用的模型、最近的預測紀錄
"""
import logging
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Request
from sqlalchemy import func, select

from app.authz import effective_permissions
from app.deps import ProjectContext, require_project_permission
from app.models import Membership
from app.permissions import AccountType, Permission

log = logging.getLogger(__name__)
router = APIRouter()

can_view = require_project_permission(*Permission)    # 任一權限＝專案成員
RECENT_RUNS = 5
RECENT_DAYS = 7
RECENT_COMPLETED = 3
RECENT_PREDICTIONS = 5


def _iso(value) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _data(ctx: ProjectContext) -> dict:
    from app.imaging.models import ImagingStudy
    from app.imaging.service import _studies_query
    from app.tabular_api.models import TabularDataset

    q = _studies_query(ctx.session, ctx.project.id)
    studies = ctx.session.scalar(select(func.count()).select_from(q.with_only_columns(ImagingStudy.id).subquery()))
    tabular = ctx.session.scalar(select(func.count()).select_from(TabularDataset)
                                 .where(TabularDataset.project_id == ctx.project.id))
    return {"studies": studies or 0, "tabular_datasets": tabular or 0}


def _labeling(ctx: ProjectContext) -> dict:
    from app.labeling import service as labeling
    from app.labeling.models import Annotation

    summary = labeling.summary(ctx.session, ctx.project.id)
    accession = {s["study_instance_uid"]: s["accession_number"] for s in summary["studies"]}
    last = None
    for a in ctx.session.scalars(select(Annotation).where(Annotation.project_id == ctx.project.id,
                                                          Annotation.updated_by == ctx.user.username)
                                 .order_by(Annotation.updated_at.desc(), Annotation.id.desc()).limit(20)):
        if a.study_instance_uid in accession:            # 只算看得到的研究
            last = {"study_instance_uid": a.study_instance_uid, "accession_number": accession[a.study_instance_uid],
                    "updated_at": _iso(a.updated_at)}
            break
    return {"pending": summary["pending"], "confirmed": summary["confirmed"],
            "total_studies": len(summary["studies"]), "last": last}


def _queue_positions(request: Request, session, jobs: list) -> dict[int, int]:
    """與排程總覽相同的排隊位置：同一佇列裡等待中的工作依排程系統實際的先後排第幾。排程服務讀不到時不給。"""
    from app.scheduling.models import Job
    from app.scheduling.router import get_backend
    from app.scheduling.states import JobStatus

    waiting = [j for j in jobs if j.status == JobStatus.QUEUED.value and j.k8s_name]
    if not waiting:
        return {}
    try:
        backend = get_backend(request)
    except Exception:
        return {}
    out: dict[int, int] = {}
    for queue in {j.queue for j in waiting}:
        try:
            order = {name: i for i, name in enumerate(backend.order(queue))}
        except Exception as exc:
            log.warning("無法讀取佇列 %s 的順序：%s", queue, exc)
            continue
        queued = session.scalars(select(Job).where(Job.queue == queue, Job.status == JobStatus.QUEUED.value)).all()
        ranked = sorted((j for j in queued if j.k8s_name in order), key=lambda j: order[j.k8s_name])
        for no, job in enumerate(ranked, 1):
            out[job.id] = no
    return out


def _training(ctx: ProjectContext, request: Request) -> dict:
    from app.scheduling.models import Job
    from app.training.models import TrainingRun

    runs = ctx.session.scalars(select(TrainingRun).where(TrainingRun.project_id == ctx.project.id)
                               .order_by(TrainingRun.id.desc()).limit(RECENT_RUNS)).all()
    jobs = [ctx.session.get(Job, r.job_id) for r in runs if r.job_id is not None]
    positions = _queue_positions(request, ctx.session, [j for j in jobs if j is not None])
    since = datetime.now(timezone.utc) - timedelta(days=RECENT_DAYS)
    done = ctx.session.scalars(select(TrainingRun).where(TrainingRun.project_id == ctx.project.id,
                                                         TrainingRun.status == "succeeded",
                                                         TrainingRun.finished_at.is_not(None))
                               .order_by(TrainingRun.finished_at.desc(), TrainingRun.id.desc()).limit(20)).all()
    recent_completed = []
    for r in done:
        finished = r.finished_at if r.finished_at.tzinfo else r.finished_at.replace(tzinfo=timezone.utc)
        if finished >= since:
            recent_completed.append(r.id)
    return {"recent": [{"id": r.id, "status": r.status,
                        "queue_position": positions.get(r.job_id) if r.status == "queued" else None,
                        "task": r.kind, "setting_name": r.name, "created_at": _iso(r.created_at),
                        "finished_at": _iso(r.finished_at)} for r in runs],
            "recent_completed": recent_completed[:RECENT_COMPLETED]}


def _primary(kind: str, metrics: dict) -> tuple[str | None, float | None]:
    from app.training.report import PRIMARY

    for split in ("test", "validation", "train"):
        scores = metrics.get(split) if isinstance(metrics, dict) else None
        if not isinstance(scores, dict):
            continue
        for name in PRIMARY.get(kind, ()):
            value = scores.get(name)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                return name, float(value)
    return None, None


def _models(ctx: ProjectContext) -> list[dict]:
    from app.training import service as training
    from app.training.models import TrainedModel, TrainingRun

    titles = training.model_titles(ctx.session, ctx.project.id, ctx.user.username)
    rows = ctx.session.execute(select(TrainedModel, TrainingRun).join(TrainingRun, TrainedModel.run_id == TrainingRun.id)
                               .where(TrainedModel.project_id == ctx.project.id)
                               .order_by(TrainedModel.id.desc())).all()
    out = []
    for model, run in rows:
        name, value = _primary(model.kind, run.metrics or model.card.get("metrics") or {})
        out.append({"run_id": run.id, "name": titles.get(model.id, model.name), "task": model.kind,
                    "metric_name": name, "metric_value": value, "finished_at": _iso(run.finished_at)})
    return out


def _predictions(ctx: ProjectContext) -> list[dict]:
    from app.training import service as training
    from app.training.models import InferenceRecord, TrainedModel

    titles = training.model_titles(ctx.session, ctx.project.id, ctx.user.username)
    rows = ctx.session.execute(select(InferenceRecord, TrainedModel)
                               .join(TrainedModel, InferenceRecord.model_id == TrainedModel.id)
                               .where(InferenceRecord.project_id == ctx.project.id)
                               .order_by(InferenceRecord.id.desc()).limit(RECENT_PREDICTIONS)).all()
    return [{"id": rec.id, "run_id": model.run_id, "model_name": titles.get(model.id, model.name),
             "created_at": _iso(rec.created_at), "rows": rec.count} for rec, model in rows]


@router.get("/api/projects/{project_id}/overview")
def overview(request: Request, ctx: ProjectContext = Depends(can_view)) -> dict:
    perms = effective_permissions(ctx.session, ctx.user, ctx.project.id)
    membership = ctx.session.scalar(select(Membership).where(Membership.user_id == ctx.user.id,
                                                             Membership.project_id == ctx.project.id))
    role = membership.role if membership is not None else (
        "admin" if ctx.user.account_type == AccountType.ADMIN else None)
    out: dict = {"project": {"id": ctx.project.id, "name": ctx.project.name},
                 "me": {"role": role, "permissions": sorted(p.value for p in perms)}}
    if Permission.PROJECT in perms:
        out["data"] = _data(ctx)
    if Permission.LABELING in perms:
        out["labeling"] = _labeling(ctx)
    if Permission.TRAINING in perms:
        out["training"] = _training(ctx, request)
    if Permission.PREDICTION in perms:
        out["models"] = _models(ctx)
        out["predictions"] = _predictions(ctx)
    return out
