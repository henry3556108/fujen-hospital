import sqlite3

import pytest

from app.fhir.sources import SourceError, read_records, validate_config


@pytest.fixture
def his_db(clinical, tmp_path):
    """把 synth 的 patients.sql 載入 SQLite，模擬院內 HIS 資料庫。"""
    path = tmp_path / "his.sqlite"
    with sqlite3.connect(path) as conn:
        conn.executescript((clinical / "patients.sql").read_text(encoding="utf-8"))
    return f"sqlite:///{path}"


def test_tc_c03_04_sql_source_reads_all_rows(his_db):
    rows = read_records("sql", {"dsn": his_db, "query": "SELECT * FROM patients ORDER BY patient_id"}, None)
    assert len(rows) == 20
    assert rows[0]["patient_id"] == "SYN-42-0001" and rows[0]["family_name"] == "TSAI"


def test_tc_c03_04_csv_source_reads_all_rows(clinical):
    rows = read_records("csv", {}, (clinical / "encounters.csv").read_text(encoding="utf-8"))
    assert len(rows) == 20 and rows[0]["encounter_id"] == "ENC0001"


def test_tc_c03_04_json_source_reads_all_rows(clinical):
    rows = read_records("json", {}, (clinical / "labs.json").read_text(encoding="utf-8"))
    assert len(rows) == 20 and rows[0]["loinc"] == "2345-7"


def test_tc_c03_04_hl7_source_reads_all_messages(hl7_messages):
    rows = read_records("hl7v2", {}, "\n".join(hl7_messages))
    assert len(rows) == 20 and rows[19]["visit_number"] == "VN0020"


def test_json_lines_and_records_path():
    assert read_records("json", {"format": "jsonl"}, '{"a": 1}\n{"a": 2}\n') == [{"a": 1}, {"a": 2}]
    assert read_records("json", {"records_path": "data.items"}, '{"data": {"items": [{"a": 1}]}}') == [{"a": 1}]


def test_tc_c03_13_batch_with_invalid_hl7_is_rejected_as_a_whole(hl7_messages, invalid_hl7):
    content = "\n".join(hl7_messages[:3] + list(invalid_hl7.values()))
    with pytest.raises(SourceError) as exc:
        read_records("hl7v2", {}, content)
    assert [item["index"] for item in exc.value.items] == [3, 4]
    assert {item["control_id"] for item in exc.value.items} == {"MSG42-INV1", "MSG42-INV2"}


@pytest.mark.parametrize("query", [
    "DELETE FROM patients", "SELECT 1; DROP TABLE patients", "UPDATE patients SET sex='M'",
    "WITH x AS (DELETE FROM patients RETURNING *) SELECT * FROM x", "",
])
def test_sql_source_only_allows_read_only_select(his_db, query):
    assert validate_config("sql", {"dsn": his_db, "query": query}, None)
    with pytest.raises(SourceError):
        read_records("sql", {"dsn": his_db, "query": query}, None)
    assert len(read_records("sql", {"dsn": his_db, "query": "select * from patients"}, None)) == 20


def test_sql_error_does_not_leak_connection_string():
    dsn = "postgresql+psycopg://his:s3cret-pw@127.0.0.1:1/his"
    with pytest.raises(SourceError) as exc:
        read_records("sql", {"dsn": dsn, "query": "select 1"}, None)
    assert "s3cret-pw" not in exc.value.message


@pytest.mark.parametrize("kind, content, expected", [
    ("csv", "a,b\n1\n", "欄位數"), ("csv", "", "標頭"), ("json", "{not json", "JSON 解析失敗"),
    ("json", '{"a": 1}', "物件陣列"),
])
def test_malformed_content_is_rejected(kind, content, expected):
    with pytest.raises(SourceError) as exc:
        read_records(kind, {}, content)
    assert expected in exc.value.message


def test_validate_config():
    assert validate_config("xml", {}, "x")
    assert validate_config("csv", {}, "  ")
    assert validate_config("sql", {"query": "select 1"}, None)
    assert validate_config("csv", {}, "a\n1\n") == []
