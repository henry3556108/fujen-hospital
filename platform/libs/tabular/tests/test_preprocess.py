"""TC-B04-04 (imputation / One-Hot == scikit-learn) and TC-B04-06 (>= 50 preprocessing methods,
catalogue identical to the documented list). Every registered step has a concrete-effect test."""

import json
import re
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
import pytest
from sklearn.impute import KNNImputer, SimpleImputer
from sklearn.preprocessing import OneHotEncoder, OrdinalEncoder, PowerTransformer

from tabular.errors import TabularError
from tabular.preprocess import CATEGORIES, apply_pipeline, catalogue, validate_steps

README = Path(__file__).parents[1] / "README.md"


def _is_zh(text):
    return any("一" <= ch <= "鿿" for ch in text)


def make_frame() -> pd.DataFrame:
    """12 rows; row 11 is an exact duplicate of row 1; ``num`` has a NaN (row 2) and an outlier."""
    pos = [1.0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 2]
    dates = [datetime(2024, 1, 15) + timedelta(days=31 * k) for k in range(11)]
    dates.append(dates[1])
    return pd.DataFrame({
        "num": [1.0, 2, np.nan, 4, 5, 6, 7, 8, 9, 10, 1000, 2],
        "pos": pos,
        "neg": [-5.0, -3, -1, 0, 1, 2, 3, 4, 5, 6, 7, -3],
        "frac": [p / 3 for p in pos],
        "cat": ["a", "b", "a", "c", "b", "a", "a", "c", "b", "a", "c", "b"],
        "catna": ["a", None, "b", "a", "b", None, "a", "b", "a", "a", "b", None],
        "text": ["  Foo ", "BAR", "baz ", " Qux", "foo", "bar", "baz", "qux", "Foo", "bar", "x", "BAR"],
        "numstr": ["1", "2", "x", "4", "5", "6", "7", "8", "9", "10", "11", "2"],
        "datestr": [d.strftime("%Y-%m-%d") for d in dates],
        "date": pd.to_datetime(dates),
        "const": [7] * 12,
        "flag": ["yes", "no", "yes", "yes", "no", "no", "yes", "no", "yes", "yes", "no", "no"],
    })


def close(a, b):
    return np.allclose(np.asarray(a, dtype=float), np.asarray(b, dtype=float), atol=1e-9, equal_nan=True)


