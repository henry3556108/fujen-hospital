"""Target / Feature / preprocessing-step settings for a modeling job.

Serialised form (``to_dict``)::

    {"version": 1, "target": "outcome", "features": ["age", "bmi"],
     "steps": [{"id": "impute_mean", "columns": ["bmi"], "params": {}}]}

Steps are normalised on construction (defaults filled), so
``from_dict(to_dict(cfg)) == cfg`` and the dict is stable across reloads.
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from typing import Any

from tabular.errors import TabularError
from tabular.preprocess import validate_steps

CONFIG_VERSION = 1


class TargetFeatureConfig:
    def __init__(self, target: str, features: list[str], steps: list[dict[str, Any]] | None = None):
        if not isinstance(target, str) or not target:
            raise TabularError("請指定目標欄位（Target）", code="invalid_config")
        if not isinstance(features, list) or not all(isinstance(f, str) and f for f in features):
            raise TabularError("特徵欄位（Features）必須是欄位名稱清單", code="invalid_config")
        if not features:
            raise TabularError("請至少選擇一個特徵欄位（Feature）", code="invalid_config")
        dupes = sorted({f for f in features if features.count(f) > 1})
        if dupes:
            raise TabularError(f"特徵欄位重複：{'、'.join(dupes)}", code="invalid_config")
        if target in features:
            raise TabularError(f"目標欄位「{target}」不可同時作為特徵欄位", code="invalid_config")
        self.target = target
        self.features = list(features)
        self.steps = validate_steps(steps or [])

    def __eq__(self, other: object) -> bool:
        return isinstance(other, TargetFeatureConfig) and self.to_dict() == other.to_dict()

    def __repr__(self) -> str:
        return f"TargetFeatureConfig(target={self.target!r}, features={self.features!r}, steps={self.steps!r})"

    def to_dict(self) -> dict[str, Any]:
        return {
            "version": CONFIG_VERSION,
            "target": self.target,
            "features": list(self.features),
            "steps": json.loads(json.dumps(self.steps)),
        }

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), ensure_ascii=False, sort_keys=True)

    @classmethod
    def from_dict(cls, data: Any) -> "TargetFeatureConfig":
        if not isinstance(data, dict) or "target" not in data or "features" not in data:
            raise TabularError("設定格式錯誤：必須包含 target 與 features", code="invalid_config")
        version = data.get("version", CONFIG_VERSION)
        if version != CONFIG_VERSION:
            raise TabularError(f"不支援的設定版本：{version}", code="invalid_config")
        return cls(data["target"], data["features"], data.get("steps") or [])

    @classmethod
    def from_json(cls, text: str) -> "TargetFeatureConfig":
        try:
            data = json.loads(text)
        except json.JSONDecodeError as exc:
            raise TabularError(f"設定不是有效的 JSON：{exc.msg}", code="invalid_config") from None
        return cls.from_dict(data)

    def validate_against(self, columns: Iterable[str]) -> None:
        """Check that target and features exist (step columns may be created by earlier steps)."""
        available = set(map(str, columns))
        missing = [c for c in [self.target, *self.features] if c not in available]
        if missing:
            raise TabularError(f"資料中找不到欄位：{'、'.join(missing)}", code="column_not_found",
                               detail={"columns": missing})
