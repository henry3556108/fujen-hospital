"""向量庫介面與三種實作。

- InMemoryVectorStore：單元測試。
- SqlVectorStore：向量以 JSON 存在一般資料表，相似度在程式內計算；不需要資料庫外掛，資料量小時可用。
- PgVectorStore：PostgreSQL + pgvector，整合環境與正式環境使用。

add／delete 都收呼叫端的 session：片段與文件紀錄在同一個交易裡，一起成功或一起失敗。
"""
import math
import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Protocol

from sqlalchemy import delete, func, select, text
from sqlalchemy.orm import Session

from app.llm.models import KbChunk


@dataclass(frozen=True)
class Hit:
    document_id: int
    chunk_index: int
    content: str
    score: float


class VectorStore(Protocol):
    name: str

    def add(self, session: Session, kb_id: int, document_id: int, chunks: list[str],
            vectors: list[list[float]]) -> None: ...
    def search(self, session: Session, kb_id: int, vector: list[float], k: int) -> list[Hit]: ...
    def delete_document(self, session: Session, kb_id: int, document_id: int) -> None: ...
    def delete_kb(self, session: Session, kb_id: int) -> None: ...
    def count(self, session: Session, kb_id: int) -> int: ...


def cosine(a: list[float], b: list[float]) -> float:
    if len(a) != len(b):
        raise ValueError("向量維度不一致")
    dot = sum(x * y for x, y in zip(a, b))
    norm = math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b))
    return dot / norm if norm else 0.0


def _check(chunks: list[str], vectors: list[list[float]]) -> None:
    if len(chunks) != len(vectors):
        raise ValueError("片段數與向量數不一致")
    if any(not v or any(not math.isfinite(x) for x in v) for v in vectors):
        raise ValueError("向量含有空值或非有限數值")


def _top(rows, vector: list[float], k: int) -> list[Hit]:
    hits = [Hit(doc, index, content, cosine(vector, embedding)) for doc, index, content, embedding in rows]
    hits.sort(key=lambda h: (-h.score, h.document_id, h.chunk_index))
    return hits[:k]


@dataclass
class InMemoryVectorStore:
    name: str = "memory"
    rows: dict[int, list[tuple[int, int, str, list[float]]]] = field(default_factory=dict)
    searches: int = 0

    def add(self, session, kb_id, document_id, chunks, vectors) -> None:
        _check(chunks, vectors)
        self.rows.setdefault(kb_id, []).extend(
            (document_id, i, chunk, list(vector)) for i, (chunk, vector) in enumerate(zip(chunks, vectors)))

    def search(self, session, kb_id, vector, k) -> list[Hit]:
        self.searches += 1
        return _top(self.rows.get(kb_id, []), vector, k)

    def delete_document(self, session, kb_id, document_id) -> None:
        self.rows[kb_id] = [r for r in self.rows.get(kb_id, []) if r[0] != document_id]

    def delete_kb(self, session, kb_id) -> None:
        self.rows.pop(kb_id, None)

    def count(self, session, kb_id) -> int:
        return len(self.rows.get(kb_id, []))


class SqlVectorStore:
    name = "sql"

    def add(self, session, kb_id, document_id, chunks, vectors) -> None:
        _check(chunks, vectors)
        session.add_all(KbChunk(kb_id=kb_id, document_id=document_id, chunk_index=i, content=chunk,
                                embedding=[float(x) for x in vector])
                        for i, (chunk, vector) in enumerate(zip(chunks, vectors)))
        session.flush()

    def search(self, session, kb_id, vector, k) -> list[Hit]:
        rows = session.execute(select(KbChunk.document_id, KbChunk.chunk_index, KbChunk.content, KbChunk.embedding)
                               .where(KbChunk.kb_id == kb_id))
        return _top(rows, vector, k)

    def delete_document(self, session, kb_id, document_id) -> None:
        session.execute(delete(KbChunk).where(KbChunk.kb_id == kb_id, KbChunk.document_id == document_id))

    def delete_kb(self, session, kb_id) -> None:
        session.execute(delete(KbChunk).where(KbChunk.kb_id == kb_id))

    def count(self, session, kb_id) -> int:
        return session.scalar(select(func.count()).select_from(KbChunk).where(KbChunk.kb_id == kb_id)) or 0


def vector_literal(vector: list[float]) -> str:
    return "[" + ",".join(repr(float(x)) for x in vector) + "]"


class PgVectorStore:
    """pgvector。欄位不固定維度（不同知識庫可用不同的 embedding 模型），所以沒有建 ANN 索引；
    資料量大時依實際維度加上 HNSW 索引。"""
    name = "pgvector"
    TABLE = "llm_kb_vectors"

    def __init__(self, sessionmaker):
        with sessionmaker() as session:
            session.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
            session.execute(text(
                f"CREATE TABLE IF NOT EXISTS {self.TABLE} ("
                "id BIGSERIAL PRIMARY KEY, kb_id INTEGER NOT NULL, document_id INTEGER NOT NULL, "
                "chunk_index INTEGER NOT NULL, content TEXT NOT NULL, embedding vector NOT NULL)"))
            session.execute(text(f"CREATE INDEX IF NOT EXISTS {self.TABLE}_kb ON {self.TABLE} (kb_id, document_id)"))
            session.commit()

    def add(self, session, kb_id, document_id, chunks, vectors) -> None:
        _check(chunks, vectors)
        session.execute(
            text(f"INSERT INTO {self.TABLE} (kb_id, document_id, chunk_index, content, embedding) "
                 "VALUES (:kb, :doc, :i, :content, CAST(:embedding AS vector))"),
            [{"kb": kb_id, "doc": document_id, "i": i, "content": chunk, "embedding": vector_literal(vector)}
             for i, (chunk, vector) in enumerate(zip(chunks, vectors))])

    def search(self, session, kb_id, vector, k) -> list[Hit]:
        rows = session.execute(
            text(f"SELECT document_id, chunk_index, content, 1 - (embedding <=> CAST(:q AS vector)) AS score "
                 f"FROM {self.TABLE} WHERE kb_id = :kb AND vector_dims(embedding) = :dims "
                 "ORDER BY embedding <=> CAST(:q AS vector), document_id, chunk_index LIMIT :k"),
            {"q": vector_literal(vector), "kb": kb_id, "k": k, "dims": len(vector)})
        return [Hit(r.document_id, r.chunk_index, r.content, float(r.score)) for r in rows]

    def delete_document(self, session, kb_id, document_id) -> None:
        session.execute(text(f"DELETE FROM {self.TABLE} WHERE kb_id = :kb AND document_id = :doc"),
                        {"kb": kb_id, "doc": document_id})

    def delete_kb(self, session, kb_id) -> None:
        session.execute(text(f"DELETE FROM {self.TABLE} WHERE kb_id = :kb"), {"kb": kb_id})

    def count(self, session, kb_id) -> int:
        return session.scalar(text(f"SELECT count(*) FROM {self.TABLE} WHERE kb_id = :kb"), {"kb": kb_id}) or 0


def store_from_env(sessionmaker, env: Mapping[str, str] = os.environ) -> VectorStore:
    """VECTOR_STORE=pgvector｜sql（預設 sql）。"""
    kind = env.get("VECTOR_STORE", "sql").strip().lower()
    if kind == "pgvector":
        return PgVectorStore(sessionmaker)
    if kind == "sql":
        return SqlVectorStore()
    raise RuntimeError(f"不認得的 VECTOR_STORE：{kind}（可用：pgvector、sql）")
