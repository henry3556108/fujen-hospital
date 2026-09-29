"""PgVectorStore 只能在裝了 pgvector 的 PostgreSQL 上驗證。

執行：docker run -d --rm --name pgv -e POSTGRES_PASSWORD=test -p 127.0.0.1:55433:5432 pgvector/pgvector:pg16
      TEST_PGVECTOR_URL=postgresql+psycopg://postgres:test@127.0.0.1:55433/postgres uv run pytest tests/llm/test_llm_pgvector.py
"""
import os

import pytest
from sqlalchemy import text

from app.db import make_engine, make_sessionmaker
from app.llm.client import hashed_embedding
from app.llm.vectors import PgVectorStore

PG_URL = os.environ.get("TEST_PGVECTOR_URL")
pytestmark = pytest.mark.skipif(not PG_URL, reason="需要 TEST_PGVECTOR_URL（PostgreSQL + pgvector）")


@pytest.fixture
def pg():
    engine = make_engine(PG_URL)
    sessionmaker = make_sessionmaker(engine)
    with sessionmaker() as s:
        s.execute(text(f"DROP TABLE IF EXISTS {PgVectorStore.TABLE}"))
        s.commit()
    store = PgVectorStore(sessionmaker)
    with sessionmaker() as s:
        yield store, s
    engine.dispose()


def test_pgvector_store_contract(pg):
    store, s = pg
    texts = ["門診時間為週一至週五", "磁振造影檢查前取下金屬物品", "乾洗手至少 20 秒"]
    store.add(s, 1, 10, texts[:2], [hashed_embedding(t) for t in texts[:2]])
    store.add(s, 1, 11, texts[2:], [hashed_embedding(texts[2])])
    store.add(s, 2, 12, ["別的知識庫"], [hashed_embedding("門診時間")])
    s.commit()
    assert store.count(s, 1) == 3
    hits = store.search(s, 1, hashed_embedding("門診時間"), 2)
    assert hits[0].content == texts[0] and (hits[0].document_id, hits[0].chunk_index) == (10, 0)
    assert hits[0].score > hits[1].score and all(h.document_id != 12 for h in hits)
    store.delete_document(s, 1, 10)
    assert [h.document_id for h in store.search(s, 1, hashed_embedding("門診時間"), 5)] == [11]
    store.delete_kb(s, 1)
    s.commit()
    assert store.count(s, 1) == 0 and store.count(s, 2) == 1


def test_pgvector_rolls_back_with_the_session_and_ignores_other_dimensions(pg):
    store, s = pg
    store.add(s, 1, 1, ["a"], [[1.0, 0.0]])
    s.rollback()
    assert store.count(s, 1) == 0
    store.add(s, 1, 1, ["兩維"], [[1.0, 0.0]])
    store.add(s, 1, 2, ["三維"], [[1.0, 0.0, 0.0]])
    s.commit()
    assert [h.content for h in store.search(s, 1, [1.0, 0.0], 5)] == ["兩維"]
    # 重複建立（API 重啟）不會出錯
    PgVectorStore(lambda: s.__class__(bind=s.get_bind()))
