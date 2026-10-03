"""CSV upload validation against a :class:`~tabular.schema.Schema`.

Rules
-----
* Row indices in reports are 0-based data rows (header excluded, blank lines skipped).
* A row with a field count different from the header is rejected (column ``None``).
* A rejected row never enters the clean DataFrame.
* ``unique`` columns keep the first valid occurrence and reject later duplicates.
* File-level errors (empty file, duplicate header, missing required columns) yield
  ``valid_rows == 0`` in the report and raise :class:`TabularError` from
  :func:`load_clean_csv`.
* Unknown extra columns produce a warning and are dropped from the clean frame.
"""

from __future__ import annotations

import csv
import io
import math
import re
from datetime import date, datetime
from os import PathLike
from typing import IO, Any

import pandas as pd

from tabular.errors import TabularError
from tabular.schema import ColumnSpec, Schema

Source = str | PathLike | IO[str] | IO[bytes]

_INT_RE = re.compile(r"^[+-]?\d+$")
_TRUE = {"true", "1", "yes", "y", "t", "是"}
_FALSE = {"false", "0", "no", "n", "f", "否"}


class _CellError(Exception):
    pass


BIG5_WARNING = {
    "code": "big5_encoding",
    "message": "檔案不是 UTF-8 編碼，已以 Big5（Excel 繁體中文預設）讀取；若中文顯示異常，請另存為「CSV UTF-8」",
}


def read_text(src: Source) -> tuple[str, str]:
    """Return ``(text, encoding)``: UTF-8 (BOM allowed) first, then Big5 (cp950), which is what
    Excel on Traditional Chinese Windows writes for "Save as CSV"."""
    if isinstance(src, (str, PathLike)):
        with open(src, "rb") as fh:
            raw: Any = fh.read()
    else:
        raw = src.read()
    encoding = "utf-8"
    if isinstance(raw, bytes):
        try:
            raw = raw.decode("utf-8-sig")
        except UnicodeDecodeError:
            try:
                raw, encoding = raw.decode("cp950"), "cp950"
            except UnicodeDecodeError:
                raise TabularError("檔案編碼無法辨識，請使用 UTF-8 編碼的 CSV", code="bad_encoding") from None
    return raw.lstrip("\ufeff"), encoding


def read_rows(text: str) -> list[list[str]]:
    """CSV rows with blank lines dropped."""
    return [row for row in csv.reader(io.StringIO(text)) if any(cell.strip() for cell in row)]


def _parse(spec: ColumnSpec, text: str) -> Any:
    t = spec.type
    if t == "int":
        if not _INT_RE.match(text):
            raise _CellError(f"「{text}」不是整數")
        value: Any = int(text)
    elif t == "float":
        try:
            value = float(text)
        except ValueError:
            raise _CellError(f"「{text}」不是數值") from None
        if not math.isfinite(value):
            raise _CellError(f"「{text}」不是有限數值")
    elif t == "bool":
        low = text.lower()
        if low in _TRUE:
            value = True
        elif low in _FALSE:
            value = False
        else:
            raise _CellError(f"「{text}」不是布林值（true/false）")
    elif t == "date":
        try:
            value = date.fromisoformat(text) if len(text) <= 10 else datetime.fromisoformat(text)
        except ValueError:
            raise _CellError(f"「{text}」不是有效日期（YYYY-MM-DD）") from None
    else:  # str, category
        value = text

    if spec.pattern is not None and not re.fullmatch(spec.pattern, text):
        raise _CellError(f"「{text}」格式不符（應符合 {spec.pattern}）")
    if spec.allowed is not None and value not in spec.allowed and text not in [str(a) for a in spec.allowed]:
        allowed = "、".join(str(a) for a in spec.allowed)
        raise _CellError(f"「{text}」不在允許值（{allowed}）之內")
    if t in ("int", "float", "date"):
        cmp = value.date() if isinstance(value, datetime) else value
        lo = date.fromisoformat(str(spec.min)) if t == "date" and spec.min is not None else spec.min
        hi = date.fromisoformat(str(spec.max)) if t == "date" and spec.max is not None else spec.max
        if lo is not None and cmp < lo:
            raise _CellError(f"「{text}」小於最小值 {spec.min}")
        if hi is not None and cmp > hi:
            raise _CellError(f"「{text}」大於最大值 {spec.max}")
    return value


def _empty_report(columns: list[str], total: int = 0) -> dict[str, Any]:
    return {
        "valid_rows": 0,
        "total_rows": total,
        "rejected_row_count": 0,
        "rejected": [],
        "columns": columns,
        "errors": [],
        "warnings": [],
    }


