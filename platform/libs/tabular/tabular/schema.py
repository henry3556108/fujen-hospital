"""Column schema for CSV upload validation.

Format (dict / JSON)::

    {"columns": [
        {"name": "age", "type": "int", "required": true, "min": 0, "max": 120,
         "allowed": null, "unique": false},
        ...
    ]}

``type`` is one of int | float | str | category | date | bool.
``required`` means the column must exist in the file and every value must be non-empty.
Non-required columns may be absent from the file and may contain empty values.
``min``/``max`` apply to int, float and date (ISO ``YYYY-MM-DD``) columns.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import date
from typing import Any

from tabular.errors import TabularError

COLUMN_TYPES = ("int", "float", "str", "category", "date", "bool")


@dataclass(frozen=True)
class ColumnSpec:
    name: str
    type: str
    required: bool = True
    min: Any = None
    max: Any = None
    allowed: list[Any] | None = None
    unique: bool = False

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ColumnSpec":
        if not isinstance(data, dict) or not data.get("name"):
            raise TabularError("欄位定義缺少名稱（name）", code="schema_invalid")
        name = str(data["name"])
        ctype = data.get("type")
        if ctype not in COLUMN_TYPES:
            raise TabularError(
                f"欄位「{name}」的型別「{ctype}」不支援，可用型別：{', '.join(COLUMN_TYPES)}",
                code="schema_invalid",
                detail={"column": name},
            )
        lo, hi = data.get("min"), data.get("max")
        if lo is not None and hi is not None:
            try:
                bad = _bound(ctype, lo) > _bound(ctype, hi)
            except (TypeError, ValueError):
                raise TabularError(f"欄位「{name}」的 min/max 格式錯誤", code="schema_invalid") from None
            if bad:
                raise TabularError(f"欄位「{name}」的 min 大於 max", code="schema_invalid")
        allowed = data.get("allowed")
        if allowed is not None and not isinstance(allowed, list):
            raise TabularError(f"欄位「{name}」的 allowed 必須是清單", code="schema_invalid")
        return cls(
            name=name,
            type=ctype,
            required=bool(data.get("required", True)),
            min=lo,
            max=hi,
            allowed=list(allowed) if allowed is not None else None,
            unique=bool(data.get("unique", False)),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "type": self.type,
            "required": self.required,
            "min": self.min,
            "max": self.max,
            "allowed": self.allowed,
            "unique": self.unique,
        }


def _bound(ctype: str, value: Any) -> Any:
    if ctype == "date":
        return date.fromisoformat(str(value))
    return float(value)


@dataclass(frozen=True)
class Schema:
    columns: list[ColumnSpec] = field(default_factory=list)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Schema":
        if not isinstance(data, dict) or not isinstance(data.get("columns"), list) or not data["columns"]:
            raise TabularError("結構定義必須包含至少一個欄位（columns）", code="schema_invalid")
        cols = [ColumnSpec.from_dict(c) for c in data["columns"]]
        names = [c.name for c in cols]
        dupes = sorted({n for n in names if names.count(n) > 1})
        if dupes:
            raise TabularError(f"結構定義中欄位名稱重複：{', '.join(dupes)}", code="schema_invalid")
        return cls(columns=cols)

    @classmethod
    def from_json(cls, text: str) -> "Schema":
        try:
            data = json.loads(text)
        except json.JSONDecodeError as exc:
            raise TabularError(f"結構定義不是有效的 JSON：{exc.msg}", code="schema_invalid") from None
        return cls.from_dict(data)

    def to_dict(self) -> dict[str, Any]:
        return {"columns": [c.to_dict() for c in self.columns]}

    @property
    def names(self) -> list[str]:
        return [c.name for c in self.columns]

    def column(self, name: str) -> ColumnSpec:
        for c in self.columns:
            if c.name == name:
                return c
        raise TabularError(f"結構定義中沒有欄位「{name}」", code="column_not_found", detail={"column": name})
