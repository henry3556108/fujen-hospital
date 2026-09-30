"""刪除專案時，排程工作與訓練相關的資料列一併刪除（資料庫層 ON DELETE CASCADE）。

SQLite 預設不檢查外鍵，這裡對 SQLite 開啟 foreign_keys；另外在 PostgreSQL 上跑同一個測試：
  TEST_POSTGRES_URL=postgresql+psycopg://postgres:test@127.0.0.1:55433/postgres uv run pytest tests/training/test_train_project_delete.py
"""
import os

import pytest
from sqlalchemy import event, func, select

from app import admin_service
from app.db import make_engine, make_sessionmaker
from app.models import Base, Membership, Project, User
from app.scheduling.models import Job
from app.training.models import (DatasetVersion, Deployment, InferenceBatch, InferenceRecord, TrainedModel,
                                 TrainingRun, TrainingSetting)

TABLES = (Job, TrainingSetting, DatasetVersion, TrainingRun, TrainedModel, Deployment, InferenceRecord, InferenceBatch)
PG_URL = os.environ.get("TEST_POSTGRES_URL")


def sqlite_engine():
    engine = make_engine("sqlite://")

    @event.listens_for(engine, "connect")
    def _fk(dbapi, _):
        dbapi.execute("PRAGMA foreign_keys=ON")

    return engine


@pytest.fixture(params=["sqlite", pytest.param("postgresql", marks=pytest.mark.skipif(
    not PG_URL, reason="需要 TEST_POSTGRES_URL（PostgreSQL）"))])
def sessions(request):
    engine = sqlite_engine() if request.param == "sqlite" else make_engine(PG_URL)
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    yield make_sessionmaker(engine)
    Base.metadata.drop_all(engine)
    engine.dispose()


def fill(s, name: str) -> int:
    """一個專案內有工作、設定、資料版本、訓練、模型、部署、推論紀錄各一筆。"""
    project = Project(name=name, gpu_group="gpu-exclusive")
    user = User(username=f"u-{name}", account_type="user", idp_subject=f"sub-{name}")
    s.add_all([project, user])
    s.flush()
    s.add(Membership(user_id=user.id, project_id=project.id, role="principal_investigator", permissions=[]))
    job = Job(project_id=project.id, user=user.username, kind="training", queue="gpu-exclusive",
              k8s_name=f"job-{name}")
    setting = TrainingSetting(project_id=project.id, name="s", kind="tabular_regression", config={},
                              created_by="u", updated_by="u")
    version = DatasetVersion(project_id=project.id, kind="tabular_regression", content_hash=name * 8,
                             manifest_key="k", item_count=1, source={}, created_by="u")
    s.add_all([job, setting, version])
    s.flush()
    run = TrainingRun(project_id=project.id, setting_id=setting.id, dataset_version_id=version.id, job_id=job.id,
                      kind="tabular_regression", executor="fake", config={}, seed=1, created_by="u")
    s.add(run)
    s.flush()
    model = TrainedModel(project_id=project.id, run_id=run.id, name="m", kind="tabular_regression", format="pkl",
                         object_key="k", sha256="0" * 64, size=1, created_by="u")
    s.add(model)
    s.flush()
    deployment = Deployment(project_id=project.id, model_id=model.id, name=f"d-{name}", created_by="u")
    s.add(deployment)
    s.flush()
    s.add(InferenceRecord(project_id=project.id, model_id=model.id, deployment_id=deployment.id, mode="online",
                          status="succeeded", user="u"))
    # 排隊中的批次推論：工作列、推論紀錄、批次列都要跟著專案刪除（之後 Job 以 token 下載只會得到 401）
    batch_job = Job(project_id=project.id, user=user.username, kind="inference", queue="gpu-exclusive",
                    k8s_name=f"job-{name}-batch")
    queued = InferenceRecord(project_id=project.id, model_id=model.id, mode="batch", status="queued", user="u")
    s.add_all([batch_job, queued])
    s.flush()
    s.add(InferenceBatch(record_id=queued.id, project_id=project.id, job_id=batch_job.id, io_token_hash="0" * 64))
    s.commit()
    return project.id


def counts(s, project_id: int) -> dict[str, int]:
    return {t.__tablename__: s.scalar(select(func.count()).select_from(t).where(t.project_id == project_id))
            for t in TABLES}


def test_deleting_a_project_removes_its_jobs_and_training_rows(sessions):
    with sessions() as s:
        doomed, kept = fill(s, "p1"), fill(s, "p2")
        before = counts(s, kept)
        assert set(counts(s, doomed).values()) >= {1}
        admin_service.delete_project(s, actor="admin01", project_id=doomed)
    with sessions() as s:
        assert set(counts(s, doomed).values()) == {0}
        assert counts(s, kept) == before, "其他專案不受影響"
