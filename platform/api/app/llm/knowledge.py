"""知識庫：建立、上傳文件（解析 → 切片 → 向量化 → 寫入向量庫）、檢索。"""
import hashlib

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit import AuditCategory, record
from app.llm.calls import require_client
from app.llm.client import LlmError
from app.llm.documents import DocumentError, chunk_text, extract_text
from app.llm.errors import Conflict, Invalid, NotFound
from app.llm.models import KbDocument, KnowledgeBase, PublishedService
from app.llm.services import LlmServices
from app.llm.util import iso

EMBED_BATCH = 32
MAX_FILES_PER_UPLOAD = 50


def kb_out(kb: KnowledgeBase, documents: int = 0, chunks: int = 0) -> dict:
    return {"id": kb.id, "project_id": kb.project_id, "name": kb.name, "description": kb.description,
            "embed_model": kb.embed_model, "chunk_size": kb.chunk_size, "chunk_overlap": kb.chunk_overlap,
            "created_by": kb.created_by, "created_at": iso(kb.created_at), "documents": documents,
            "chunks": chunks}


def document_out(d: KbDocument) -> dict:
    return {"id": d.id, "kb_id": d.kb_id, "filename": d.filename, "format": d.format, "sha256": d.sha256,
            "size": d.size, "chunks": d.chunks, "characters": d.characters, "uploaded_by": d.uploaded_by,
            "uploaded_at": iso(d.uploaded_at)}


def get_kb(session: Session, *, project_id: int, kb_id: int) -> KnowledgeBase:
    kb = session.get(KnowledgeBase, kb_id)
    # 別的專案的知識庫與不存在的知識庫回一樣的訊息
    if kb is None or kb.project_id != project_id:
        raise NotFound(f"找不到知識庫 {kb_id}")
    return kb


def documents_of(session: Session, kb_id: int) -> list[KbDocument]:
    return list(session.scalars(select(KbDocument).where(KbDocument.kb_id == kb_id).order_by(KbDocument.id)))


def describe(session: Session, kb: KnowledgeBase) -> dict:
    docs = documents_of(session, kb.id)
    return kb_out(kb, documents=len(docs), chunks=sum(d.chunks for d in docs))


def list_kbs(session: Session, *, project_id: int) -> list[dict]:
    rows = session.scalars(select(KnowledgeBase).where(KnowledgeBase.project_id == project_id)
                           .order_by(KnowledgeBase.id))
    return [describe(session, kb) for kb in rows]


def create_kb(session: Session, services: LlmServices, *, project_id: int, actor: str, source_ip: str | None,
              name: str, description: str = "", chunk_size: int = 500, chunk_overlap: int = 50) -> KnowledgeBase:
    name = name.strip()
    if session.scalar(select(KnowledgeBase).where(KnowledgeBase.project_id == project_id,
                                                  KnowledgeBase.name == name)):
        raise Conflict(f"專案內已有知識庫「{name}」")
    if chunk_overlap >= chunk_size // 2:
        raise Invalid("重疊字數需小於切片長度的一半")
    kb = KnowledgeBase(project_id=project_id, name=name, description=description,
                       embed_model=services.settings.embed_model, chunk_size=chunk_size,
                       chunk_overlap=chunk_overlap, created_by=actor)
    session.add(kb)
    session.flush()
    record(session, actor=actor, category=AuditCategory.DATASET, action="llm.kb.create", target=f"kb:{kb.id}",
           source_ip=source_ip, detail={"name": name, "embed_model": kb.embed_model})
    session.commit()
    return kb


def delete_kb(session: Session, services: LlmServices, *, project_id: int, actor: str, source_ip: str | None,
              kb_id: int) -> None:
    kb = get_kb(session, project_id=project_id, kb_id=kb_id)
    used_by = session.scalar(select(PublishedService).where(PublishedService.kb_id == kb.id))
    if used_by:
        raise Conflict(f"知識庫正被已發布的服務「{used_by.name}」使用，請先取消發布")
    services.vectors.delete_kb(session, kb.id)
    for doc in documents_of(session, kb.id):
        session.delete(doc)
    session.delete(kb)
    record(session, actor=actor, category=AuditCategory.DATASET, action="llm.kb.delete", target=f"kb:{kb_id}",
           source_ip=source_ip, detail={"name": kb.name})
    session.commit()


