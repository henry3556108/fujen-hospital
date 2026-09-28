"""影像索引（專案範圍）。像素資料在 Orthanc，非 DICOM 檔案在物件儲存，這裡只存中繼資料。

外鍵到 projects 一律 ON DELETE CASCADE：刪除專案（含 seed 重建）時一併清掉索引。
"""
from datetime import datetime

from sqlalchemy import JSON, DateTime, ForeignKey, Index, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models import Base, utcnow

_PROJECT_FK = dict(ondelete="CASCADE")


class ImagingStudy(Base):
    __tablename__ = "imaging_studies"
    __table_args__ = (UniqueConstraint("project_id", "study_instance_uid"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", **_PROJECT_FK), index=True)
    study_instance_uid: Mapped[str] = mapped_column(String(64))
    accession_number: Mapped[str] = mapped_column(String(64), default="", index=True)
    patient_id: Mapped[str] = mapped_column(String(64), default="")
    patient_sex: Mapped[str] = mapped_column(String(16), default="")
    study_date: Mapped[str] = mapped_column(String(8), default="")
    study_description: Mapped[str] = mapped_column(String(256), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    series: Mapped[list["ImagingSeries"]] = relationship(back_populates="study", cascade="all, delete-orphan",
                                                         passive_deletes=True, order_by="ImagingSeries.id")


class ImagingSeries(Base):
    __tablename__ = "imaging_series"
    __table_args__ = (UniqueConstraint("study_id", "series_instance_uid"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    study_id: Mapped[int] = mapped_column(ForeignKey("imaging_studies.id", ondelete="CASCADE"), index=True)
    series_instance_uid: Mapped[str] = mapped_column(String(64))
    modality: Mapped[str] = mapped_column(String(16), default="")
    series_description: Mapped[str] = mapped_column(String(256), default="")
    study: Mapped[ImagingStudy] = relationship(back_populates="series")
    instances: Mapped[list["ImagingInstance"]] = relationship(back_populates="series", cascade="all, delete-orphan",
                                                              passive_deletes=True)


class ImagingInstance(Base):
    __tablename__ = "imaging_instances"
    __table_args__ = (UniqueConstraint("project_id", "sop_instance_uid"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", **_PROJECT_FK), index=True)
    series_id: Mapped[int] = mapped_column(ForeignKey("imaging_series.id", ondelete="CASCADE"), index=True)
    sop_instance_uid: Mapped[str] = mapped_column(String(64))
    source_path: Mapped[str] = mapped_column(String(512), default="")
    orthanc_id: Mapped[str] = mapped_column(String(64), default="")
    series: Mapped[ImagingSeries] = relationship(back_populates="instances")


class AccessionAllowlist(Base):
    __tablename__ = "imaging_accession_allowlist"
    __table_args__ = (UniqueConstraint("project_id", "accession_number"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", **_PROJECT_FK), index=True)
    accession_number: Mapped[str] = mapped_column(String(64))


class ImportJob(Base):
    __tablename__ = "imaging_import_jobs"
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", **_PROJECT_FK), index=True)
    kind: Mapped[str] = mapped_column(String(16))            # dicom | files | pacs
    status: Mapped[str] = mapped_column(String(16))          # succeeded | partial | failed
    created_by: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    counts: Mapped[dict] = mapped_column(JSON, default=dict)
    files: Mapped[list["ImportFileResult"]] = relationship(cascade="all, delete-orphan", passive_deletes=True,
                                                           order_by="ImportFileResult.id")


class ImportFileResult(Base):
    __tablename__ = "imaging_import_files"
    id: Mapped[int] = mapped_column(primary_key=True)
    job_id: Mapped[int] = mapped_column(ForeignKey("imaging_import_jobs.id", ondelete="CASCADE"), index=True)
    filename: Mapped[str] = mapped_column(String(512))
    status: Mapped[str] = mapped_column(String(16))          # imported | duplicate | failed
    reason: Mapped[str] = mapped_column(String(512), default="")


class ImagingFile(Base):
    """NIfTI／ITK 影像與標註、makesense 標註。檔案本體在物件儲存 object_key。"""
    __tablename__ = "imaging_files"
    __table_args__ = (UniqueConstraint("project_id", "filename"),
                      Index("ix_imaging_files_pairing", "project_id", "format", "case"))
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", **_PROJECT_FK), index=True)
    filename: Mapped[str] = mapped_column(String(512))
    format: Mapped[str] = mapped_column(String(16))          # nifti | itk | makesense
    role: Mapped[str] = mapped_column(String(16))            # image | label
    case: Mapped[str | None] = mapped_column(String(256), default=None)
    sha256: Mapped[str] = mapped_column(String(64))
    object_key: Mapped[str] = mapped_column(String(512), default="")
    meta: Mapped[dict] = mapped_column(JSON, default=dict)
    # 配對：NIfTI／ITK 標註 → 同專案同格式同 case 的影像；makesense → 同專案 DICOM 的 SOP Instance UID
    paired_file_id: Mapped[int | None] = mapped_column(ForeignKey("imaging_files.id", ondelete="SET NULL"),
                                                       default=None)
    paired_sops: Mapped[list] = mapped_column(JSON, default=list)
    pairing: Mapped[str] = mapped_column(String(16), default="unpaired")   # paired | unpaired | n/a
    pairing_note: Mapped[str] = mapped_column(String(512), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