# id -> (columns, params, check(before, after))
CASES = {
    # --- imputation ---
    "impute_mean": (["num"], {}, lambda b, a: a.num.isna().sum() == 0 and close(a.num[2], b.num.mean())),
    "impute_median": (["num"], {}, lambda b, a: close(a.num[2], b.num.median())),
    "impute_most_frequent": (["catna"], {}, lambda b, a: a.catna.isna().sum() == 0 and a.catna[1] == "a"),
    "impute_constant": (["num"], {"fill_value": -1}, lambda b, a: a.num[2] == -1),
    "impute_knn": (["num", "pos"], {"n_neighbors": 2},
                   lambda b, a: close(a[["num", "pos"]], KNNImputer(n_neighbors=2).fit_transform(b[["num", "pos"]]))),
    "impute_ffill": (["num"], {}, lambda b, a: a.num[2] == 2),
    "impute_bfill": (["num"], {}, lambda b, a: a.num[2] == 4),
    "impute_interpolate": (["num"], {}, lambda b, a: a.num[2] == 3),
    "drop_missing_rows": (["num"], {}, lambda b, a: len(a) == 11 and a.num.notna().all()),
    "drop_columns_missing_ratio": ([], {"threshold": 0.2}, lambda b, a: "catna" not in a and "num" in a),
    "add_missing_indicator": (["num"], {}, lambda b, a: a["num_missing"].tolist() == [0, 0, 1] + [0] * 9),
    # --- scaling / transforms ---
    "scale_standard": (["pos"], {}, lambda b, a: close(a.pos.mean(), 0) and close(a.pos.std(ddof=0), 1)),
    "scale_minmax": (["pos"], {}, lambda b, a: a.pos.min() == 0 and a.pos.max() == 1),
    "scale_maxabs": (["neg"], {}, lambda b, a: close(a.neg.abs().max(), 1) and close(a.neg[0], -5 / 7)),
    "scale_robust": (["pos"], {}, lambda b, a: close(a.pos.median(), 0)),
    "normalize_l1": (["pos", "neg"], {}, lambda b, a: close(a[["pos", "neg"]].abs().sum(axis=1), 1)),
    "normalize_l2": (["pos", "neg"], {}, lambda b, a: close((a[["pos", "neg"]] ** 2).sum(axis=1), 1)),
    "normalize_max": (["pos", "neg"], {}, lambda b, a: close(a[["pos", "neg"]].abs().max(axis=1), 1)),
    "quantile_uniform": (["pos"], {"n_quantiles": 12}, lambda b, a: a.pos.min() == 0 and a.pos.max() == 1),
    "quantile_normal": (["pos"], {"n_quantiles": 12},
                        lambda b, a: (a.pos.rank() == b.pos.rank()).all() and abs(a.pos.median()) < 0.5),
    "power_yeo_johnson": (["neg"], {}, lambda b, a: close(
        a.neg, PowerTransformer(method="yeo-johnson").fit_transform(b[["neg"]]).ravel())),
    "power_box_cox": (["pos"], {}, lambda b, a: close(
        a.pos, PowerTransformer(method="box-cox").fit_transform(b[["pos"]]).ravel())),
    "log1p": (["pos"], {}, lambda b, a: close(a.pos, np.log1p(b.pos))),
    "log": (["pos"], {}, lambda b, a: close(a.pos, np.log(b.pos))),
    "log10": (["pos"], {}, lambda b, a: close(a.pos, np.log10(b.pos))),
    "sqrt": (["pos"], {}, lambda b, a: close(a.pos, np.sqrt(b.pos))),
    "square": (["neg"], {}, lambda b, a: close(a.neg, b.neg ** 2)),
    "reciprocal": (["pos"], {}, lambda b, a: close(a.pos, 1 / b.pos)),
    "scale_zscore_clip": (["num"], {"threshold": 2.5},
                          lambda b, a: close(a.num.max(), 2.5) and a.num.min() < 0 and a.num.isna().sum() == 1),
    "clip_values": (["num"], {"lower": 0, "upper": 10}, lambda b, a: a.num.max() == 10 and a.num.min() == 1),
    # --- encoding ---
    "onehot": (["cat"], {}, lambda b, a: "cat" not in a and {"cat_a", "cat_b", "cat_c"} <= set(a)
               and (a[["cat_a", "cat_b", "cat_c"]].sum(axis=1) == 1).all()),
    "ordinal": (["cat"], {}, lambda b, a: a.cat.tolist() == [0, 1, 0, 2, 1, 0, 0, 2, 1, 0, 2, 1]),
    "label": (["cat"], {}, lambda b, a: a.cat.tolist() == [0, 1, 0, 2, 1, 0, 0, 2, 1, 0, 2, 1]),
    "frequency": (["cat"], {}, lambda b, a: close(a.cat[0], 5 / 12) and close(a.cat[3], 3 / 12)),
    "count": (["cat"], {}, lambda b, a: a.cat[0] == 5 and a.cat[1] == 4),
    "binary_map": (["flag"], {"positive": "yes"}, lambda b, a: a.flag.tolist() == (b.flag == "yes").astype(int).tolist()),
    # --- discretization ---
    "kbins_uniform": (["pos"], {"n_bins": 3}, lambda b, a: set(a.pos) == {0, 1, 2} and a.pos[0] == 0 and a.pos[10] == 2),
    "kbins_quantile": (["pos"], {"n_bins": 3}, lambda b, a: set(a.pos) == {0, 1, 2}),
    "kbins_kmeans": (["pos"], {"n_bins": 3}, lambda b, a: set(a.pos) == {0, 1, 2}),
    "binarize": (["neg"], {"threshold": 0}, lambda b, a: a.neg.tolist() == (b.neg > 0).astype(int).tolist()),
    # --- outliers ---
    "iqr_clip": (["num"], {}, lambda b, a: a.num.max() < 1000 and len(a) == 12),
    "iqr_remove": (["num"], {}, lambda b, a: len(a) == 11 and 1000 not in a.num.tolist() and a.num.isna().sum() == 1),
    "zscore_clip": (["num"], {"threshold": 2.5}, lambda b, a: a.num.max() < 1000 and len(a) == 12),
    "zscore_remove": (["num"], {"threshold": 2.5}, lambda b, a: len(a) == 11 and a.num.max() == 10),
    "winsorize_1": (["pos"], {}, lambda b, a: close(a.pos.max(), b.pos.quantile(0.99))
                    and close(a.pos.min(), b.pos.quantile(0.01))),
    "winsorize_5": (["pos"], {}, lambda b, a: close(a.pos.max(), b.pos.quantile(0.95))),
    # --- feature engineering ---
    "polynomial_2": (["pos", "neg"], {}, lambda b, a: close(a["pos^2"], b.pos ** 2)
                     and close(a["pos neg"], b.pos * b.neg) and "pos" in a),
    "interaction_terms": (["pos", "neg"], {}, lambda b, a: close(a["pos neg"], b.pos * b.neg) and "pos^2" not in a),
    "pca": (["pos", "neg", "frac"], {"n_components": 2},
            lambda b, a: {"PC1", "PC2"} <= set(a) and "pos" not in a and "PC3" not in a),
    # --- cleaning ---
    "drop_duplicate_rows": ([], {}, lambda b, a: len(a) == 11 and list(a.index) == list(range(11))),
    "drop_constant_columns": ([], {}, lambda b, a: "const" not in a and len(a.columns) == len(b.columns) - 1),
    "strip_text": (["text"], {}, lambda b, a: a.text[0] == "Foo" and a.text[3] == "Qux"),
    "lower_text": (["text"], {}, lambda b, a: a.text[1] == "bar"),
    "upper_text": (["text"], {}, lambda b, a: a.text[2] == "BAZ "),
    "replace_value": (["cat"], {"to_replace": "a", "value": "z"},
                      lambda b, a: "a" not in set(a.cat) and (a.cat == "z").sum() == 5),
    "to_numeric": (["numstr"], {}, lambda b, a: pd.api.types.is_numeric_dtype(a.numstr) and np.isnan(a.numstr[2])),
    "to_datetime": (["datestr"], {}, lambda b, a: pd.api.types.is_datetime64_any_dtype(a.datestr)),
    "extract_year": (["date"], {}, lambda b, a: a["date_year"][0] == 2024 and "date" in a),
    "extract_month": (["date"], {}, lambda b, a: a["date_month"][0] == 1 and a["date_month"][1] == 2),
    "extract_day": (["date"], {}, lambda b, a: a["date_day"][0] == 15),
    "extract_weekday": (["date"], {}, lambda b, a: a["date_weekday"][0] == 0),  # 2024-01-15 is a Monday
    "rename_columns": ([], {"mapping": {"num": "number"}}, lambda b, a: "number" in a and "num" not in a),
    "drop_columns": (["const", "flag"], {}, lambda b, a: "const" not in a and "flag" not in a and "num" in a),
    "select_columns": (["num", "cat"], {}, lambda b, a: list(a.columns) == ["num", "cat"]),
    "cast_type": (["pos"], {"dtype": "int"}, lambda b, a: pd.api.types.is_integer_dtype(a.pos)),
    "round": (["frac"], {"decimals": 2}, lambda b, a: a.frac[0] == 0.33),
}