def _embed(services: LlmServices, model: str, texts: list[str]) -> list[list[float]]:
    client = require_client(services)
    vectors: list[list[float]] = []
    for start in range(0, len(texts), EMBED_BATCH):
        vectors += client.embed(model=model, texts=texts[start:start + EMBED_BATCH])
    return vectors


def add_documents(session: Session, services: LlmServices, *, kb: KnowledgeBase, actor: str,
                  source_ip: str | None, files: list[tuple[str, bytes]]) -> dict:
    """逐檔處理：一份失敗不影響其他份；每份不是整份寫入就是完全不寫。"""
    if not files:
        raise Invalid("請至少上傳一個檔案")
    if len(files) > MAX_FILES_PER_UPLOAD:
        raise Invalid(f"一次最多上傳 {MAX_FILES_PER_UPLOAD} 個檔案")
    require_client(services)
    results = []
    for filename, data in files:
        filename = (filename or "").replace("\\", "/").rsplit("/", 1)[-1][:256]
        entry = {"filename": filename, "status": "failed", "reason": "", "document": None}
        results.append(entry)
        try:
            fmt, text = extract_text(filename, data)
            digest = hashlib.sha256(data).hexdigest()
            existing = session.scalar(select(KbDocument).where(KbDocument.kb_id == kb.id,
                                                               KbDocument.sha256 == digest))
            if existing:
                entry.update(status="duplicate", reason=f"與「{existing.filename}」內容相同",
                             document=document_out(existing))
                continue
            chunks = chunk_text(text, size=kb.chunk_size, overlap=kb.chunk_overlap)
            vectors = _embed(services, kb.embed_model, chunks)
            document = KbDocument(kb_id=kb.id, filename=filename, format=fmt, sha256=digest, size=len(data),
                                  chunks=len(chunks), characters=len(text), uploaded_by=actor)
            session.add(document)
            session.flush()
            services.vectors.add(session, kb.id, document.id, chunks, vectors)
            session.commit()
            entry.update(status="indexed", document=document_out(document))
        except DocumentError as exc:
            session.rollback()
            entry["reason"] = str(exc)
        except LlmError as exc:
            session.rollback()
            entry["reason"] = str(exc)
        except ValueError as exc:
            session.rollback()
            entry["reason"] = f"向量化結果不合法：{exc}"
    counts = {status: sum(1 for r in results if r["status"] == status) for status in ("indexed", "duplicate", "failed")}
    record(session, actor=actor, category=AuditCategory.DATASET, action="llm.kb.documents.add",
           target=f"kb:{kb.id}", result="success" if not counts["failed"] else "partial" if counts["indexed"] else "failed",
           source_ip=source_ip,
           detail={"counts": counts, "files": [{"filename": r["filename"], "status": r["status"],
                                                "reason": r["reason"]} for r in results]})
    session.commit()
    return {"kb_id": kb.id, "counts": counts, "results": results}


def delete_document(session: Session, services: LlmServices, *, kb: KnowledgeBase, actor: str,
                    source_ip: str | None, document_id: int) -> None:
    document = session.get(KbDocument, document_id)
    if document is None or document.kb_id != kb.id:
        raise NotFound(f"找不到文件 {document_id}")
    services.vectors.delete_document(session, kb.id, document.id)
    session.delete(document)
    record(session, actor=actor, category=AuditCategory.DATASET, action="llm.kb.documents.delete",
           target=f"kb:{kb.id}", source_ip=source_ip, detail={"document_id": document_id, "filename": document.filename})
    session.commit()


def search(session: Session, services: LlmServices, *, kb: KnowledgeBase, query: str, k: int = 3) -> list[dict]:
    vector = _embed(services, kb.embed_model, [query])[0]
    hits = services.vectors.search(session, kb.id, vector, k)
    names = {d.id: d.filename for d in documents_of(session, kb.id)}
    return [{"document_id": h.document_id, "filename": names.get(h.document_id, ""), "chunk_index": h.chunk_index,
             "score": round(h.score, 6), "content": h.content} for h in hits]
