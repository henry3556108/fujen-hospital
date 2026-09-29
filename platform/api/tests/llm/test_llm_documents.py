import io
import zipfile

import pytest

from app.db import make_engine, make_sessionmaker
from app.llm.client import hashed_embedding
from app.llm.documents import DocumentError, chunk_text, detect_format, extract_text
from app.llm.vectors import InMemoryVectorStore, SqlVectorStore, cosine, store_from_env, vector_literal
from app.models import Base

from docs_support import FILENAMES, FILES, UNIQUE


@pytest.mark.parametrize("fmt", ["pdf", "docx", "txt", "csv", "json", "html"])
def test_tc_b07_06_each_format_extracts_its_text(fmt):
    detected, text = extract_text(FILENAMES[fmt], FILES[FILENAMES[fmt]])
    assert detected == fmt and UNIQUE[fmt] in text
    others = [UNIQUE[f] for f in UNIQUE if f != fmt]
    assert not any(o in text for o in others)


def test_html_drops_script_style_and_keeps_title():
    _, text = extract_text("a.html", FILES[FILENAMES["html"]])
    assert "should-not-be-indexed" not in text and "font-family" not in text
    assert text.startswith("掛號流程") and "<p>" not in text


def test_csv_rows_carry_their_headers():
    _, text = extract_text("a.csv", FILES[FILENAMES["csv"]])
    assert "department：資訊室；extension：2688；floor：5F" in text.splitlines()


def test_json_flat_records_stay_on_one_line():
    _, text = extract_text("a.json", FILES[FILENAMES["json"]])
    assert any("code：HbA1c" in line and "糖化血色素" in line and "high：5.6" in line for line in text.splitlines())


def test_big5_and_utf16_text_are_decoded():
    assert extract_text("a.txt", "門診時間".encode("cp950"))[1] == "門診時間"
    assert extract_text("a.txt", "門診時間".encode("utf-16"))[1] == "門診時間"
    assert extract_text("a.TXT", b"\xef\xbb\xbfhello")[1] == "hello"


def _zip(files):
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as z:
        for name, data in files.items():
            z.writestr(name, data)
    return out.getvalue()


@pytest.mark.parametrize("filename,data,reason", [
    ("a.exe", b"MZ", "不支援"),
    ("noextension", b"text", "不支援"),
    ("a.txt", b"", "空的"),
    ("a.txt", b"   \n\n ", "沒有文字"),
    ("a.pdf", b"not a pdf", "不是 PDF"),
    ("a.pdf", b"%PDF-1.4\ngarbage", "PDF"),
    ("a.docx", b"not a zip", "不是 DOCX"),
    ("a.docx", _zip({"other.xml": "<a/>"}), "不是 DOCX"),
    ("a.docx", _zip({"word/document.xml": "<a><b></a>"}), "XML"),
    ("a.docx", _zip({"word/document.xml": '<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>'}), "不允許"),
    ("a.json", b"{broken", "JSON"),
    ("a.txt", b"\xff\xfe\xff", "編碼"),
])
def test_bad_documents_fail_with_a_reason(filename, data, reason):
    with pytest.raises(DocumentError) as err:
        extract_text(filename, data)
    assert reason in str(err.value)


def test_oversized_document_is_refused(monkeypatch):
    monkeypatch.setattr("app.llm.documents.MAX_DOCUMENT_BYTES", 10)
    with pytest.raises(DocumentError, match="上限"):
        extract_text("a.txt", b"x" * 11)


def test_detect_format_is_case_insensitive_and_accepts_htm():
    assert detect_format("REPORT.PDF") == "pdf" and detect_format("index.htm") == "html"


def test_chunks_cover_the_text_overlap_and_prefer_sentence_ends():
    sentences = [f"第{i}條規範內容說明如下，請同仁確實遵守並定期檢視。" for i in range(1, 41)]
    text = "".join(sentences)
    chunks = chunk_text(text, size=100, overlap=10)
    assert len(chunks) > 5 and all(len(c) <= 100 for c in chunks)
    assert all(c.endswith("。") for c in chunks)
    for sentence in sentences:
        assert any(sentence in c for c in chunks) or any(sentence[:20] in c for c in chunks)
    for a, b in zip(chunks, chunks[1:]):
        assert a[-10:] in b[:20] or b.startswith(a[-10:])
    assert chunk_text("短文", size=100, overlap=10) == ["短文"]
    with pytest.raises(ValueError):
        chunk_text("x", size=100, overlap=60)


@pytest.fixture
def sql_session():
    engine = make_engine("sqlite://")
    Base.metadata.create_all(engine)
    with make_sessionmaker(engine)() as s:
        yield s


@pytest.mark.parametrize("make", [InMemoryVectorStore, SqlVectorStore])
def test_vector_store_contract(make, sql_session):
    store = make()
    texts = ["門診時間為週一至週五", "磁振造影檢查前取下金屬物品", "乾洗手至少 20 秒"]
    store.add(sql_session, 1, 10, texts[:2], [hashed_embedding(t) for t in texts[:2]])
    store.add(sql_session, 1, 11, texts[2:], [hashed_embedding(texts[2])])
    store.add(sql_session, 2, 12, ["別的知識庫"], [hashed_embedding("門診時間")])
    assert store.count(sql_session, 1) == 3 and store.count(sql_session, 2) == 1

    hits = store.search(sql_session, 1, hashed_embedding("門診時間"), 2)
    assert [h.content for h in hits][0] == texts[0] and len(hits) == 2
    assert (hits[0].document_id, hits[0].chunk_index) == (10, 0) and hits[0].score > hits[1].score
    assert all(h.document_id != 12 for h in store.search(sql_session, 1, hashed_embedding("門診時間"), 10))

    store.delete_document(sql_session, 1, 10)
    assert [h.document_id for h in store.search(sql_session, 1, hashed_embedding("門診時間"), 5)] == [11]
    store.delete_kb(sql_session, 1)
    assert store.count(sql_session, 1) == 0 and store.count(sql_session, 2) == 1
    assert store.search(sql_session, 1, hashed_embedding("x"), 3) == []


@pytest.mark.parametrize("make", [InMemoryVectorStore, SqlVectorStore])
def test_vector_store_rejects_mismatched_or_invalid_vectors(make, sql_session):
    with pytest.raises(ValueError):
        make().add(sql_session, 1, 1, ["a", "b"], [[1.0]])
    with pytest.raises(ValueError):
        make().add(sql_session, 1, 1, ["a"], [[float("nan")]])


def test_sql_store_rolls_back_with_the_session(sql_session):
    store = SqlVectorStore()
    store.add(sql_session, 1, 1, ["a"], [[1.0, 0.0]])
    sql_session.rollback()
    assert store.count(sql_session, 1) == 0


def test_cosine_and_literal():
    assert cosine([1, 0], [1, 0]) == 1 and cosine([1, 0], [0, 1]) == 0 and cosine([0, 0], [1, 1]) == 0
    assert vector_literal([1, 0.5, -2]) == "[1.0,0.5,-2.0]"
    with pytest.raises(ValueError):
        cosine([1], [1, 2])


def test_store_from_env_defaults_to_sql_and_rejects_unknown():
    assert store_from_env(None, {}).name == "sql"
    with pytest.raises(RuntimeError):
        store_from_env(None, {"VECTOR_STORE": "faiss"})