def test_catalogue_has_at_least_50_methods():
    ids = [s["id"] for s in catalogue()]
    assert len(ids) >= 50
    assert len(ids) == len(set(ids))


def test_catalogue_entries_are_complete_and_json_safe():
    items = catalogue()
    json.dumps(items, allow_nan=False)
    for item in items:
        assert set(item) >= {"id", "name_zh", "category", "category_zh", "params", "column_types"}
        assert _is_zh(item["name_zh"]) and _is_zh(item["category_zh"])
        assert item["category"] in CATEGORIES
        assert item["params"]["type"] == "object"
        assert isinstance(item["params"]["properties"], dict)
        assert item["column_types"] and set(item["column_types"]) <= {
            "numeric", "categorical", "text", "datetime", "boolean", "any"}


def test_every_registered_step_has_a_test_case():
    assert {s["id"] for s in catalogue()} == set(CASES)


def test_catalogue_matches_readme_list():
    """TC-B04-06: 與文件清單差異 0."""
    text = README.read_text(encoding="utf-8")
    block = re.search(r"<!-- catalogue:start -->(.*?)<!-- catalogue:end -->", text, re.S).group(1)
    documented = re.findall(r"^\| `([a-z0-9_]+)` \|", block, re.M)
    assert documented == [s["id"] for s in catalogue()]
    assert f"共 {len(documented)} 種" in text


@pytest.mark.parametrize("step_id", sorted(CASES))
def test_step_applies_with_concrete_effect(step_id):
    columns, params, check = CASES[step_id]
    before = make_frame()
    after = apply_pipeline(before.copy(), [{"id": step_id, "columns": columns, "params": params}])
    assert isinstance(after, pd.DataFrame)
    pd.testing.assert_frame_equal(before, make_frame())  # input untouched
    assert check(before, after), step_id


# ---- TC-B04-04: reference outputs from scikit-learn ----

