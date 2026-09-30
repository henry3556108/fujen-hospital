"""刪除專案時，LLM 相關資料列一併刪除（含沒有外鍵的向量片段），模型下載的核准紀錄保留但解除專案關聯。

整合環境（PostgreSQL）曾因 llm_call_records 等表沒有刪除規則，種子重設與刪除專案都失敗。
SQLite 預設不檢查外鍵，這裡開啟 foreign_keys；PostgreSQL 版以 TEST_POSTGRES_URL 執行。
"""
import itertools
import os
from datetime import datetime, timezone

import pytest
from sqlalchemy import JSON, Boolean, DateTime, Float, Integer, event, func, insert, select, update

from app import admin_service
from app.db import make_engine, make_sessionmaker
from app.llm import models as llm_models
from app.models import Base, Project

PG_URL = os.environ.get("TEST_POSTGRES_URL")
# llm_kb_chunks 只以數字參照知識庫（沒有外鍵），排序時放到最後
LLM_TABLES = sorted((t for t in Base.metadata.sorted_tables if t.name.startswith("llm_")),
                    key=lambda t: t.name == "llm_kb_chunks")
_seq = itertools.count(1)


def _engine(kind):
    if kind == "postgresql":
        return make_engine(PG_URL)
    engine = make_engine("sqlite://")

    @event.listens_for(engine, "connect")
    def _fk(dbapi, _):
        dbapi.execute("PRAGMA foreign_keys=ON")

    return engine


@pytest.fixture(params=["sqlite", pytest.param("postgresql", marks=pytest.mark.skipif(
    not PG_URL, reason="需要 TEST_POSTGRES_URL（PostgreSQL）"))])
def sessions(request):
    engine = _engine(request.param)
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    yield make_sessionmaker(engine)
    Base.metadata.drop_all(engine)
    engine.dispose()


def _value(column, ids: dict[str, int]):
    """必填欄位給一個合法的假值；外鍵指向剛建立的上層列，kb_id／document_id 等整數參照也接到同一組資料。"""
    for fk in column.foreign_keys:
        return ids[fk.column.table.name]
    if column.name in ("kb_id",):
        return ids["llm_knowledge_bases"]
    if column.name in ("document_id",):
        return ids["llm_kb_documents"]
    kind = column.type
    if isinstance(kind, Boolean):
        return False
    if isinstance(kind, DateTime):
        return datetime.now(timezone.utc)
    if isinstance(kind, JSON):
        return {}
    if isinstance(kind, Float):
        return 0.0
    if isinstance(kind, Integer):
        return next(_seq)   # 唯一鍵（例如 wiki_id）不能重複
    return f"v{next(_seq)}"


def fill(s, name: str) -> int:
    """一個專案，每張 LLM 表各一列（依外鍵順序建立）。"""
    project = Project(name=name)
    s.add(project)
    s.flush()
    ids = {"projects": project.id}
    for table in LLM_TABLES:
        row = {c.name: _value(c, ids) for c in table.columns if not c.primary_key and (
            c.foreign_keys or (not c.nullable and c.default is None and c.server_default is None))}
        ids[table.name] = s.execute(insert(table).values(**row).returning(table.c.id)).scalar_one()
    s.commit()
    return project.id


def owned(s, project_id: int) -> dict[str, int]:
    """每張表屬於該專案的列數：有 project_id 的直接算，其餘沿上層關聯算。"""
    kbs = select(llm_models.KnowledgeBase.id).where(llm_models.KnowledgeBase.project_id == project_id)
    sessions_ = select(llm_models.ChatSession.id).where(llm_models.ChatSession.project_id == project_id)
    runs = select(llm_models.WorkflowRun.id).where(llm_models.WorkflowRun.project_id == project_id)
    out = {}
    for table in LLM_TABLES:
        c = table.c
        if "project_id" in c:
            where = c.project_id == project_id
        elif "kb_id" in c:
            where = c.kb_id.in_(kbs)
        elif "session_id" in c:
            where = c.session_id.in_(sessions_)
        elif "run_id" in c:
            where = c.run_id.in_(runs)
        else:
            continue
        out[table.name] = s.scalar(select(func.count()).select_from(table).where(where))
    return out


def test_deleting_a_project_removes_its_llm_rows_and_keeps_download_records(sessions):
    with sessions() as s:
        doomed, kept = fill(s, "p1"), fill(s, "p2")
        before_doomed, before_kept = owned(s, doomed), owned(s, kept)
        assert before_doomed["llm_call_records"] == 1 and before_doomed["llm_kb_chunks"] == 1
        downloads = s.scalar(select(func.count()).select_from(llm_models.ModelDownload))
        admin_service.delete_project(s, actor="admin01", project_id=doomed)
    with sessions() as s:
        after = owned(s, doomed)
        assert {k: v for k, v in after.items() if k != "llm_model_downloads"} == dict.fromkeys(
            [k for k in after if k != "llm_model_downloads"], 0)
        # 核准下載紀錄（TC-D01-03 的稽核依據）留下，只是不再指向已刪除的專案
        assert s.scalar(select(func.count()).select_from(llm_models.ModelDownload)) == downloads
        assert after["llm_model_downloads"] == 0
        assert owned(s, kept) == before_kept, "其他專案不受影響"
