"""訓練、模型、部署、推論的資料表。檔案本體都在物件儲存，這裡只存中繼資料。

外鍵到 projects 一律 ON DELETE CASCADE，與影像、結構式資料一致。
"""
from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models import Base, utcnow

_PROJECT = dict(ondelete="CASCADE")


class TrainingSetting(Base):
    """使用者存下來的訓練設定（正規化後的 JSON）。送出訓練時會複製一份到 TrainingRun。"""
    __tablename__ = "training_settings"
    __table_args__ = (UniqueConstraint("project_id", "name"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", **_PROJECT), index=True)
    name: Mapped[str] = mapped_column(String(128))
    kind: Mapped[str] = mapped_column(String(32))
    config: Mapped[dict] = mapped_column(JSON)
    created_by: Mapped[str] = mapped_column(String(64))
    updated_by: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class DatasetVersion(Base):
    """凍結的資料版本。content_hash 由內容算出：內容相同就是同一個版本。"""
    __tablename__ = "training_dataset_versions"
    __table_args__ = (UniqueConstraint("project_id", "content_hash"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", **_PROJECT), index=True)
    kind: Mapped[str] = mapped_column(String(32))
    content_hash: Mapped[str] = mapped_column(String(64))
    manifest_key: Mapped[str] = mapped_column(String(512))
    item_count: Mapped[int] = mapped_column(Integer)
    source: Mapped[dict] = mapped_column(JSON)
    summary: Mapped[dict] = mapped_column(JSON, default=dict)
    created_by: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class TrainingRun(Base):
    __tablename__ = "training_runs"
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", **_PROJECT), index=True)
    setting_id: Mapped[int | None] = mapped_column(ForeignKey("training_settings.id", ondelete="SET NULL"),
                                                   default=None)
    dataset_version_id: Mapped[int] = mapped_column(ForeignKey("training_dataset_versions.id", ondelete="CASCADE"))
    job_id: Mapped[int | None] = mapped_column(ForeignKey("jobs.id", ondelete="SET NULL"), default=None)
    parent_run_id: Mapped[int | None] = mapped_column(Integer, default=None)   # 重現或改原始碼再跑的來源
    name: Mapped[str] = mapped_column(String(128), default="")
    kind: Mapped[str] = mapped_column(String(32))
    executor: Mapped[str] = mapped_column(String(16))          # template | fake | source
    config: Mapped[dict] = mapped_column(JSON)                 # 交給 Job 的 config.json，送出後不再改
    seed: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(16), default="queued", index=True)
    message: Mapped[str] = mapped_column(String(1024), default="")
    reported: Mapped[str | None] = mapped_column(String(16), default=None)   # Job 自己回報的結果
    io_token_hash: Mapped[str] = mapped_column(String(64), default="")
    io_closed: Mapped[bool] = mapped_column(Boolean, default=False)
    source_key: Mapped[str | None] = mapped_column(String(512), default=None)  # 使用者修改後的原始碼 zip
    artifacts: Mapped[dict] = mapped_column(JSON, default=dict)
    metrics: Mapped[dict] = mapped_column(JSON, default=dict)
    tracking_run_id: Mapped[str | None] = mapped_column(String(64), default=None)
    created_by: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    # 用到的標註資料集與版本號（label_datasets.id 不設外鍵：資料集刪除後紀錄仍保留版本號）；
    # 測試集筆數在訓練成功時由 splits.json 算出。三欄由 db_init 補到既有資料庫
    label_dataset_id: Mapped[int | None] = mapped_column(Integer, default=None)
    label_dataset_version: Mapped[int | None] = mapped_column(Integer, default=None)
    test_count: Mapped[int | None] = mapped_column(Integer, default=None)
    # 送出時由匯入檔控制的環節（只讀的關聯，不是欄位）
    imported: Mapped["RunStages | None"] = relationship(uselist=False, viewonly=True, lazy="selectin")


class TrainedModel(Base):
    __tablename__ = "trained_models"
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", **_PROJECT), index=True)
    run_id: Mapped[int] = mapped_column(ForeignKey("training_runs.id", ondelete="CASCADE"), unique=True)
    name: Mapped[str] = mapped_column(String(128))
    kind: Mapped[str] = mapped_column(String(32))
    format: Mapped[str] = mapped_column(String(8))             # h5 | pkl
    object_key: Mapped[str] = mapped_column(String(512))
    sha256: Mapped[str] = mapped_column(String(64))
    size: Mapped[int] = mapped_column(Integer)
    card: Mapped[dict] = mapped_column(JSON, default=dict)
    created_by: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Deployment(Base):
    """線上即時推論服務。name 全平台唯一（出現在網址上）；allowed_users 是可呼叫的帳號清單。"""
    __tablename__ = "model_deployments"
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", **_PROJECT), index=True)
    model_id: Mapped[int] = mapped_column(ForeignKey("trained_models.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(63), unique=True)
    allowed_users: Mapped[list] = mapped_column(JSON, default=list)
    created_by: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class DeploymentTitle(Base):
    """部署的顯示名稱（可用中文，例如「心臟科確診預測」）。另開資料表而不在 model_deployments 加欄位，
    因為平台以 create_all 建表、沒有遷移工具，既有資料庫加欄位不會生效。"""
    __tablename__ = "deployment_titles"
    id: Mapped[int] = mapped_column(primary_key=True)
    deployment_id: Mapped[int] = mapped_column(ForeignKey("model_deployments.id", ondelete="CASCADE"), unique=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", **_PROJECT), index=True)
    title: Mapped[str] = mapped_column(String(128))


class InferenceRecord(Base):
    __tablename__ = "inference_records"
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", **_PROJECT), index=True)
    model_id: Mapped[int] = mapped_column(ForeignKey("trained_models.id", ondelete="CASCADE"), index=True)
    deployment_id: Mapped[int | None] = mapped_column(ForeignKey("model_deployments.id", ondelete="SET NULL"),
                                                      default=None)
    mode: Mapped[str] = mapped_column(String(16))              # batch | upload | online
    # 上傳與線上：succeeded | failed；批次另有 queued | running | cancelled（與排程工作相同）
    status: Mapped[str] = mapped_column(String(16))
    user: Mapped[str] = mapped_column(String(64))
    count: Mapped[int] = mapped_column(Integer, default=0)
    input: Mapped[dict] = mapped_column(JSON, default=dict)
    result_key: Mapped[str] = mapped_column(String(512), default="")
    result_format: Mapped[str] = mapped_column(String(8), default="")   # csv | json
    message: Mapped[str] = mapped_column(String(1024), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    # 批次推論的排程資訊（只讀的關聯，不是欄位；刪除由資料庫 ON DELETE CASCADE 處理）
    batch: Mapped["InferenceBatch | None"] = relationship(uselist=False, viewonly=True, lazy="selectin")


class InferenceBatch(Base):
    """批次推論的背景工作：與推論紀錄一對一。另開資料表而不在 inference_records 加欄位，
    因為平台以 create_all 建表、沒有遷移工具，既有資料庫加欄位不會生效。"""
    __tablename__ = "inference_batches"
    id: Mapped[int] = mapped_column(primary_key=True)
    record_id: Mapped[int] = mapped_column(ForeignKey("inference_records.id", ondelete="CASCADE"), unique=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", **_PROJECT), index=True)
    job_id: Mapped[int | None] = mapped_column(ForeignKey("jobs.id", ondelete="SET NULL"), default=None)
    io_token_hash: Mapped[str] = mapped_column(String(64), default="")
    io_closed: Mapped[bool] = mapped_column(Boolean, default=False)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)


class StageOverride(Base):
    """匯入控制的環節：這個環節的設定與程式由使用者匯入（或在網頁編輯後套用）的檔案決定，介面不能點擊修改。
    zip 本體在物件儲存（files_key）；config_before 是第一次匯入前該環節的設定，改回介面設定時還原。
    另開資料表而不在 training_settings 加欄位，因為平台以 create_all 建表、沒有遷移工具。"""
    __tablename__ = "training_stage_overrides"
    __table_args__ = (UniqueConstraint("setting_id", "stage"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", **_PROJECT), index=True)
    setting_id: Mapped[int] = mapped_column(ForeignKey("training_settings.id", ondelete="CASCADE"), index=True)
    stage: Mapped[str] = mapped_column(String(16))             # import | labels | preprocess | train
    files_key: Mapped[str] = mapped_column(String(512))
    sha256: Mapped[str] = mapped_column(String(64))
    files: Mapped[dict] = mapped_column(JSON, default=dict)     # 檔名 → sha256
    code_changed: Mapped[bool] = mapped_column(Boolean, default=False)
    config_before: Mapped[dict] = mapped_column(JSON, default=dict)
    imported_by: Mapped[str] = mapped_column(String(64))
    imported_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class DeploymentStageOverride(Base):
    """匯入控制的部署（deploy 環節）：可呼叫的帳號由匯入的 deploy.json 決定。欄位與 training_stage_overrides 相同。"""
    __tablename__ = "deployment_stage_overrides"
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", **_PROJECT), index=True)
    deployment_id: Mapped[int] = mapped_column(ForeignKey("model_deployments.id", ondelete="CASCADE"), unique=True)
    files_key: Mapped[str] = mapped_column(String(512))
    sha256: Mapped[str] = mapped_column(String(64))
    files: Mapped[dict] = mapped_column(JSON, default=dict)
    config_before: Mapped[dict] = mapped_column(JSON, default=dict)
    imported_by: Mapped[str] = mapped_column(String(64))
    imported_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class RunStages(Base):
    """訓練送出時，由匯入檔控制的環節（環節 → 匯入檔 sha256、程式是否改過）。訓練紀錄顯示「使用匯入的程式」。"""
    __tablename__ = "training_run_stages"
    id: Mapped[int] = mapped_column(primary_key=True)
    run_id: Mapped[int] = mapped_column(ForeignKey("training_runs.id", ondelete="CASCADE"), unique=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", **_PROJECT), index=True)
    stages: Mapped[dict] = mapped_column(JSON, default=dict)