def _to_frame(schema: Schema, used: list[ColumnSpec], records: list[dict[str, Any]]) -> pd.DataFrame:
    data: dict[str, Any] = {}
    for spec in used:
        values = [r[spec.name] for r in records]
        if spec.type == "int":
            data[spec.name] = pd.array(values, dtype="Int64")
        elif spec.type == "float":
            data[spec.name] = pd.array([float("nan") if v is None else v for v in values], dtype="float64")
        elif spec.type == "bool":
            data[spec.name] = pd.array(values, dtype="boolean")
        elif spec.type == "date":
            data[spec.name] = pd.to_datetime(pd.Series(values, dtype="object"))
        elif spec.type == "category":
            cats = spec.allowed if spec.allowed is not None else None
            data[spec.name] = pd.Categorical(values, categories=cats)
        else:
            data[spec.name] = pd.Series(values, dtype="object")
    return pd.DataFrame(data, index=pd.RangeIndex(len(records)))


def validate_and_load(src: Source, schema: Schema) -> tuple[dict[str, Any], pd.DataFrame]:
    """Validate a CSV and return ``(report, clean_frame)``. Never raises on bad rows."""
    text, encoding = read_text(src)
    lines = read_rows(text)
    if not lines:
        report = _empty_report([])
        report["errors"].append({"code": "empty_file", "message": "檔案是空的，沒有任何欄位或資料"})
        return report, pd.DataFrame()

    header = [h.strip() for h in lines[0]]
    body = lines[1:]
    report = _empty_report(header, total=len(body))
    if encoding != "utf-8":
        report["warnings"].append(dict(BIG5_WARNING))

    dupes = sorted({h for h in header if header.count(h) > 1})
    if dupes:
        report["errors"].append({
            "code": "duplicate_columns",
            "message": f"標題列有重複欄位：{'、'.join(dupes)}",
        })
    missing = [c.name for c in schema.columns if c.required and c.name not in header]
    if missing:
        report["errors"].append({
            "code": "missing_required_columns",
            "message": f"缺少必要欄位：{'、'.join(missing)}",
        })
    if not body and not report["errors"]:
        report["errors"].append({"code": "empty_file", "message": "檔案只有標題列，沒有任何資料列"})
    if report["errors"]:
        return report, pd.DataFrame()

    unknown = [h for h in header if h not in schema.names]
    if unknown:
        report["warnings"].append({
            "code": "unknown_columns",
            "message": f"結構定義中沒有下列欄位，將忽略：{'、'.join(unknown)}",
        })

    used = [c for c in schema.columns if c.name in header]
    positions = {name: header.index(name) for name in schema.names if name in header}
    seen: dict[str, dict[Any, int]] = {c.name: {} for c in used if c.unique}
    tokens = {c.name: c.missing_tokens() for c in used}
    rejected: list[dict[str, Any]] = []
    records: list[dict[str, Any]] = []

    for i, row in enumerate(body):
        if len(row) != len(header):
            rejected.append({
                "row": i,
                "column": None,
                "reason": f"欄位數不符：應為 {len(header)} 欄，實際 {len(row)} 欄",
            })
            continue
        record: dict[str, Any] = {}
        row_errors: list[dict[str, Any]] = []
        for spec in used:
            raw = row[positions[spec.name]].strip()
            if raw == "" or (tokens[spec.name] and raw.casefold() in tokens[spec.name]):
                if spec.required:
                    reason = "必填欄位為空值" if raw == "" else f"必填欄位為缺值（「{raw}」）"
                    row_errors.append({"row": i, "column": spec.name, "reason": reason})
                record[spec.name] = None
                continue
            try:
                record[spec.name] = _parse(spec, raw)
            except _CellError as exc:
                row_errors.append({"row": i, "column": spec.name, "reason": str(exc)})
        if not row_errors:
            for name, index in seen.items():
                value = record[name]
                if value is not None and value in index:
                    row_errors.append({
                        "row": i,
                        "column": name,
                        "reason": f"值「{value}」重複（與第 {index[value]} 列相同），此欄位不可重複",
                    })
        if row_errors:
            rejected.extend(row_errors)
            continue
        for name, index in seen.items():
            if record[name] is not None:
                index[record[name]] = i
        records.append(record)

    report["rejected"] = rejected
    report["rejected_row_count"] = len({r["row"] for r in rejected})
    report["valid_rows"] = len(records)
    return report, _to_frame(schema, used, records)


def validate_csv(src: Source, schema: Schema) -> dict[str, Any]:
    """Validate a CSV file/buffer and return a JSON-serialisable report."""
    return validate_and_load(src, schema)[0]


def load_clean_csv(src: Source, schema: Schema) -> pd.DataFrame:
    """Return only the valid, typed rows. Raises :class:`TabularError` on file-level errors."""
    report, df = validate_and_load(src, schema)
    if report["errors"]:
        first = report["errors"][0]
        raise TabularError(first["message"], code=first["code"], detail={"errors": report["errors"]})
    return df
