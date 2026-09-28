"""TC-B01-10: CSV upload validation (3 good files x 100 rows, bad.csv 100% intercepted)."""

import io
import json

import pandas as pd
import pytest

from fixtures.generate import HEADER, make_rows, to_csv_text
from tabular.errors import TabularError
from tabular.schema import Schema
from tabular.validate import load_clean_csv, validate_and_load, validate_csv


@pytest.fixture
def schema(schema_dict):
    return Schema.from_dict(schema_dict)


def _is_zh(text: str) -> bool:
    return any("一" <= ch <= "鿿" for ch in text)


@pytest.mark.parametrize("seed", [0, 1, 2])
def test_three_good_files_of_100_rows_accepted(tmp_path, schema, seed):
    path = tmp_path / f"good_{seed}.csv"
    path.write_text(to_csv_text(make_rows(seed=seed)), encoding="utf-8")
    report = validate_csv(path, schema)
    assert report["valid_rows"] == 100
    assert report["total_rows"] == 100
    assert report["rejected"] == []
    assert report["errors"] == []
    assert report["columns"] == HEADER
    json.dumps(report)  # JSON serialisable


def test_committed_fixture_is_valid(patients_csv, schema):
    assert validate_csv(patients_csv, schema)["valid_rows"] == 100


# Each entry: (mutation applied to a good row as dict -> list or raw line, expected column)
BAD_CASES = {
    3: ("age", "abc"),               # not an int
    7: ("age", "150"),               # above max
    11: ("sex", "X"),                # not allowed
    15: ("cholesterol", ""),         # required empty
    19: ("admit_date", "2024-13-40"),  # invalid date
    23: ("smoker", "maybe"),         # invalid bool
    27: ("bmi", "nan"),              # NaN text in float column
    31: ("outcome", "2"),            # not in allowed values
    35: ("time", "-1"),              # below min
    39: ("patient_id", "1"),         # duplicate of row 0
    43: ("bmi", "5"),                # below min (optional column, still checked)
    47: ("admit_date", "2019-12-31"),  # below date min
    51: ("age", "3.5"),              # float in int column
    55: ("bmi", "inf"),              # infinity
}
TOO_MANY_FIELDS = 60
TOO_FEW_FIELDS = 64


def _bad_csv_text() -> str:
    rows = make_rows(seed=0)
    for idx, (col, value) in BAD_CASES.items():
        rows[idx][HEADER.index(col)] = value
    rows[TOO_MANY_FIELDS] = rows[TOO_MANY_FIELDS] + ["extra"]
    rows[TOO_FEW_FIELDS] = rows[TOO_FEW_FIELDS][:5]
    return to_csv_text(rows)


def test_bad_csv_all_broken_rows_intercepted_and_none_false_accepted(schema):
    report = validate_csv(io.StringIO(_bad_csv_text()), schema)
    expected_bad = set(BAD_CASES) | {TOO_MANY_FIELDS, TOO_FEW_FIELDS}
    rejected_rows = {r["row"] for r in report["rejected"]}
    assert rejected_rows == expected_bad
    assert report["rejected_row_count"] == len(expected_bad)
    assert report["valid_rows"] == 100 - len(expected_bad)
    for r in report["rejected"]:
        assert _is_zh(r["reason"])
        if r["row"] in BAD_CASES:
            assert r["column"] == BAD_CASES[r["row"]][0]


def test_rejected_rows_never_enter_clean_frame(schema):
    df = load_clean_csv(io.StringIO(_bad_csv_text()), schema)
    assert len(df) == 100 - len(BAD_CASES) - 2
    bad_ids = {i + 1 for i in list(BAD_CASES) + [TOO_MANY_FIELDS, TOO_FEW_FIELDS] if i != 39}
    assert bad_ids.isdisjoint(set(df["patient_id"]))
    assert (df["patient_id"] == 1).sum() == 1  # first occurrence kept, duplicate rejected
    assert list(df.index) == list(range(len(df)))


def test_clean_frame_has_typed_columns(patients_df):
    df = patients_df
    assert pd.api.types.is_integer_dtype(df["age"])
    assert pd.api.types.is_float_dtype(df["bmi"])
    assert df["bmi"].isna().sum() == 6
    assert pd.api.types.is_bool_dtype(df["smoker"])
    assert pd.api.types.is_datetime64_any_dtype(df["admit_date"])
    assert isinstance(df["sex"].dtype, pd.CategoricalDtype)
    assert df["diagnosis"].map(type).eq(str).all()


def test_missing_required_column_is_file_level_error(schema):
    rows = [r[1:] for r in make_rows(seed=0, n=5)]
    report = validate_csv(io.StringIO(to_csv_text(rows, HEADER[1:])), schema)
    assert report["valid_rows"] == 0
    assert [e["code"] for e in report["errors"]] == ["missing_required_columns"]
    assert "patient_id" in report["errors"][0]["message"]
    with pytest.raises(TabularError) as exc:
        load_clean_csv(io.StringIO(to_csv_text(rows, HEADER[1:])), schema)
    assert exc.value.code == "missing_required_columns"


def test_optional_column_may_be_absent(schema):
    idx = HEADER.index("bmi")
    header = HEADER[:idx] + HEADER[idx + 1:]
    rows = [r[:idx] + r[idx + 1:] for r in make_rows(seed=0, n=5)]
    report, df = validate_and_load(io.StringIO(to_csv_text(rows, header)), schema)
    assert report["valid_rows"] == 5 and report["errors"] == []
    assert "bmi" not in df.columns


def test_unknown_extra_column_is_warning_and_dropped(schema):
    rows = [r + ["x"] for r in make_rows(seed=0, n=5)]
    report, df = validate_and_load(io.StringIO(to_csv_text(rows, HEADER + ["mystery"])), schema)
    assert report["valid_rows"] == 5
    assert [w["code"] for w in report["warnings"]] == ["unknown_columns"]
    assert "mystery" in report["warnings"][0]["message"]
    assert "mystery" not in df.columns


@pytest.mark.parametrize("text", ["", "   \n", "﻿"])
def test_empty_file_is_file_level_error(schema, text):
    report = validate_csv(io.StringIO(text), schema)
    assert [e["code"] for e in report["errors"]] == ["empty_file"]
    assert _is_zh(report["errors"][0]["message"])


def test_header_only_file_is_empty_error(schema):
    report = validate_csv(io.StringIO(",".join(HEADER) + "\n"), schema)
    assert [e["code"] for e in report["errors"]] == ["empty_file"]


def test_accepts_bytes_buffer_with_bom(schema):
    data = ("﻿" + to_csv_text(make_rows(seed=0, n=3))).encode("utf-8")
    report = validate_csv(io.BytesIO(data), schema)
    assert report["valid_rows"] == 3 and report["columns"][0] == "patient_id"


def test_duplicate_header_is_file_level_error(schema):
    text = ",".join(HEADER + ["age"]) + "\n" + ",".join(make_rows(n=1)[0] + ["30"]) + "\n"
    report = validate_csv(io.StringIO(text), schema)
    assert [e["code"] for e in report["errors"]] == ["duplicate_columns"]
