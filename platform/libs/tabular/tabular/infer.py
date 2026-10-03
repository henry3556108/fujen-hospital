"""Infer a :class:`~tabular.schema.Schema` from a CSV so users do not have to write JSON.

Conservative by design (TC-B01-10): a column's type comes from the majority of its values
(``THRESHOLD`` = 90% of non-missing cells, so a 30-row file tolerates 3 odd cells). The few cells
that do not fit do not loosen the type; they are rejected at validation and listed with a reason.
The result carries a dry-run validation report against the inferred schema, so the user sees what
would be rejected before uploading.

Rules, in order, for each column (cells are stripped; blank and ``missing_values`` are missing):

1. type: bool (true/false/yes/no/是/否/y/n/t/f, not 0/1) → int → float → date (ISO) → text.
2. text: a fixed format with digits shared by >= 90% of values gives a ``pattern`` (``^P\\d{5}$``);
   an identifier (format or id-like name, no missing, >= 90% distinct) is ``unique``; few distinct
   values (<= 20 and <= half the cells) is ``category`` whose ``allowed`` list keeps values seen at
   least 3 times (and >= 0.5% of cells) when the column has >= 20 values. Codes with digits never get ``allowed``.
3. required: the column has no missing cell in this file.
4. range: a known clinical column name (age, bmi, sbp, 體溫 ...) gets a plausible range when >= 90%
   of values fall inside it; otherwise a numeric column that is >= 90% non-negative gets ``min = 0``.
   No maximum is guessed from the data.
"""

from __future__ import annotations

import io
import math
import re
from collections import Counter
from datetime import date, datetime
from typing import Any

from tabular.errors import TabularError
from tabular.schema import Schema
from tabular.validate import BIG5_WARNING, Source, read_rows, read_text, validate_and_load

THRESHOLD = 0.9
DEFAULT_MISSING_VALUES = ["NA", "N/A", "null", "NaN", "none", "-"]
MAX_CATEGORIES = 20
RARE_MIN_VALUES = 20  # 少於這麼多個值的欄位不判斷罕見值
RARE_MIN_COUNT = 3  # 出現少於 3 次（且少於 0.5%）的類別值視為罕見，不列入允許值
RARE_SHARE = 0.005
IDENTIFIER_DISTINCT = 0.9
EXAMPLES = 3

TYPE_ZH = {"int": "整數", "float": "小數", "category": "類別", "str": "文字", "date": "日期", "bool": "是否"}

_INT_RE = re.compile(r"^[+-]?\d+$")
_BOOL = {"true", "false", "yes", "no", "y", "n", "t", "f", "是", "否"}
_ID_NAME = re.compile(r"(^|[_\s\-])id$|^id([_\s\-]|$)|病歷|編號|身分證|身份證|識別|代號", re.IGNORECASE)

# 常見臨床欄位的合理範圍（欄名去掉括號內單位、空白與底線後比對，不分大小寫）
CLINICAL_RANGES: list[tuple[tuple[str, ...], float, float]] = [
    (("age", "年齡", "年紀"), 0, 120),
    (("bmi",), 10, 80),
    (("sbp", "systolic", "systolicbp", "收縮壓"), 40, 300),
    (("dbp", "diastolic", "diastolicbp", "舒張壓"), 20, 200),
    (("hr", "heartrate", "pulse", "心跳", "心率", "脈搏"), 20, 300),
    (("temp", "temperature", "bt", "體溫"), 30, 45),
    (("spo2", "血氧", "血氧飽和度"), 50, 100),
    (("rr", "respiratoryrate", "呼吸", "呼吸速率", "呼吸次數"), 0, 80),
    (("height", "身高"), 20, 250),
    (("weight", "體重"), 0.2, 400),
]


def _normalise_name(name: str) -> str:
    name = re.sub(r"[（(\[【].*?[)）\]】]", "", name)
    return re.sub(r"[\s_\-.]", "", name).casefold()


def _clinical_range(name: str) -> tuple[float, float] | None:
    key = _normalise_name(name)
    for names, lo, hi in CLINICAL_RANGES:
        if key in names:
            return lo, hi
    return None


def _is_int(v: str) -> bool:
    return bool(_INT_RE.match(v))


def _as_float(v: str) -> float | None:
    try:
        x = float(v)
    except ValueError:
        return None
    return x if math.isfinite(x) else None


def _is_float(v: str) -> bool:
    return _as_float(v) is not None


def _as_date(v: str) -> date | None:
    try:
        d = date.fromisoformat(v) if len(v) <= 10 else datetime.fromisoformat(v)
    except ValueError:
        return None
    return d.date() if isinstance(d, datetime) else d