def test_impute_mean_matches_sklearn(patients_df):
    out = apply_pipeline(patients_df, [{"id": "impute_mean", "columns": ["bmi"]}])
    ref = SimpleImputer(strategy="mean").fit_transform(patients_df[["bmi"]]).ravel()
    assert np.allclose(out["bmi"].to_numpy(), ref, atol=1e-12)


def test_impute_median_matches_sklearn(patients_df):
    out = apply_pipeline(patients_df, [{"id": "impute_median", "columns": ["bmi"]}])
    ref = SimpleImputer(strategy="median").fit_transform(patients_df[["bmi"]]).ravel()
    assert np.allclose(out["bmi"].to_numpy(), ref, atol=1e-12)


def test_onehot_matches_sklearn(patients_df):
    out = apply_pipeline(patients_df, [{"id": "onehot", "columns": ["diagnosis", "sex"]}])
    enc = OneHotEncoder(sparse_output=False)
    ref = enc.fit_transform(patients_df[["diagnosis", "sex"]].astype(object))
    names = list(enc.get_feature_names_out(["diagnosis", "sex"]))
    assert np.array_equal(out[names].to_numpy(dtype=float), ref)
    assert "diagnosis" not in out and "sex" not in out and "age" in out


def test_onehot_drop_first_matches_sklearn():
    df = make_frame()
    out = apply_pipeline(df, [{"id": "onehot", "columns": ["cat"], "params": {"drop_first": True}}])
    enc = OneHotEncoder(sparse_output=False, drop="first")
    ref = enc.fit_transform(df[["cat"]])
    assert np.array_equal(out[list(enc.get_feature_names_out(["cat"]))].to_numpy(dtype=float), ref)
    assert "cat_a" not in out


def test_ordinal_matches_sklearn():
    df = make_frame()
    out = apply_pipeline(df, [{"id": "ordinal", "columns": ["cat", "flag"]}])
    ref = OrdinalEncoder().fit_transform(df[["cat", "flag"]])
    assert np.array_equal(out[["cat", "flag"]].to_numpy(dtype=float), ref)


def test_impute_then_onehot_pipeline(patients_df):
    df = patients_df.copy()
    df.loc[[0, 5], "diagnosis"] = None
    out = apply_pipeline(df, [
        {"id": "impute_most_frequent", "columns": ["diagnosis"]},
        {"id": "impute_mean", "columns": ["bmi"]},
        {"id": "onehot", "columns": ["diagnosis"]},
    ])
    assert out["bmi"].isna().sum() == 0
    assert not any(c.endswith("_nan") or c.endswith("_None") for c in out.columns)
    assert len(out) == 100


def test_auto_selects_applicable_columns_when_columns_empty():
    out = apply_pipeline(make_frame(), [{"id": "scale_minmax"}])
    assert close(out.pos.max(), 1) and close(out.neg.max(), 1)
    assert out.cat.tolist() == make_frame().cat.tolist()


# ---- errors ----

@pytest.mark.parametrize(
    "steps",
    [
        [{"id": "no_such_step"}],
        [{"id": "scale_standard", "columns": ["text"]}],
        [{"id": "scale_standard", "columns": ["missing"]}],
        [{"id": "impute_constant", "columns": ["num"], "params": {"bogus": 1}}],
        [{"id": "kbins_uniform", "columns": ["pos"], "params": {"n_bins": "three"}}],
        [{"id": "kbins_uniform", "columns": ["pos"], "params": {"n_bins": 1}}],
        [{"id": "power_box_cox", "columns": ["neg"]}],
        [{"id": "log", "columns": ["neg"]}],
        [{"id": "normalize_l2", "columns": ["num", "pos"]}],
        [{"id": "impute_mean", "columns": ["empty"]}],
        [{"id": "drop_columns"}],
        [{"id": "cast_type", "columns": ["text"], "params": {"dtype": "int"}}],
        [{"id": "cast_type", "columns": ["pos"], "params": {"dtype": "complex"}}],
        [{"columns": ["num"]}],
        "not a list",
    ],
)
def test_bad_steps_raise_tabular_error_in_chinese(steps):
    df = make_frame()
    df["empty"] = np.nan
    with pytest.raises(TabularError) as exc:
        apply_pipeline(df, steps)
    assert _is_zh(exc.value.message)


def test_validate_steps_without_data_fills_defaults():
    steps = validate_steps([{"id": "impute_knn", "columns": ["a"]}])
    assert steps == [{"id": "impute_knn", "columns": ["a"], "params": {"n_neighbors": 5}}]
