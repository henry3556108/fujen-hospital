"""Admin Dashboard（A-03「可檢視 Dashboard 頁面」）：全部是即時的 count(*)，與資料庫一致（TC-A03-10 以 psql 比對）。"""
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.imaging.models import ImagingStudy
from app.models import LabelGroup, LabelGroupMember, Membership, Project, User, utcnow
from app.permissions import AccountType
from app.scheduling.models import GpuGroup, Job
from app.scheduling.states import JobStatus
from app.tabular_api.models import TabularDataset


def _count(session: Session, model) -> int:
    return session.scalar(select(func.count()).select_from(model)) or 0


def _by(session: Session, column) -> dict:
    return {key: n for key, n in session.execute(select(column, func.count()).group_by(column))}


def summary(session: Session) -> dict:
    accounts = _by(session, User.account_type)
    jobs = _by(session, Job.status)
    by_status = {s.value: jobs.pop(s.value, 0) for s in JobStatus}
    by_status.update(jobs)  # 不認得的狀態（舊資料）也列出，總數才對得上
    members = _by(session, Membership.project_id)
    groups = _by(session, LabelGroup.project_id)
    datasets = _by(session, TabularDataset.project_id)
    studies = _by(session, ImagingStudy.project_id)
    project_jobs = _by(session, Job.project_id)
    return {
        "generated_at": utcnow(),
        "accounts": {"total": sum(accounts.values()),
                     **{t.value: accounts.get(t.value, 0) for t in AccountType}},
        "projects": _count(session, Project),
        "memberships": _count(session, Membership),
        "labeling_groups": _count(session, LabelGroup),
        "labeling_group_members": _count(session, LabelGroupMember),
        "tabular_datasets": _count(session, TabularDataset),
        "imaging_studies": _count(session, ImagingStudy),
        "gpu_groups": _count(session, GpuGroup),
        "jobs": {"total": sum(by_status.values()), "by_status": by_status},
        "per_project": [
            {"id": p.id, "name": p.name, "gpu_group": p.gpu_group, "members": members.get(p.id, 0),
             "labeling_groups": groups.get(p.id, 0), "tabular_datasets": datasets.get(p.id, 0),
             "imaging_studies": studies.get(p.id, 0), "jobs": project_jobs.get(p.id, 0)}
            for p in session.scalars(select(Project).order_by(Project.id))
        ],
    }
