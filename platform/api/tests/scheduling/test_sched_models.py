import pytest
from sqlalchemy import create_engine
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models import Base
from app.scheduling.models import GpuGroup, Job, SharedSchedulingSettings


@pytest.fixture
def db():
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    with Session(engine) as s:
        yield s


def test_tables_share_platform_metadata():
    assert {"gpu_groups", "jobs", "shared_scheduling_settings"} <= set(Base.metadata.tables)


def test_job_defaults(db):
    job = Job(project_id=1, user="ra01", kind="training", gpu_group="gpu-exclusive", queue="gpu-exclusive")
    db.add(job)
    db.commit()
    assert job.status == "queued" and job.created_at is not None
    assert job.started_at is None and job.finished_at is None


def test_group_name_unique(db):
    db.add(GpuGroup(name="g", pool="gpu-exclusive", gpu_count=2, mode="exclusive"))
    db.commit()
    db.add(GpuGroup(name="g", pool="gpu-shared", gpu_count=1, mode="shared"))
    with pytest.raises(IntegrityError):
        db.commit()


def test_settings_defaults(db):
    s = SharedSchedulingSettings(id=1)
    db.add(s)
    db.commit()
    assert s.time_slice_replicas == 4 and s.job_timeout_minutes == 60
