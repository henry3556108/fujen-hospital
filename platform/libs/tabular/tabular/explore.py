"""Exploration: descriptive statistics, distributions, preview, correlation, scatter.

Every function returns JSON-serialisable dicts/lists (NaN -> None).
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd

from tabular.columns import column_kind, numeric_frame, numeric_series, require_columns
from tabular.errors import TabularError
from tabular.jsonutil import to_jsonable

PREVIEW_MAX_LIMIT = 1000
CORRELATION_METHODS = ("pearson", "spearman", "kendall")


def column_info(df: pd.DataFrame) -> list[dict[str, Any]]:
    """Column list for the show/hide UI: name, dtype, kind, missing count."""
    return to_jsonable([
        {"name": str(c), "dtype": str(df[c].dtype), "kind": column_kind(df[c]), "missing": int(df[c].isna().sum())}
        for c in df.columns
    ])


def _describe_column(name: str, s: pd.Series) -> dict[str, Any]:
    kind = column_kind(s)
    out: dict[str, Any] = {
        "name": str(name),
        "dtype": str(s.dtype),
        "kind": kind,
        "count": int(s.count()),
        "missing": int(s.isna().sum()),
        "unique": int(s.nunique()),
    }
    if kind == "numeric":
        ref = s.astype("float64").describe()
        out.update({
            "mean": ref["mean"], "std": ref["std"], "min": ref["min"], "p25": ref["25%"],
            "p50": ref["50%"], "p75": ref["75%"], "max": ref["max"],
        })
    elif kind == "datetime":
        out.update({"min": s.min(), "max": s.max()})
    else:
        non_null = s.dropna().astype("object")
        if len(non_null):
            ref = non_null.describe()
            out.update({"top": ref["top"], "freq": int(ref["freq"])})
        else:
            out.update({"top": None, "freq": 0})
    return out


def describe(df: pd.DataFrame) -> dict[str, Any]:
    """Per-column descriptive statistics, numerically identical to ``pandas.Series.describe``."""
    return to_jsonable({
        "row_count": int(len(df)),
        "columns": [_describe_column(c, df[c]) for c in df.columns],
    })


def histogram(df: pd.DataFrame, column: str, bins: int = 10) -> dict[str, Any]:
    """Histogram of a numeric column (``numpy.histogram`` on non-missing values)."""
    if not isinstance(bins, int) or isinstance(bins, bool) or bins < 1:
        raise TabularError("分組數（bins）必須是大於 0 的整數", code="invalid_argument")
    s = numeric_series(df, column)
    values = s.dropna().to_numpy()
    counts, edges = np.histogram(values, bins=bins)
    return to_jsonable({
        "column": column,
        "counts": counts,
        "edges": edges,
        "missing": int(s.isna().sum()),
        "bins": [
            {"start": edges[i], "end": edges[i + 1], "count": counts[i]} for i in range(len(counts))
        ],
    })


def value_counts(df: pd.DataFrame, column: str, limit: int = 50) -> dict[str, Any]:
    """Frequency distribution for categorical/text columns (bar chart data)."""
    require_columns(df, [column])
    vc = df[column].value_counts(dropna=True)
    return to_jsonable({
        "column": column,
        "missing": int(df[column].isna().sum()),
        "distinct": int(len(vc)),
        "items": [{"value": k, "count": v} for k, v in vc.head(limit).items()],
    })


def preview(df: pd.DataFrame, offset: int = 0, limit: int = 50, columns: list[str] | None = None) -> dict[str, Any]:
    """A slice of rows; ``columns`` restricts output to the visible (non-hidden) columns."""
    if offset < 0:
        raise TabularError("起始列（offset）不可為負數", code="invalid_argument")
    if limit < 1 or limit > PREVIEW_MAX_LIMIT:
        raise TabularError(f"筆數（limit）必須介於 1 到 {PREVIEW_MAX_LIMIT}", code="invalid_argument")
    cols = require_columns(df, columns) if columns is not None else list(df.columns)
    part = df.iloc[offset:offset + limit][cols]
    rows = [[row[c] for c in cols] for row in part.astype("object").to_dict("records")]
    return to_jsonable({
        "total_rows": int(len(df)),
        "offset": offset,
        "limit": limit,
        "columns": [str(c) for c in cols],
        "rows": rows,
    })


def correlation(df: pd.DataFrame, columns: list[str] | None = None, method: str = "pearson") -> dict[str, Any]:
    """Pairwise correlation matrix (pairwise-complete observations, as pandas)."""
    if method not in CORRELATION_METHODS:
        raise TabularError(f"不支援的相關係數方法「{method}」，可用：{'、'.join(CORRELATION_METHODS)}",
                           code="invalid_argument")
    if columns is None:
        columns = [c for c in df.columns if column_kind(df[c]) == "numeric" and df[c].notna().any()]
    if len(columns) < 2:
        raise TabularError("相關矩陣至少需要 2 個數值欄位", code="invalid_argument")
    frame = numeric_frame(df, columns)
    matrix = frame.corr(method=method)
    return to_jsonable({"method": method, "columns": [str(c) for c in columns], "matrix": matrix.to_numpy()})


def scatter(df: pd.DataFrame, x: str, y: str, limit: int = 5000) -> dict[str, Any]:
    """Scatter points for two numeric columns; rows missing either value are dropped.

    If more than ``limit`` points remain, a deterministic random sample (seed 0) is returned
    in original row order.
    """
    frame = pd.DataFrame({"x": numeric_series(df, x), "y": numeric_series(df, y)}).dropna()
    total = len(frame)
    sampled = total > limit
    if sampled:
        frame = frame.sample(n=limit, random_state=0).sort_index()
    return to_jsonable({
        "x": x,
        "y": y,
        "total": total,
        "returned": int(len(frame)),
        "sampled": sampled,
        "points": frame.to_numpy(),
    })
