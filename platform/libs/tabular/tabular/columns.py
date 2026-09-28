"""Column lookup and type guards shared by analyses. All failures raise TabularError (zh)."""

from __future__ import annotations

from collections.abc import Iterable

import pandas as pd

from tabular.errors import TabularError


def column_kind(series: pd.Series) -> str:
    dtype = series.dtype
    if pd.api.types.is_bool_dtype(dtype):
        return "boolean"
    if pd.api.types.is_numeric_dtype(dtype):
        return "numeric"
    if pd.api.types.is_datetime64_any_dtype(dtype):
        return "datetime"
    if isinstance(dtype, pd.CategoricalDtype):
        return "categorical"
    return "categorical" if series.dropna().map(lambda v: isinstance(v, str)).all() else "text"


def require_columns(df: pd.DataFrame, columns: Iterable[str]) -> list[str]:
    cols = list(columns)
    missing = [c for c in cols if c not in df.columns]
    if missing:
        raise TabularError(
            f"資料中找不到欄位：{'、'.join(map(str, missing))}",
            code="column_not_found",
            detail={"columns": missing},
        )
    return cols


def numeric_series(df: pd.DataFrame, column: str, allow_bool: bool = True) -> pd.Series:
    """Return ``df[column]`` as float64, or raise a clear TabularError.

    Non-numeric (text/category/date) and all-empty columns are rejected (TC-B04-08).
    """
    require_columns(df, [column])
    series = df[column]
    kind = column_kind(series)
    if kind == "boolean" and allow_bool:
        series = series.astype("float64")
    elif kind != "numeric" or (kind == "boolean" and not allow_bool):
        raise TabularError(
            f"欄位「{column}」不是數值欄位，無法進行數值分析",
            code="column_not_numeric",
            detail={"column": column},
        )
    series = series.astype("float64")
    if series.notna().sum() == 0:
        raise TabularError(
            f"欄位「{column}」全部是空值，無法進行分析",
            code="column_all_empty",
            detail={"column": column},
        )
    return series


def numeric_frame(df: pd.DataFrame, columns: Iterable[str]) -> pd.DataFrame:
    cols = require_columns(df, columns)
    return pd.DataFrame({c: numeric_series(df, c) for c in cols}, index=df.index)
