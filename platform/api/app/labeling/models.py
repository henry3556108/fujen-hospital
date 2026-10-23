"""標註與自動標註執行紀錄。標註內容存 JSON；像素資料仍只在 Orthanc。

外鍵到 projects 一律 ON DELETE CASCADE：刪除專案（含 seed 重建）時一併清掉。
標註以 UID 指向研究／序列／影像，不用外鍵：重新匯入影像（索引列重建）不會讓標註消失，
是否可存取每次都以影像索引與 Accession 清單重新判斷。
"""
from datetime import datetime

from sqlalchemy import JSON, DateTime, ForeignKey, Index, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models import Base, utcnow


class Annotation(Base):
    __tablename__ = "label_annotations"
    __table_args__ = (Index("ix_label_annotations_study", "project_id", "study_instance_uid"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    study_instance_uid: Mapped[str] = mapped_column(String(64))
    series_instance_uid: Mapped[str | None] = mapped_column(String(64), default=None)
    sop_instance_uid: Mapped[str | None] = mapped_column(String(64), default=None)
    kind: Mapped[str] = mapped_column(String(16))             # classification | segmentation | detection
    payload: Mapped[dict] = mapped_column(JSON)
    source: Mapped[str] = mapped_column(String(16), default="manual")   # manual | csv | autolabel
    rating: Mapped[int | None] = mapped_column(default=None)  # 1–5
    version: Mapped[int] = mapped_column(default=1)
    autolabel_run_id: Mapped[int | None] = mapped_column(default=None)
    created_by: Mapped[str] = mapped_column(String(64))
    updated_by: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    # 標註狀態：自動標註先是 draft（待確認），人工與診斷表匯入直接 confirmed。舊資料（補欄位前）一律 confirmed
    status: Mapped[str] = mapped_column(String(16), default="confirmed", server_default="confirmed")
    confirmed_by: Mapped[str | None] = mapped_column(String(64), default=None)
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)


class LabelDataset(Base):
    """標註資料集：名稱＋任務＋資料範圍＋類別，本身是「篩選標註的條件」，內容隨標註增加。"""
    __tablename__ = "label_datasets"
    __table_args__ = (UniqueConstraint("project_id", "name"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(128))
    task: Mapped[str] = mapped_column(String(16))              # classification | detection | segmentation
    scope_id: Mapped[int | None] = mapped_column(default=None)  # imaging_scopes.id；不選＝全部可存取的研究
    classes: Mapped[list] = mapped_column(JSON, default=list)   # 空清單＝所有類別
    auto: Mapped[bool] = mapped_column(default=False)           # 系統自動建立的預設資料集
    created_by: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class LabelDatasetVersion(Base):
    """資料集某一刻的快照：納入的標註 id 與各自的版本號。建立後不再改。"""
    __tablename__ = "label_dataset_versions"
    __table_args__ = (UniqueConstraint("dataset_id", "version"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    dataset_id: Mapped[int] = mapped_column(ForeignKey("label_datasets.id", ondelete="CASCADE"), index=True)
    version: Mapped[int] = mapped_column()
    items: Mapped[list] = mapped_column(JSON, default=list)      # [[annotation_id, annotation_version], ...] 依 id 排序
    content_hash: Mapped[str] = mapped_column(String(64))
    annotations: Mapped[int] = mapped_column(default=0)
    by_class: Mapped[dict] = mapped_column(JSON, default=dict)
    created_by: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class AutolabelRun(Base):
    """成功回存的自動標註。失敗的送出不留紀錄（只有稽核），避免留下半筆結果。"""
    __tablename__ = "label_autolabel_runs"
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    model: Mapped[str] = mapped_column(String(128))
    model_type: Mapped[str] = mapped_column(String(16))       # segmentation | detection
    study_instance_uid: Mapped[str] = mapped_column(String(64))
    sop_instance_uid: Mapped[str] = mapped_column(String(64))
    annotation_id: Mapped[int] = mapped_column(index=True)
    duration_ms: Mapped[int] = mapped_column(default=0)
    created_by: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
