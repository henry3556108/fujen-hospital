from datetime import datetime

from sqlalchemy import JSON, DateTime, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models import Base, utcnow


class TabularDataset(Base):
    """通過驗證的 CSV。object_key 指向乾淨檔（只含合格列）；原始檔另存 original_key。"""

    __tablename__ = "tabular_datasets"
    __table_args__ = (UniqueConstraint("project_id", "name"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    # 刪除專案時由資料庫一併刪除（PostgreSQL）；物件檔需另行清理
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(256))
    original_filename: Mapped[str] = mapped_column(String(256), default="")
    object_key: Mapped[str] = mapped_column(String(512))
    original_key: Mapped[str] = mapped_column(String(512))
    schema: Mapped[dict] = mapped_column(JSON)
    total_rows: Mapped[int] = mapped_column(Integer)
    valid_rows: Mapped[int] = mapped_column(Integer)
    rejected_rows: Mapped[int] = mapped_column(Integer)
    created_by: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class TabularTargetFeature(Base):
    """每個資料集一份 Target／Feature／前處理設定（TargetFeatureConfig.to_dict()），儲存時覆寫。"""

    __tablename__ = "tabular_target_features"
    id: Mapped[int] = mapped_column(primary_key=True)
    dataset_id: Mapped[int] = mapped_column(ForeignKey("tabular_datasets.id", ondelete="CASCADE"), unique=True)
    config: Mapped[dict] = mapped_column(JSON)
    updated_by: Mapped[str] = mapped_column(String(64))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class TabularColumnView(Base):
    """TC-B04-02 預覽的欄位顯示設定：每位使用者、每個資料集一份（個人檢視偏好，換電腦也一致）。
    以帳號名稱為鍵（與 created_by 相同），不設帳號外鍵；刪資料集、刪專案時一併刪除。"""

    __tablename__ = "tabular_column_views"
    __table_args__ = (UniqueConstraint("dataset_id", "username"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    dataset_id: Mapped[int] = mapped_column(ForeignKey("tabular_datasets.id", ondelete="CASCADE"), index=True)
    username: Mapped[str] = mapped_column(String(64))
    hidden: Mapped[list] = mapped_column(JSON)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)
