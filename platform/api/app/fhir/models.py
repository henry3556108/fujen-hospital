from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models import Base, utcnow

_PROJECT = dict(ondelete="CASCADE")


class FhirSource(Base):
    """資料來源。sql：config={dsn, query}；csv、json、hl7v2：內容存在 content。"""
    __tablename__ = "fhir_sources"
    __table_args__ = (UniqueConstraint("project_id", "name"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", **_PROJECT), index=True)
    name: Mapped[str] = mapped_column(String(128))
    kind: Mapped[str] = mapped_column(String(16))
    config: Mapped[dict] = mapped_column(JSON, default=dict)
    content: Mapped[str | None] = mapped_column(Text, default=None)
    created_by: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class FhirMapping(Base):
    """對應規則組（格式見 app/fhir/mapping.py）。"""
    __tablename__ = "fhir_mappings"
    __table_args__ = (UniqueConstraint("project_id", "name"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", **_PROJECT), index=True)
    name: Mapped[str] = mapped_column(String(128))
    source_kind: Mapped[str] = mapped_column(String(16))
    rules: Mapped[dict] = mapped_column(JSON)
    created_by: Mapped[str] = mapped_column(String(64))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class FhirSchedule(Base):
    __tablename__ = "fhir_schedules"
    __table_args__ = (UniqueConstraint("project_id", "name"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", **_PROJECT), index=True)
    name: Mapped[str] = mapped_column(String(128))
    source_id: Mapped[int] = mapped_column(ForeignKey("fhir_sources.id", ondelete="CASCADE"))
    mapping_id: Mapped[int] = mapped_column(ForeignKey("fhir_mappings.id", ondelete="CASCADE"))
    interval_minutes: Mapped[int] = mapped_column(Integer)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    next_run_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    created_by: Mapped[str] = mapped_column(String(64))


class FhirRun(Base):
    """一次資料交換：ETL 執行、HL7 V2 單則接收、監視器資料接收。status：succeeded｜rejected｜failed。
    rejected＝資料不合格（沒有送到 FHIR 伺服器）；failed＝FHIR 伺服器拒絕或中斷（整批未寫入）。"""
    __tablename__ = "fhir_runs"
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", **_PROJECT), index=True)
    trigger: Mapped[str] = mapped_column(String(16))   # manual | schedule | hl7v2 | vitals
    source_id: Mapped[int | None] = mapped_column(ForeignKey("fhir_sources.id", ondelete="SET NULL"), default=None)
    mapping_id: Mapped[int | None] = mapped_column(ForeignKey("fhir_mappings.id", ondelete="SET NULL"),
                                                   default=None)
    schedule_id: Mapped[int | None] = mapped_column(ForeignKey("fhir_schedules.id", ondelete="SET NULL"),
                                                    default=None, index=True)
    actor: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(16))
    records_read: Mapped[int] = mapped_column(Integer, default=0)
    resources_written: Mapped[dict] = mapped_column(JSON, default=dict)   # {"Patient": 20}
    errors: Mapped[list] = mapped_column(JSON, default=list)
    planned_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)


class FhirTrafficAlert(Base):
    """流量異常告警：同一使用者在同一專案、同一分鐘只會有一筆。"""
    __tablename__ = "fhir_traffic_alerts"
    __table_args__ = (UniqueConstraint("project_id", "actor", "window_start"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", **_PROJECT), index=True)
    actor: Mapped[str] = mapped_column(String(64))
    window_start: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    request_count: Mapped[int] = mapped_column(Integer)
    threshold: Mapped[int] = mapped_column(Integer)
    notified: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class GatewayRoutePolicy(Base):
    """受管的 Gateway 路由政策，由 forward-auth 每次請求即時套用。"""
    __tablename__ = "gateway_route_policies"
    id: Mapped[int] = mapped_column(primary_key=True)
    route_id: Mapped[str] = mapped_column(String(64), unique=True)
    description: Mapped[str] = mapped_column(String(256), default="")
    uri: Mapped[str] = mapped_column(String(256))
    upstream: Mapped[str] = mapped_column(String(128))
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    methods: Mapped[list] = mapped_column(JSON)
    alert_threshold_per_minute: Mapped[int] = mapped_column(Integer, default=120)
    updated_by: Mapped[str | None] = mapped_column(String(64), default=None)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
