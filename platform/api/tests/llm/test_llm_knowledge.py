"""知識庫：TC-B07-06。"""
import pytest
from sqlalchemy import select

from app.llm.models import KbChunk, KbDocument
from app.llm.vectors import SqlVectorStore
from app.models import AuditLog

from docs_support import FILENAMES, FILES, UNIQUE


def upload(client, base, headers, kb_id, names):
    files = [("files", (name, FILES.get(name, b""), "application/octet-stream")) for name in names]
    return client.post(f"{base}/knowledge-bases/{kb_id}/documents", headers=headers, files=files)


@pytest.fixture
def kb(client, llm, coder, base):
    response = client.post(f"{base}/knowledge-bases", headers=coder, json={"name": "院內作業規範"})
    assert response.status_code == 201, response.text
    return response.json()


@pytest.fixture(params=["memory", "sql"])
def any_store(request, llm):
    if request.param == "sql":
        llm.vectors = SqlVectorStore()
    return request.param


def test_tc_b07_06_six_formats_build_the_vector_store(client, any_store, kb, coder, base, session):
    response = upload(client, base, coder, kb["id"], list(FILES))
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["counts"] == {"indexed": 6, "duplicate": 0, "failed": 0}
    assert sorted(r["document"]["format"] for r in body["results"]) == ["csv", "docx", "html", "json", "pdf", "txt"]
    assert all(r["document"]["chunks"] >= 1 for r in body["results"])

    reloaded = client.get(f"{base}/knowledge-bases/{kb['id']}", headers=coder).json()
    assert reloaded["documents"] == 6 and reloaded["chunks"] == sum(r["document"]["chunks"] for r in body["results"])
    assert len(client.get(f"{base}/knowledge-bases/{kb['id']}/documents", headers=coder).json()) == 6

    # 每一種格式的內容都檢索得到，且來自對的檔案
    for fmt, phrase in UNIQUE.items():
        hits = client.post(f"{base}/knowledge-bases/{kb['id']}/search", headers=coder,
                           json={"query": phrase, "k": 2}).json()
        assert hits and hits[0]["filename"] == FILENAMES[fmt] and phrase in hits[0]["content"], fmt

    session.expire_all()
    audit = session.scalars(select(AuditLog).where(AuditLog.action == "llm.kb.documents.add")).one()
    assert audit.category == "dataset" and audit.detail["counts"]["indexed"] == 6 and audit.actor == "ca01"


def test_tc_b07_06_mounted_knowledge_base_reaches_the_model(client, llm, kb, coder, base):
    upload(client, base, coder, kb["id"], list(FILES))
    answer = client.post(f"{base}/chat", headers=coder,
                         json={"mode": "kb", "kb_id": kb["id"], "message": "體內有心律調節器可以做磁振造影嗎"})
    assert answer.status_code == 200, answer.text
    body = answer.json()
    assert body["message"]["sources"][0]["filename"] == FILENAMES["docx"]
    sent = llm.client.chat_calls[-1]["messages"]
    assert sent[0]["role"] == "system" and "Context:" in sent[0]["content"] and "心律調節器" in sent[0]["content"]
    assert "context:" in body["message"]["content"]
    call = client.get(f"{base}/calls/{body['call_id']}", headers=coder).json()
    assert call["context_source"] == "vector" and call["context_refs"][0]["filename"] == FILENAMES["docx"]


def test_bad_file_does_not_affect_the_others_and_leaves_nothing_behind(client, llm, kb, coder, base, session):
    llm.vectors = SqlVectorStore()
    files = [("files", ("good.txt", "門診時間為週一至週五".encode(), "text/plain")),
             ("files", ("broken.pdf", b"not a pdf", "application/pdf")),
             ("files", ("empty.txt", b"", "text/plain")),
             ("files", ("malware.exe", b"MZ", "application/octet-stream")),
             ("files", ("../../etc/notes.txt", "乾洗手至少 20 秒".encode(), "text/plain"))]
    body = client.post(f"{base}/knowledge-bases/{kb['id']}/documents", headers=coder, files=files).json()
    assert body["counts"] == {"indexed": 2, "duplicate": 0, "failed": 3}
    status = {r["filename"]: (r["status"], r["reason"]) for r in body["results"]}
    assert status["good.txt"][0] == "indexed" and status["notes.txt"][0] == "indexed"   # 路徑被去掉
    assert "不是 PDF" in status["broken.pdf"][1] and "空的" in status["empty.txt"][1]
    assert "不支援" in status["malware.exe"][1]
    session.expire_all()
    docs = session.scalars(select(KbDocument)).all()
    assert sorted(d.filename for d in docs) == ["good.txt", "notes.txt"]
    assert {c.document_id for c in session.scalars(select(KbChunk))} == {d.id for d in docs}


