"""WP7 資料表。全部以 llm_ 開頭，專案範圍的資料都帶 project_id。"""
from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models import Base, utcnow

# ---------------------------------------------------------------- 模型白名單、下載、載入


class ModelWhitelist(Base):
    """預載可下載清單＝白名單。不在這張表的模型不可下載、不可部署。"""
    __tablename__ = "llm_model_whitelist"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(128), unique=True)
    source: Mapped[str] = mapped_column(String(128))          # 來源主機，例：huggingface.co
    repo: Mapped[str] = mapped_column(String(256))
    revision: Mapped[str] = mapped_column(String(64))         # 核准的 commit
    sha256: Mapped[str] = mapped_column(String(64))           # 核准內容的 hash
    license: Mapped[str] = mapped_column(String(64), default="")
    requires_token: Mapped[bool] = mapped_column(Boolean, default=False)
    has_remote_code: Mapped[bool] = mapped_column(Boolean, default=False)
    note: Mapped[str] = mapped_column(String(512), default="")
    reviewed_by: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ModelDownload(Base):
    """下載申請與紀錄。Token 本身不存，只存指紋與使用紀錄。"""
    __tablename__ = "llm_model_downloads"
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int | None] = mapped_column(ForeignKey("projects.id"), default=None)
    name: Mapped[str] = mapped_column(String(128), index=True)
    source: Mapped[str] = mapped_column(String(128))
    repo: Mapped[str] = mapped_column(String(256))
    status: Mapped[str] = mapped_column(String(16), index=True)   # pending/approved/rejected/completed/failed
    requested_by: Mapped[str] = mapped_column(String(64))
    requested_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    reviewer: Mapped[str | None] = mapped_column(String(64), default=None)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    commit: Mapped[str | None] = mapped_column(String(64), default=None)
    sha256: Mapped[str | None] = mapped_column(String(64), default=None)
    mode: Mapped[str | None] = mapped_column(String(16), default=None)   # online | offline
    token_usage: Mapped[dict | None] = mapped_column(JSON, default=None)
    downloaded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    message: Mapped[str] = mapped_column(String(512), default="")


class InstalledModel(Base):
    __tablename__ = "llm_models_installed"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(128), unique=True)
    download_id: Mapped[int] = mapped_column(ForeignKey("llm_model_downloads.id"))
    commit: Mapped[str] = mapped_column(String(64))
    sha256: Mapped[str] = mapped_column(String(64))
    location: Mapped[str] = mapped_column(String(512))
    has_remote_code: Mapped[bool] = mapped_column(Boolean, default=False)
    installed_by: Mapped[str] = mapped_column(String(64))
    installed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    loaded: Mapped[bool] = mapped_column(Boolean, default=False)


class RemoteCodeApproval(Base):
    """核准執行模型 Repository 夾帶的程式碼。綁定 commit：白名單換版後要重新核准。"""
    __tablename__ = "llm_remote_code_approvals"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(128), unique=True)
    commit: Mapped[str] = mapped_column(String(64))
    approved_by: Mapped[str] = mapped_column(String(64))
    approved_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ModelLoadConfig(Base):
    __tablename__ = "llm_model_load_configs"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(128), unique=True)
    quantization: Mapped[str] = mapped_column(String(8), default="none")   # none | 4bit | 8bit
    cpu: Mapped[int] = mapped_column(Integer, default=4)
    memory_gb: Mapped[int] = mapped_column(Integer, default=16)
    gpu_type: Mapped[str] = mapped_column(String(64), default="gpu-exclusive")
    gpu_count: Mapped[int] = mapped_column(Integer, default=1)
    updated_by: Mapped[str] = mapped_column(String(64))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


# ---------------------------------------------------------------- Prompt 範本、生成參數


