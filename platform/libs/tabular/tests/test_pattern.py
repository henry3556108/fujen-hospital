"""欄位格式（pattern）：病歷號、檢查編號等必須符合固定格式。"""
import io

import pytest

from tabular.errors import TabularError
from tabular.schema import ColumnSpec, Schema
from tabular.validate import validate_csv

SCHEMA = Schema.from_dict({"columns": [
    {"name": "patient_id", "type": "str", "required": True, "pattern": r"^P\d{5}$"},
    {"name": "accession", "type": "str", "required": False, "pattern": r"^ACC\d{4}$"},
]})


def test_pattern_rejects_non_matching_values():
    csv_text = "patient_id,accession\nP00001,ACC0001\nX1,ACC0002\nP00003,BAD\nP00004,\n"
    report = validate_csv(io.BytesIO(csv_text.encode()), SCHEMA)
    assert report["valid_rows"] == 2
    assert sorted(r["row"] for r in report["rejected"]) == [1, 2]
    assert all("格式" in r["reason"] for r in report["rejected"])


def test_pattern_round_trips_and_invalid_regex_is_schema_error():
    spec = ColumnSpec.from_dict({"name": "id", "type": "str", "pattern": r"^\d+$"})
    assert ColumnSpec.from_dict(spec.to_dict()) == spec
    with pytest.raises(TabularError):
        ColumnSpec.from_dict({"name": "id", "type": "str", "pattern": "("})
