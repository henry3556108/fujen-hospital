import json

import pytest

from tabular.errors import TabularError
from tabular.schema import ColumnSpec, Schema


def test_schema_from_dict_parses_columns(schema_dict):
    schema = Schema.from_dict(schema_dict)
    assert [c.name for c in schema.columns][:3] == ["patient_id", "age", "sex"]
    pid = schema.column("patient_id")
    assert pid.type == "int" and pid.unique and pid.required and pid.min == 1
    assert schema.column("sex").allowed == ["M", "F"]
    assert schema.column("bmi").required is False


def test_schema_json_round_trip(schema_dict):
    schema = Schema.from_json(json.dumps(schema_dict))
    again = Schema.from_dict(json.loads(json.dumps(schema.to_dict())))
    assert again == schema


def test_column_defaults():
    spec = ColumnSpec.from_dict({"name": "x", "type": "str"})
    assert spec.required is True and spec.unique is False
    assert spec.min is None and spec.max is None and spec.allowed is None


@pytest.mark.parametrize(
    "bad",
    [
        {"columns": [{"name": "x", "type": "complex"}]},
        {"columns": [{"type": "int"}]},
        {"columns": []},
        {"columns": [{"name": "x", "type": "int"}, {"name": "x", "type": "int"}]},
        {"columns": [{"name": "x", "type": "int", "min": 5, "max": 1}]},
        {},
    ],
)
def test_invalid_schema_raises_tabular_error_in_chinese(bad):
    with pytest.raises(TabularError) as exc:
        Schema.from_dict(bad)
    assert any("一" <= ch <= "鿿" for ch in exc.value.message)


def test_tabular_error_to_dict():
    err = TabularError("欄位不存在", code="column_not_found", detail={"column": "x"})
    assert err.to_dict() == {
        "code": "column_not_found",
        "message": "欄位不存在",
        "detail": {"column": "x"},
    }
    assert str(err) == "欄位不存在"