def _is_date(v: str) -> bool:
    return _as_date(v) is not None


def _is_bool(v: str) -> bool:
    return v.casefold() in _BOOL


_CHECKS = {"bool": _is_bool, "int": _is_int, "float": _is_float, "date": _is_date}


def _shape(v: str) -> str:
    return re.sub(r"\d+", "\0", v)


def _pattern(values: list[str]) -> str | None:
    """A regex for the digit format shared by >= THRESHOLD of values, or None."""
    shapes = Counter(_shape(v) for v in values)
    shape, count = shapes.most_common(1)[0]
    if "\0" not in shape or count / len(values) < THRESHOLD:
        return None
    runs = [re.findall(r"\d+", v) for v in values if _shape(v) == shape]
    parts = shape.split("\0")
    out = re.escape(parts[0])
    for i, literal in enumerate(parts[1:]):
        lengths = {len(r[i]) for r in runs}
        out += rf"\d{{{lengths.pop()}}}" if len(lengths) == 1 else r"\d+"
        out += re.escape(literal)
    return f"^{out}$"


def _fmt(x: float) -> int | float:
    return int(x) if float(x).is_integer() else x


def _infer_column(name: str, values: list[str], tokens: frozenset[str],
                  missing_values: list[str]) -> tuple[dict[str, Any], dict[str, Any]]:
    present = [v for v in values if v != "" and v.casefold() not in tokens]
    n, missing = len(present), len(values) - len(present)
    distinct = Counter(present)
    spec: dict[str, Any] = {"name": name, "type": "str", "required": missing == 0, "min": None, "max": None,
                            "allowed": None, "unique": False, "pattern": None, "missing_values": list(missing_values)}
    summary: dict[str, Any] = {
        "name": name, "missing": missing, "distinct": len(distinct), "examples": list(distinct)[:EXAMPLES],
        "non_conforming": 0, "observed_min": None, "observed_max": None, "rare_values": [],
        "identifier": False, "range_source": None, "notes": [],
    }
    notes: list[str] = summary["notes"]
    if n == 0:
        spec["required"] = False
        notes.append("這欄全部空白或缺值")
        return spec, summary

    for ctype in ("bool", "int", "float", "date"):
        fits = [v for v in present if _CHECKS[ctype](v)]
        if len(fits) / n >= THRESHOLD:
            spec["type"] = ctype
            bad = [v for v in present if not _CHECKS[ctype](v)]
            if bad:
                summary["non_conforming"] = len(bad)
                notes.append(f"有 {len(bad)} 格不是{TYPE_ZH[ctype]}（例如「{bad[0]}」），上傳時這些列會被拒絕；"
                             f"如果這些值是正確的，請把型態改成「文字」")
            break

    ctype = spec["type"]
    if ctype in ("int", "float"):
        numbers = [_as_float(v) for v in present if _CHECKS[ctype](v)]
        numbers = [x for x in numbers if x is not None]
        summary["observed_min"], summary["observed_max"] = _fmt(min(numbers)), _fmt(max(numbers))
        bounds = _clinical_range(name)
        if bounds and sum(bounds[0] <= x <= bounds[1] for x in numbers) / len(numbers) >= THRESHOLD:
            spec["min"], spec["max"] = _fmt(bounds[0]), _fmt(bounds[1])
            summary["range_source"] = "name"
            notes.append(f"依欄名建議合理範圍 {spec['min']}–{spec['max']}，超出的列會被拒絕；可自行修改")
        elif sum(x >= 0 for x in numbers) / len(numbers) >= THRESHOLD:
            spec["min"] = 0
            summary["range_source"] = "nonnegative"
            if min(numbers) < 0:
                notes.append("幾乎都不是負數，最小值設為 0，負數的列會被拒絕；如果負數是正確的，請清空最小值")
    elif ctype == "date":
        dates = [d for d in (_as_date(v) for v in present) if d is not None]
        summary["observed_min"], summary["observed_max"] = min(dates).isoformat(), max(dates).isoformat()
    elif ctype == "str":
        _infer_text(name, present, missing, distinct, spec, summary)

    if missing:
        notes.append(f"有 {missing} 格空白或缺值，設為選填；如果這欄不該空白，請勾選「必填」")
    return spec, summary


