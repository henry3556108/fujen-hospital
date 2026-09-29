"""四種來源讀成記錄（list[dict]）：sql、csv、hl7v2、json。讀取失敗或內容不合格一律整批拒絕。"""
import csv
import io
import json
import re

from sqlalchemy import create_engine, text
from sqlalchemy.exc import SQLAlchemyError

from app.fhir import hl7v2

KINDS = ("sql", "csv", "hl7v2", "json")
_WRITE_KEYWORDS = re.compile(
    r"\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|call|merge|attach|pragma|vacuum)\b",
    re.IGNORECASE)


class SourceError(Exception):
    """來源無法讀取或內容不合格。items 為逐筆原因（HL7 V2 用）。"""

    def __init__(self, message: str, items: list[dict] | None = None):
        super().__init__(message)
        self.message = message
        self.items = items or []


def validate_config(kind: str, config: dict, content: str | None) -> list[str]:
    if kind not in KINDS:
        return [f"kind 必須是 {'、'.join(KINDS)} 之一"]
    if kind == "sql":
        problems = []
        if not config.get("dsn"):
            problems.append("sql 來源需要 config.dsn")
        problems.extend(_query_problems(config.get("query") or ""))
        return problems
    if content is None or not content.strip():
        return [f"{kind} 來源需要 content"]
    return []


def _query_problems(query: str) -> list[str]:
    stripped = query.strip().rstrip(";").strip()
    if not stripped:
        return ["sql 來源需要 config.query"]
    if ";" in stripped:
        return ["query 只能有一個陳述式"]
    if not re.match(r"^(select|with)\b", stripped, re.IGNORECASE) or _WRITE_KEYWORDS.search(stripped):
        return ["query 只能是唯讀的 SELECT"]
    return []


def read_records(kind: str, config: dict, content: str | None) -> list[dict]:
    if kind == "sql":
        return _read_sql(config)
    if kind == "csv":
        return _read_csv(content or "")
    if kind == "json":
        return _read_json(content or "", config)
    if kind == "hl7v2":
        return _read_hl7(content or "")
    raise SourceError(f"不支援的來源類型 {kind}")


def _read_sql(config: dict) -> list[dict]:
    problems = _query_problems(config.get("query") or "")
    if problems:
        raise SourceError(problems[0])
    query = config["query"].strip().rstrip(";")
    try:
        engine = create_engine(config["dsn"])
        try:
            with engine.connect() as conn:
                rows = conn.execute(text(query)).mappings().all()
                conn.rollback()
        finally:
            engine.dispose()
    except SQLAlchemyError as exc:
        # 不回傳驅動的原始訊息：裡面可能有連線字串
        raise SourceError(f"SQL 來源讀取失敗（{type(exc).__name__}）")
    except Exception as exc:  # 連線字串格式錯誤、缺驅動
        raise SourceError(f"SQL 來源設定錯誤（{type(exc).__name__}）")
    return [dict(r) for r in rows]


def _read_csv(content: str) -> list[dict]:
    reader = csv.DictReader(io.StringIO(content.lstrip("﻿")))
    if not reader.fieldnames:
        raise SourceError("CSV 沒有標頭列")
    rows = []
    for number, row in enumerate(reader, start=2):
        if None in row or any(v is None for v in row.values()):
            raise SourceError(f"CSV 第 {number} 列的欄位數與標頭不符")
        rows.append(row)
    return rows


def _read_json(content: str, config: dict) -> list[dict]:
    try:
        rows = [json.loads(line) for line in content.splitlines() if line.strip()] \
            if config.get("format") == "jsonl" else json.loads(content)
    except json.JSONDecodeError as exc:
        raise SourceError(f"JSON 解析失敗：第 {exc.lineno} 行")
    for name in filter(None, (config.get("records_path") or "").split(".")):
        if not isinstance(rows, dict) or name not in rows:
            raise SourceError(f"JSON 內找不到 records_path {config['records_path']}")
        rows = rows[name]
    if not isinstance(rows, list) or not all(isinstance(r, dict) for r in rows):
        raise SourceError("JSON 來源必須是物件陣列")
    return rows


def _read_hl7(content: str) -> list[dict]:
    records, rejected = [], []
    for index, message in enumerate(hl7v2.split_messages(content)):
        try:
            records.append(hl7v2.to_record(message))
        except hl7v2.Hl7Rejected as exc:
            rejected.append({"index": index, "control_id": exc.control_id, "reasons": exc.reasons})
    if rejected:
        raise SourceError(f"{len(rejected)} 則 HL7 V2 訊息不合格，整批不寫入", rejected)
    return records