def test_same_content_twice_is_a_duplicate_not_a_second_copy(client, llm, kb, coder, base):
    name = FILENAMES["txt"]
    assert upload(client, base, coder, kb["id"], [name]).json()["counts"]["indexed"] == 1
    again = upload(client, base, coder, kb["id"], [name]).json()
    assert again["counts"] == {"indexed": 0, "duplicate": 1, "failed": 0}
    assert client.get(f"{base}/knowledge-bases/{kb['id']}", headers=coder).json()["documents"] == 1


def test_embedding_outage_fails_the_file_without_half_writes(client, llm, kb, coder, base, session):
    llm.vectors = SqlVectorStore()
    llm.client.fail = "down"
    body = upload(client, base, coder, kb["id"], [FILENAMES["txt"]]).json()
    assert body["counts"]["failed"] == 1 and "重試" in body["results"][0]["reason"]
    session.expire_all()
    assert session.scalars(select(KbDocument)).all() == [] and session.scalars(select(KbChunk)).all() == []
    llm.client.fail = None
    assert upload(client, base, coder, kb["id"], [FILENAMES["txt"]]).json()["counts"]["indexed"] == 1


def test_delete_document_and_knowledge_base_remove_vectors(client, llm, kb, coder, base):
    docs = upload(client, base, coder, kb["id"], [FILENAMES["txt"], FILENAMES["csv"]]).json()["results"]
    url = f"{base}/knowledge-bases/{kb['id']}"
    assert client.delete(f"{url}/documents/{docs[0]['document']['id']}", headers=coder).status_code == 204
    hits = client.post(f"{url}/search", headers=coder, json={"query": UNIQUE["txt"], "k": 5}).json()
    assert all(h["filename"] != FILENAMES["txt"] for h in hits)
    assert client.delete(f"{url}/documents/9999", headers=coder).status_code == 404
    assert client.delete(url, headers=coder).status_code == 204
    assert client.get(url, headers=coder).status_code == 404
    assert llm.vectors.count(None, kb["id"]) == 0


def test_knowledge_base_is_project_scoped_and_needs_coding(client, llm, kb, coder, viewer, session, member, base):
    from app.models import Project
    other = Project(name="P-other")
    session.add(other)
    session.commit()
    outsider = member(other, "ca09")
    for url in (f"/api/projects/{other.id}/llm/knowledge-bases/{kb['id']}",
                f"/api/projects/{other.id}/llm/knowledge-bases/{kb['id']}/documents"):
        assert client.get(url, headers=outsider).status_code == 404
    assert client.post(f"/api/projects/{other.id}/llm/chat", headers=outsider,
                       json={"mode": "kb", "kb_id": kb["id"], "message": "hi"}).status_code == 404
    assert client.get(f"{base}/knowledge-bases", headers=outsider).status_code == 403
    assert client.get(f"{base}/knowledge-bases", headers=viewer).status_code == 403
    assert upload(client, base, viewer, kb["id"], [FILENAMES["txt"]]).status_code == 403
    assert client.get(f"{base}/knowledge-bases").status_code == 401


def test_knowledge_base_validation(client, llm, kb, coder, base):
    assert client.post(f"{base}/knowledge-bases", headers=coder, json={"name": "院內作業規範"}).status_code == 409
    assert client.post(f"{base}/knowledge-bases", headers=coder, json={"name": ""}).status_code == 422
    assert client.post(f"{base}/knowledge-bases", headers=coder,
                       json={"name": "x", "chunk_size": 100, "chunk_overlap": 60}).status_code == 422
    assert client.post(f"{base}/knowledge-bases/{kb['id']}/documents", headers=coder).status_code == 422
