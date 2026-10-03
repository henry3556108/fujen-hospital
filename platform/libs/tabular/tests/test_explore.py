"""TC-B04-01 (describe/histogram/preview == pandas), TC-B04-02 (column list + preview slice),
TC-B04-05 (correlation + scatter), TC-B04-08 (non-numeric / all-empty columns)."""

import json

import numpy as np
import pandas as pd
import pytest

from tabular.errors import TabularError
from tabular.explore import (
    column_info,
    correlation,
    describe,
    histogram,
    preview,
    scatter,
    value_counts,
)
from tabular.jsonutil import to_jsonable


def _is_zh(text):
    return any("一" <= ch <= "鿿" for ch in text)


def _strict_json(obj):
    """Fails on NaN/Infinity and numpy types."""
    return json.loads(json.dumps(obj, allow_nan=False))


def test_to_jsonable_converts_numpy_nan_and_timestamps():
    out = to_jsonable({
        "a": np.int64(3), "b": np.float32(1.5), "c": float("nan"), "d": pd.NA,
        "e": pd.Timestamp("2024-01-02"), "f": np.array([1, 2]), "g": (np.bool_(True), None),
        "h": pd.NaT, "i": float("inf"),
    })
    assert out == {"a": 3, "b": 1.5, "c": None, "d": None, "e": "2024-01-02T00:00:00",
                   "f": [1, 2], "g": [True, None], "h": None, "i": None}
    assert type(out["a"]) is int and type(out["b"]) is float and type(out["g"][0]) is bool


def test_describe_numeric_matches_pandas(patients_df):
    result = _strict_json(describe(patients_df))
    assert result["row_count"] == 100
    cols = {c["name"]: c for c in result["columns"]}
    for name in ["age", "bmi", "cholesterol", "time"]:
        ref = patients_df[name].astype("float64").describe()
        got = cols[name]
        assert got["kind"] == "numeric"
        assert got["count"] == int(ref["count"])
        assert got["missing"] == int(patients_df[name].isna().sum())
        assert got["unique"] == int(patients_df[name].nunique())
        for key, pkey in [("mean", "mean"), ("std", "std"), ("min", "min"), ("p25", "25%"),
                          ("p50", "50%"), ("p75", "75%"), ("max", "max")]:
            assert got[key] == ref[pkey], (name, key)


def test_describe_categorical_matches_pandas(patients_df):
    cols = {c["name"]: c for c in describe(patients_df)["columns"]}
    for name in ["sex", "diagnosis", "group", "smoker"]:
        ref = patients_df[name].astype("object").describe()
        got = cols[name]
        assert got["kind"] in ("categorical", "boolean")
        assert got["count"] == ref["count"]
        assert got["unique"] == ref["unique"]
        assert got["top"] == ref["top"]
        assert got["freq"] == ref["freq"]


def test_describe_datetime(patients_df):
    got = {c["name"]: c for c in describe(patients_df)["columns"]}["admit_date"]
    assert got["kind"] == "datetime"
    assert got["min"] == patients_df["admit_date"].min().isoformat()
    assert got["max"] == patients_df["admit_date"].max().isoformat()


def test_describe_all_empty_column_has_none_stats():
    df = pd.DataFrame({"x": [np.nan, np.nan], "y": [1.0, 2.0]})
    got = _strict_json(describe(df))["columns"][0]
    assert got["count"] == 0 and got["missing"] == 2 and got["mean"] is None


def test_histogram_matches_numpy(patients_df):
    result = _strict_json(histogram(patients_df, "bmi", bins=8))
    values = patients_df["bmi"].dropna().to_numpy()
    counts, edges = np.histogram(values, bins=8)
    assert result["counts"] == counts.tolist()
    assert result["edges"] == edges.tolist()
    assert result["missing"] == 6
    assert len(result["bins"]) == 8
    assert result["bins"][0] == {"start": edges[0], "end": edges[1], "count": int(counts[0])}
    assert sum(result["counts"]) == 94


def test_value_counts_for_categorical(patients_df):
    result = _strict_json(value_counts(patients_df, "diagnosis"))
    ref = patients_df["diagnosis"].value_counts()
    assert result["items"] == [{"value": k, "count": int(v)} for k, v in ref.items()]


def test_column_info_lists_all_columns(patients_df):
    info = _strict_json(column_info(patients_df))
    assert [c["name"] for c in info] == list(patients_df.columns)
    kinds = {c["name"]: c["kind"] for c in info}
    assert kinds["age"] == "numeric" and kinds["sex"] == "categorical"
    assert kinds["admit_date"] == "datetime" and kinds["smoker"] == "boolean"