class PromptTemplate(Base):
    __tablename__ = "llm_prompt_templates"
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), index=True)
    owner: Mapped[str] = mapped_column(String(64), index=True)
    visibility: Mapped[str] = mapped_column(String(16))      # personal | public
    title: Mapped[str] = mapped_column(String(128))
    content: Mapped[str] = mapped_column(Text)
    tags: Mapped[list[str]] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class GenerationSettings(Base):
    """每人每專案一份生成參數。"""
    __tablename__ = "llm_generation_settings"
    __table_args__ = (UniqueConstraint("project_id", "username"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"))
    username: Mapped[str] = mapped_column(String(64))
    params: Mapped[dict] = mapped_column(JSON)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


# ---------------------------------------------------------------- 知識庫


class KnowledgeBase(Base):
    __tablename__ = "llm_knowledge_bases"
    __table_args__ = (UniqueConstraint("project_id", "name"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), index=True)
    name: Mapped[str] = mapped_column(String(128))
    description: Mapped[str] = mapped_column(String(512), default="")
    embed_model: Mapped[str] = mapped_column(String(128))
    chunk_size: Mapped[int] = mapped_column(Integer, default=500)
    chunk_overlap: Mapped[int] = mapped_column(Integer, default=50)
    created_by: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class KbDocument(Base):
    __tablename__ = "llm_kb_documents"
    id: Mapped[int] = mapped_column(primary_key=True)
    kb_id: Mapped[int] = mapped_column(ForeignKey("llm_knowledge_bases.id"), index=True)
    filename: Mapped[str] = mapped_column(String(256))
    format: Mapped[str] = mapped_column(String(8))
    sha256: Mapped[str] = mapped_column(String(64))
    size: Mapped[int] = mapped_column(Integer)
    chunks: Mapped[int] = mapped_column(Integer, default=0)
    characters: Mapped[int] = mapped_column(Integer, default=0)
    uploaded_by: Mapped[str] = mapped_column(String(64))
    uploaded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class KbChunk(Base):
    """SqlVectorStore 的儲存表：向量以 JSON 存放，不需要資料庫外掛。"""
    __tablename__ = "llm_kb_chunks"
    id: Mapped[int] = mapped_column(primary_key=True)
    kb_id: Mapped[int] = mapped_column(Integer, index=True)
    document_id: Mapped[int] = mapped_column(Integer, index=True)
    chunk_index: Mapped[int] = mapped_column(Integer)
    content: Mapped[str] = mapped_column(Text)
    embedding: Mapped[list[float]] = mapped_column(JSON)


# ---------------------------------------------------------------- 對話與呼叫紀錄


class ChatSession(Base):
    __tablename__ = "llm_chat_sessions"
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), index=True)
    username: Mapped[str] = mapped_column(String(64), index=True)
    mode: Mapped[str] = mapped_column(String(8))              # free | kb
    kb_id: Mapped[int | None] = mapped_column(Integer, default=None)
    model: Mapped[str] = mapped_column(String(128))
    title: Mapped[str] = mapped_column(String(128), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ChatMessage(Base):
    __tablename__ = "llm_chat_messages"
    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("llm_chat_sessions.id"), index=True)
    role: Mapped[str] = mapped_column(String(16))
    content: Mapped[str] = mapped_column(Text)
    call_id: Mapped[int | None] = mapped_column(Integer, default=None)
    sources: Mapped[list] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class LlmCallRecord(Base):
    """每一次送給模型服務的呼叫。context_source 說明脈絡怎麼來的：none｜vector｜wiki_api。"""
    __tablename__ = "llm_call_records"
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), index=True)
    username: Mapped[str] = mapped_column(String(64))
    origin: Mapped[str] = mapped_column(String(16), index=True)   # playground | service | workflow | wiki
    origin_ref: Mapped[str] = mapped_column(String(128), default="")
    model: Mapped[str] = mapped_column(String(128))
    context_source: Mapped[str] = mapped_column(String(16), default="none")
    context_refs: Mapped[list] = mapped_column(JSON, default=list)
    request: Mapped[dict] = mapped_column(JSON)
    response: Mapped[dict | None] = mapped_column(JSON, default=None)
    status: Mapped[str] = mapped_column(String(16))               # success | timeout | unavailable | error
    error: Mapped[str] = mapped_column(String(512), default="")
    latency_ms: Mapped[float] = mapped_column(Float, default=0.0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


# ---------------------------------------------------------------- 發布為內部服務


class PublishedService(Base):
    __tablename__ = "llm_published_services"
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), index=True)
    slug: Mapped[str] = mapped_column(String(64), unique=True)
    name: Mapped[str] = mapped_column(String(128))
    description: Mapped[str] = mapped_column(String(512), default="")
    model: Mapped[str] = mapped_column(String(128))
    kb_id: Mapped[int | None] = mapped_column(Integer, default=None)
    top_k: Mapped[int] = mapped_column(Integer, default=3)
    params: Mapped[dict] = mapped_column(JSON)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    grants: Mapped[list[str]] = mapped_column(JSON, default=list)   # 可呼叫的帳號
    published_by: Mapped[str] = mapped_column(String(64))
    published_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


# ---------------------------------------------------------------- 工作流


class Workflow(Base):
    __tablename__ = "llm_workflows"
    __table_args__ = (UniqueConstraint("project_id", "name"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), index=True)
    name: Mapped[str] = mapped_column(String(128))
    description: Mapped[str] = mapped_column(String(512), default="")
    definition: Mapped[dict] = mapped_column(JSON)
    created_by: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class WorkflowRun(Base):
    __tablename__ = "llm_workflow_runs"
    id: Mapped[int] = mapped_column(primary_key=True)
    workflow_id: Mapped[int] = mapped_column(ForeignKey("llm_workflows.id"), index=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), index=True)
    username: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(16))               # succeeded | failed
    definition: Mapped[dict] = mapped_column(JSON)                # 執行當下的定義快照
    input: Mapped[dict] = mapped_column(JSON)
    final_state: Mapped[dict | None] = mapped_column(JSON, default=None)
    error: Mapped[str] = mapped_column(String(512), default="")
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)


class WorkflowNodeRecord(Base):
    __tablename__ = "llm_workflow_node_records"
    id: Mapped[int] = mapped_column(primary_key=True)
    run_id: Mapped[int] = mapped_column(ForeignKey("llm_workflow_runs.id"), index=True)
    seq: Mapped[int] = mapped_column(Integer)
    node: Mapped[str] = mapped_column(String(64))
    type: Mapped[str] = mapped_column(String(16))
    status: Mapped[str] = mapped_column(String(16))
    state_in: Mapped[dict] = mapped_column(JSON)
    state_out: Mapped[dict] = mapped_column(JSON)                 # 這個節點寫回狀態的欄位
    call_id: Mapped[int | None] = mapped_column(Integer, default=None)   # LLM 節點對應的呼叫紀錄
    error: Mapped[str] = mapped_column(String(512), default="")
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)


class WikiPageLink(Base):
    """Wiki 頁面屬於哪個專案。內容與版本存在 Wiki.js，這裡只記歸屬與最後編輯者。"""
    __tablename__ = "llm_wiki_pages"
    __table_args__ = (UniqueConstraint("project_id", "path"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), index=True)
    wiki_id: Mapped[int] = mapped_column(Integer, unique=True)
    path: Mapped[str] = mapped_column(String(256))
    title: Mapped[str] = mapped_column(String(256))
    created_by: Mapped[str] = mapped_column(String(64))
    updated_by: Mapped[str] = mapped_column(String(64))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
