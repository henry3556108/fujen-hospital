from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models import Base, utcnow


class GpuGroup(Base):
    """GPU 群組：專案以 Project.gpu_group（名稱）綁定。pool 對應節點標籤 platform/pool 與同名 Kueue 佇列。"""
    __tablename__ = "gpu_groups"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(64), unique=True)
    pool: Mapped[str] = mapped_column(String(64))
    gpu_count: Mapped[int] = mapped_column(Integer)
    mode: Mapped[str] = mapped_column(String(16))  # exclusive | shared


class Job(Base):
    __tablename__ = "jobs"
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), index=True)
    user: Mapped[str] = mapped_column(String(64))
    kind: Mapped[str] = mapped_column(String(32))
    gpu_group: Mapped[str | None] = mapped_column(String(64), default=None)
    queue: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(16), default="queued", index=True)
    k8s_name: Mapped[str | None] = mapped_column(String(63), default=None, unique=True)
    message: Mapped[str] = mapped_column(String(512), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)


class SharedSchedulingSettings(Base):
    """共享池排程設定，單列（id=1）。"""
    __tablename__ = "shared_scheduling_settings"
    id: Mapped[int] = mapped_column(primary_key=True)
    time_slice_replicas: Mapped[int] = mapped_column(Integer, default=4)
    job_timeout_minutes: Mapped[int] = mapped_column(Integer, default=60)