def _infer_text(name: str, present: list[str], missing: int, distinct: Counter, spec: dict[str, Any],
                summary: dict[str, Any]) -> None:
    n, notes = len(present), summary["notes"]
    pattern = _pattern(present)
    few = len(distinct) <= MAX_CATEGORIES and len(distinct) <= n / 2
    if pattern:
        spec["pattern"] = pattern
        example = next(v for v in present if re.fullmatch(pattern, v))
        bad = [v for v in present if not re.fullmatch(pattern, v)]
        summary["non_conforming"] = len(bad)
        notes.append(f"格式固定（如「{example}」），格式不符的列會被拒絕"
                     + (f"；目前有 {len(bad)} 格不符（例如「{bad[0]}」）" if bad else ""))
    identifier = (pattern is not None or _ID_NAME.search(name) is not None) and missing == 0 \
        and len(distinct) / n >= IDENTIFIER_DISTINCT
    if identifier:
        spec["unique"] = True
        summary["identifier"] = True
        notes.append("幾乎每列都不同，像是病歷號等識別碼：設為不可重複，重複的列會被拒絕")
        return
    if not few:
        return
    spec["type"] = "category"
    if pattern:
        return  # 有數字的代碼（如檢查編號）可能還有新值，不限定允許值
    if n >= RARE_MIN_VALUES:
        floor = max(RARE_MIN_COUNT, math.ceil(RARE_SHARE * n))
        allowed = sorted(v for v, c in distinct.items() if c >= floor)
        rare = sorted(v for v, c in distinct.items() if c < floor)
    else:
        allowed, rare = sorted(distinct), []
    if not allowed:
        spec["type"] = "str"
        return
    spec["allowed"] = allowed
    summary["rare_values"] = rare
    if rare:
        shown = "、".join(f"「{v}」" for v in rare[:5]) + ("等" if len(rare) > 5 else "")
        notes.append(f"{shown}出現次數很少，沒有列入允許的值，上傳時這些列會被拒絕；如果是正確的值，請加到「允許的值」")


def _int_identifier(name: str, values: list[str], spec: dict[str, Any], summary: dict[str, Any]) -> None:
    present = [v for v in values if v]
    if (spec["type"] == "int" and _ID_NAME.search(name) and summary["missing"] == 0
            and len(set(present)) / max(1, len(present)) >= IDENTIFIER_DISTINCT):
        spec["unique"] = True
        summary["identifier"] = True
        summary["notes"].append("像是識別碼（每列都不同）：設為不可重複，重複的列會被拒絕")


def infer_schema(src: Source, missing_values: list[str] | None = None) -> dict[str, Any]:
    """Infer a schema from a CSV and validate the file against it (dry run, nothing stored)."""
    if missing_values is None:
        missing_values = list(DEFAULT_MISSING_VALUES)
    if not isinstance(missing_values, list) or not all(isinstance(v, str) for v in missing_values):
        raise TabularError("缺值寫法必須是文字清單", code="invalid_missing_values")
    missing_values = [v.strip() for v in missing_values if v.strip()]
    tokens = frozenset(v.casefold() for v in missing_values)

    text, encoding = read_text(src)
    rows = read_rows(text)
    if not rows:
        raise TabularError("檔案是空的，沒有任何欄位或資料", code="empty_file")
    header = [h.strip() for h in rows[0]]
    blank = [str(i + 1) for i, h in enumerate(header) if not h]
    if blank:
        raise TabularError(f"第 {'、'.join(blank)} 欄沒有欄名，請在檔案第一列補上欄名後再上傳",
                           code="blank_column_name", detail={"columns": [int(b) for b in blank]})
    dupes = [h for h in dict.fromkeys(header) if header.count(h) > 1]
    if dupes:
        where = "；".join(f"{h}（第 {'、'.join(str(i + 1) for i, x in enumerate(header) if x == h)} 欄）" for h in dupes)
        raise TabularError(f"欄名重複：{where}，請改成不同名稱後再上傳", code="duplicate_columns",
                           detail={"columns": dupes})
    body = [r for r in rows[1:] if len(r) == len(header)]
    if len(rows) == 1:
        raise TabularError("檔案只有標題列，沒有任何資料列", code="empty_file")

    specs, summaries = [], []
    for j, name in enumerate(header):
        values = [r[j].strip() for r in body]
        spec, summary = _infer_column(name, values, tokens, missing_values)
        _int_identifier(name, [v for v in values if v.casefold() not in tokens], spec, summary)
        summary.update({"type": spec["type"], "required": spec["required"]})
        specs.append(spec)
        summaries.append(summary)

    schema = Schema.from_dict({"columns": specs})
    report, _ = validate_and_load(io.StringIO(text), schema)
    if encoding != "utf-8":
        report["warnings"].insert(0, dict(BIG5_WARNING))
    return {
        "row_count": len(rows) - 1,
        "encoding": encoding,
        "missing_values": missing_values,
        "schema": schema.to_dict(),
        "columns": summaries,
        "report": report,
    }