def test_column_info_counts_distinct_values_without_missing(patients_df):
    info = {c["name"]: c for c in column_info(patients_df)}
    assert info["patient_id"]["unique"] == 100
    assert info["sex"]["unique"] == 2
    assert info["bmi"]["unique"] == int(patients_df["bmi"].nunique())


def test_preview_slice_and_visible_columns(patients_df):
    result = _strict_json(preview(patients_df, offset=10, limit=5, columns=["patient_id", "bmi", "admit_date"]))
    assert result["total_rows"] == 100
    assert result["columns"] == ["patient_id", "bmi", "admit_date"]
    assert result["offset"] == 10 and len(result["rows"]) == 5
    ref = patients_df.iloc[10:15]
    assert [r[0] for r in result["rows"]] == ref["patient_id"].tolist()
    assert result["rows"][0][2] == ref["admit_date"].iloc[0].isoformat()


def test_preview_missing_values_are_none(patients_df):
    idx = int(patients_df.index[patients_df["bmi"].isna()][0])
    result = _strict_json(preview(patients_df, offset=idx, limit=1, columns=["bmi"]))
    assert result["rows"] == [[None]]


def test_preview_past_end_is_empty(patients_df):
    assert preview(patients_df, offset=200, limit=10)["rows"] == []


@pytest.mark.parametrize("kwargs", [{"offset": -1, "limit": 5}, {"offset": 0, "limit": 0},
                                    {"offset": 0, "limit": 5, "columns": ["nope"]}])
def test_preview_bad_arguments(patients_df, kwargs):
    with pytest.raises(TabularError) as exc:
        preview(patients_df, **kwargs)
    assert _is_zh(exc.value.message)


@pytest.mark.parametrize("method", ["pearson", "spearman", "kendall"])
def test_correlation_matches_pandas(patients_df, method):
    cols = ["age", "bmi", "cholesterol", "time"]
    result = _strict_json(correlation(patients_df, cols, method=method))
    ref = patients_df[cols].astype("float64").corr(method=method)
    assert result["columns"] == cols and result["method"] == method
    assert np.allclose(np.array(result["matrix"], dtype=float), ref.to_numpy(), atol=1e-12)


def test_correlation_default_uses_numeric_columns(patients_df):
    result = correlation(patients_df)
    assert "sex" not in result["columns"] and "age" in result["columns"]
    assert "smoker" not in result["columns"]


def test_scatter_points(patients_df):
    result = _strict_json(scatter(patients_df, "age", "bmi"))
    both = patients_df[["age", "bmi"]].dropna()
    assert result["total"] == len(both) == result["returned"]
    assert result["sampled"] is False
    assert result["points"][0] == [float(both["age"].iloc[0]), float(both["bmi"].iloc[0])]


def test_scatter_limit_samples_deterministically(patients_df):
    a = scatter(patients_df, "age", "cholesterol", limit=10)
    b = scatter(patients_df, "age", "cholesterol", limit=10)
    assert a["returned"] == 10 and a["sampled"] is True and a == b


# ---- TC-B04-08: non-numeric / all-empty columns to numeric analyses ----

@pytest.fixture
def bad_df(patients_df):
    df = patients_df.copy()
    df["empty"] = np.nan
    return df


@pytest.mark.parametrize(
    "call",
    [
        lambda d: histogram(d, "diagnosis"),
        lambda d: histogram(d, "empty"),
        lambda d: histogram(d, "missing_col"),
        lambda d: correlation(d, ["age", "diagnosis"]),
        lambda d: correlation(d, ["age", "empty"]),
        lambda d: correlation(d, ["age"]),
        lambda d: correlation(d, ["age", "bmi"], method="magic"),
        lambda d: scatter(d, "age", "sex"),
        lambda d: scatter(d, "empty", "age"),
        lambda d: histogram(d, "age", bins=0),
    ],
)
def test_numeric_analyses_reject_bad_columns_with_chinese_message(bad_df, call):
    with pytest.raises(TabularError) as exc:
        call(bad_df)
    assert _is_zh(exc.value.message)
    json.dumps(exc.value.to_dict(), allow_nan=False)


def test_json_safe_no_nan_anywhere(patients_df):
    for obj in [describe(patients_df), preview(patients_df, 0, 100), correlation(patients_df)]:
        text = json.dumps(obj, allow_nan=False)
        assert "NaN" not in text
