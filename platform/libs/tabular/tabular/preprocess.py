"""Preprocessing registry and pipeline.

A pipeline is a list of ``{"id": str, "columns": [str], "params": {}}`` steps, applied in
order by :func:`apply_pipeline`. Steps are stateless (fit and transform on the frame they
receive). ``columns`` empty/omitted means "all applicable columns" (or all columns for
row-level steps); some steps require explicit columns.

:func:`catalogue` lists every step with id, Traditional Chinese name, category, JSON-schema
parameter definition and applicable column types.
"""

from __future__ import annotations

import copy
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import numpy as np
import pandas as pd
from sklearn.decomposition import PCA
from sklearn.impute import KNNImputer
from sklearn.preprocessing import (
    KBinsDiscretizer,
    LabelEncoder,
    MaxAbsScaler,
    MinMaxScaler,
    Normalizer,
    OneHotEncoder,
    OrdinalEncoder,
    PolynomialFeatures,
    PowerTransformer,
    QuantileTransformer,
    RobustScaler,
    StandardScaler,
)

from tabular.columns import column_kind, numeric_series, require_columns
from tabular.errors import TabularError

CATEGORIES: dict[str, str] = {
    "imputation": "缺值處理",
    "scaling": "縮放與數值轉換",
    "encoding": "類別編碼",
    "discretization": "離散化",
    "outliers": "離群值處理",
    "features": "特徵工程",
    "cleaning": "資料清理",
}

NUMERIC = ["numeric"]
TEXTUAL = ["categorical", "text"]
ANY = ["any"]

StepFn = Callable[[pd.DataFrame, list[str], dict[str, Any]], pd.DataFrame]


@dataclass(frozen=True)
class Step:
    id: str
    name_zh: str
    category: str
    column_types: list[str]
    params: dict[str, dict[str, Any]]
    required_params: list[str]
    fn: StepFn
    requires_columns: bool = False
    auto_all: bool = False  # empty columns -> every column (row/frame-level steps)
    extra: dict[str, Any] = field(default_factory=dict)

    def schema(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": copy.deepcopy(self.params),
            "required": list(self.required_params),
            "additionalProperties": False,
        }

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name_zh": self.name_zh,
            "category": self.category,
            "category_zh": CATEGORIES[self.category],
            "params": self.schema(),
            "column_types": list(self.column_types),
            "requires_columns": self.requires_columns,
        }


REGISTRY: dict[str, Step] = {}


def _p(ptype: str | list[str], title: str, default: Any = None, **extra: Any) -> dict[str, Any]:
    spec = {"type": ptype, "title": title, "default": default}
    spec.update(extra)
    return spec


def register(
    id: str,
    name_zh: str,
    category: str,
    column_types: list[str],
    params: dict[str, dict[str, Any]] | None = None,
    required: list[str] | None = None,
    requires_columns: bool = False,
    auto_all: bool = False,
) -> Callable[[StepFn], StepFn]:
    def deco(fn: StepFn) -> StepFn:
        if id in REGISTRY:
            raise RuntimeError(f"duplicate step id {id}")
        REGISTRY[id] = Step(id, name_zh, category, column_types, params or {}, required or [], fn,
                            requires_columns, auto_all)
        return fn

    return deco


# --------------------------------------------------------------------------- helpers

def _fail(message: str, code: str = "step_failed") -> TabularError:
    return TabularError(message, code=code)


def _float_frame(df: pd.DataFrame, cols: list[str]) -> pd.DataFrame:
    return pd.DataFrame({c: numeric_series(df, c) for c in cols}, index=df.index)


def _no_missing(df: pd.DataFrame, cols: list[str], what: str) -> pd.DataFrame:
    frame = _float_frame(df, cols)
    bad = [c for c in cols if frame[c].isna().any()]
    if bad:
        raise _fail(f"{what}不接受缺值，欄位「{'、'.join(bad)}」含缺值，請先補值", code="missing_values")
    return frame


def _assign(df: pd.DataFrame, frame: pd.DataFrame | np.ndarray, cols: list[str]) -> pd.DataFrame:
    values = frame.to_numpy() if isinstance(frame, pd.DataFrame) else frame
    for i, c in enumerate(cols):
        df[c] = values[:, i].astype("float64")
    return df


def _fit_numeric(df: pd.DataFrame, cols: list[str], transformer: Any) -> pd.DataFrame:
    frame = _float_frame(df, cols)
    return _assign(df, transformer.fit_transform(frame), cols)


def _elementwise(check: Callable[[pd.Series], pd.Series], message: str, func: Callable[[pd.Series], pd.Series]) -> StepFn:
    def run(df: pd.DataFrame, cols: list[str], params: dict[str, Any]) -> pd.DataFrame:
        for c in cols:
            s = numeric_series(df, c)
            if (~check(s.dropna())).any():
                raise _fail(f"欄位「{c}」{message}", code="invalid_values")
            df[c] = func(s)
        return df

    return run


def _as_object(s: pd.Series) -> pd.Series:
    out = s.astype("object")
    return out.where(s.notna(), np.nan)


def _nullable_int(values: np.ndarray | pd.Series, index: pd.Index) -> pd.Series:
    return pd.Series(np.asarray(values, dtype="float64"), index=index).astype("Int64")


def _reset(df: pd.DataFrame) -> pd.DataFrame:
    return df.reset_index(drop=True)


# --------------------------------------------------------------------------- imputation

def _impute_stat(stat: str) -> StepFn:
    def run(df, cols, params):
        for c in cols:
            s = numeric_series(df, c)
            df[c] = s.fillna(getattr(s, stat)())
        return df

    return run


register("impute_mean", "平均數補值", "imputation", NUMERIC)(_impute_stat("mean"))
register("impute_median", "中位數補值", "imputation", NUMERIC)(_impute_stat("median"))


@register("impute_most_frequent", "眾數補值", "imputation", ANY)
def _impute_most_frequent(df, cols, params):
    for c in cols:
        s = df[c]
        mode = s.mode(dropna=True)
        if mode.empty:
            raise _fail(f"欄位「{c}」全部是空值，無法以眾數補值", code="column_all_empty")
        df[c] = s.fillna(mode.iloc[0])
    return df


@register("impute_constant", "固定值補值", "imputation", ANY,
          params={"fill_value": _p(["number", "string", "boolean"], "填入值", 0)})
def _impute_constant(df, cols, params):
    value = params["fill_value"]
    for c in cols:
        s = df[c]
        if isinstance(s.dtype, pd.CategoricalDtype) and value not in s.cat.categories:
            s = s.cat.add_categories([value])
        if pd.api.types.is_integer_dtype(s.dtype) and isinstance(value, float):
            s = s.astype("float64")
        df[c] = s.fillna(value)
    return df


@register("impute_knn", "K 近鄰補值", "imputation", NUMERIC,
          params={"n_neighbors": _p("integer", "鄰居數", 5, minimum=1)})
def _impute_knn(df, cols, params):
    return _fit_numeric(df, cols, KNNImputer(n_neighbors=params["n_neighbors"]))


@register("impute_ffill", "向前填補", "imputation", ANY)
def _impute_ffill(df, cols, params):
    df[cols] = df[cols].ffill()
    return df


@register("impute_bfill", "向後填補", "imputation", ANY)
def _impute_bfill(df, cols, params):
    df[cols] = df[cols].bfill()
    return df


@register("impute_interpolate", "線性內插補值", "imputation", NUMERIC)
def _impute_interpolate(df, cols, params):
    for c in cols:
        df[c] = numeric_series(df, c).interpolate(method="linear", limit_direction="both")
    return df


@register("drop_missing_rows", "刪除含缺值的列", "imputation", ANY, auto_all=True)
def _drop_missing_rows(df, cols, params):
    return _reset(df.dropna(subset=cols))


@register("drop_columns_missing_ratio", "刪除缺值比例過高的欄位", "imputation", ANY, auto_all=True,
          params={"threshold": _p("number", "缺值比例門檻（0–1）", 0.5, minimum=0, maximum=1)})
def _drop_columns_missing_ratio(df, cols, params):
    ratio = df[cols].isna().mean()
    return df.drop(columns=[c for c in cols if ratio[c] > params["threshold"]])


@register("add_missing_indicator", "新增缺值指示欄", "imputation", ANY, requires_columns=True)
def _add_missing_indicator(df, cols, params):
    for c in cols:
        df[f"{c}_missing"] = df[c].isna().astype("int64")
    return df


# --------------------------------------------------------------------------- scaling

register("scale_standard", "標準化（Z 分數）", "scaling", NUMERIC)(
    lambda df, cols, p: _fit_numeric(df, cols, StandardScaler()))


@register("scale_minmax", "最小最大值縮放", "scaling", NUMERIC,
          params={"min": _p("number", "下限", 0), "max": _p("number", "上限", 1)})
def _scale_minmax(df, cols, params):
    if params["min"] >= params["max"]:
        raise _fail("最小最大值縮放的下限必須小於上限", code="invalid_params")
    return _fit_numeric(df, cols, MinMaxScaler(feature_range=(params["min"], params["max"])))


register("scale_maxabs", "最大絕對值縮放", "scaling", NUMERIC)(
    lambda df, cols, p: _fit_numeric(df, cols, MaxAbsScaler()))
register("scale_robust", "穩健縮放（中位數與四分位距）", "scaling", NUMERIC)(
    lambda df, cols, p: _fit_numeric(df, cols, RobustScaler()))


def _normalizer(norm: str) -> StepFn:
    def run(df, cols, params):
        frame = _no_missing(df, cols, "列向量正規化")
        return _assign(df, Normalizer(norm=norm).fit_transform(frame), cols)

    return run


register("normalize_l1", "列向量 L1 正規化", "scaling", NUMERIC, requires_columns=True)(_normalizer("l1"))
register("normalize_l2", "列向量 L2 正規化", "scaling", NUMERIC, requires_columns=True)(_normalizer("l2"))
register("normalize_max", "列向量最大值正規化", "scaling", NUMERIC, requires_columns=True)(_normalizer("max"))


def _quantile(dist: str) -> StepFn:
    def run(df, cols, params):
        n = int(min(params["n_quantiles"], max(df[cols].notna().sum().min(), 1)))
        return _fit_numeric(df, cols, QuantileTransformer(n_quantiles=n, output_distribution=dist))

    return run


_NQ = {"n_quantiles": _p("integer", "分位數數量", 1000, minimum=2)}
register("quantile_uniform", "分位數轉換（均勻分布）", "scaling", NUMERIC, params=_NQ)(_quantile("uniform"))
register("quantile_normal", "分位數轉換（常態分布）", "scaling", NUMERIC, params=_NQ)(_quantile("normal"))

_STD = {"standardize": _p("boolean", "轉換後標準化", True)}


@register("power_yeo_johnson", "Yeo-Johnson 冪轉換", "scaling", NUMERIC, params=_STD)
def _yeo_johnson(df, cols, params):
    return _fit_numeric(df, cols, PowerTransformer(method="yeo-johnson", standardize=params["standardize"]))


@register("power_box_cox", "Box-Cox 冪轉換", "scaling", NUMERIC, params=_STD)
def _box_cox(df, cols, params):
    for c in cols:
        if (numeric_series(df, c).dropna() <= 0).any():
            raise _fail(f"欄位「{c}」含 0 或負值，Box-Cox 轉換只接受正數", code="invalid_values")
    return _fit_numeric(df, cols, PowerTransformer(method="box-cox", standardize=params["standardize"]))


register("log1p", "log(1+x) 轉換", "scaling", NUMERIC)(
    _elementwise(lambda s: s > -1, "含小於或等於 -1 的值，無法做 log(1+x) 轉換", np.log1p))
register("log", "自然對數轉換", "scaling", NUMERIC)(
    _elementwise(lambda s: s > 0, "含 0 或負值，無法取對數", np.log))
register("log10", "常用對數（log10）轉換", "scaling", NUMERIC)(
    _elementwise(lambda s: s > 0, "含 0 或負值，無法取對數", np.log10))
register("sqrt", "平方根轉換", "scaling", NUMERIC)(
    _elementwise(lambda s: s >= 0, "含負值，無法取平方根", np.sqrt))
register("square", "平方轉換", "scaling", NUMERIC)(
    _elementwise(lambda s: s == s, "", np.square))
register("reciprocal", "倒數轉換", "scaling", NUMERIC)(
    _elementwise(lambda s: s != 0, "含 0，無法取倒數", lambda s: 1.0 / s))


@register("scale_zscore_clip", "標準化後截斷", "scaling", NUMERIC,
          params={"threshold": _p("number", "Z 分數上限", 3, exclusiveMinimum=0)})
def _scale_zscore_clip(df, cols, params):
    t = params["threshold"]
    for c in cols:
        s = numeric_series(df, c)
        std = s.std(ddof=0)
        if not std > 0:
            raise _fail(f"欄位「{c}」標準差為 0，無法標準化", code="invalid_values")
        df[c] = ((s - s.mean()) / std).clip(-t, t)
    return df


@register("clip_values", "指定範圍截斷", "scaling", NUMERIC,
          params={"lower": _p(["number", "null"], "下限", None), "upper": _p(["number", "null"], "上限", None)})
def _clip_values(df, cols, params):
    lo, hi = params["lower"], params["upper"]
    if lo is not None and hi is not None and lo > hi:
        raise _fail("截斷下限不可大於上限", code="invalid_params")
    for c in cols:
        df[c] = numeric_series(df, c).clip(lo, hi)
    return df


# --------------------------------------------------------------------------- encoding

@register("onehot", "One-Hot 編碼", "encoding", TEXTUAL + ["boolean"],
          params={"drop_first": _p("boolean", "移除第一個類別（避免共線）", False)})
def _onehot(df, cols, params):
    data = pd.DataFrame({c: _as_object(df[c]) for c in cols}, index=df.index)
    enc = OneHotEncoder(sparse_output=False, drop="first" if params["drop_first"] else None)
    values = enc.fit_transform(data)
    names = list(enc.get_feature_names_out(cols))
    out = df.drop(columns=cols)
    clash = [n for n in names if n in out.columns]
    if clash:
        raise _fail(f"One-Hot 產生的欄位名稱與既有欄位衝突：{'、'.join(clash)}", code="column_conflict")
    encoded = pd.DataFrame(values.astype("int64"), columns=names, index=df.index)
    return pd.concat([out, encoded], axis=1)


@register("ordinal", "順序編碼", "encoding", TEXTUAL + ["boolean"])
def _ordinal(df, cols, params):
    data = pd.DataFrame({c: _as_object(df[c]) for c in cols}, index=df.index)
    values = OrdinalEncoder().fit_transform(data)
    for i, c in enumerate(cols):
        df[c] = _nullable_int(values[:, i], df.index)
    return df


@register("label", "標籤編碼", "encoding", TEXTUAL + ["boolean"])
def _label(df, cols, params):
    for c in cols:
        if df[c].isna().any():
            raise _fail(f"欄位「{c}」含缺值，標籤編碼前請先補值", code="missing_values")
        df[c] = pd.Series(LabelEncoder().fit_transform(df[c].astype("object").astype(str)),
                          index=df.index).astype("int64")
    return df


@register("frequency", "頻率編碼", "encoding", TEXTUAL + ["boolean"])
def _frequency(df, cols, params):
    for c in cols:
        s = _as_object(df[c])
        df[c] = s.map(s.value_counts(normalize=True)).astype("float64")
    return df


@register("count", "計數編碼", "encoding", TEXTUAL + ["boolean"])
def _count(df, cols, params):
    for c in cols:
        s = _as_object(df[c])
        df[c] = _nullable_int(s.map(s.value_counts()), df.index)
    return df


@register("binary_map", "二元對應（指定陽性值為 1）", "encoding", ANY, requires_columns=True,
          params={"positive": _p(["string", "number", "boolean"], "陽性值（對應為 1）")}, required=["positive"])
def _binary_map(df, cols, params):
    pos = params["positive"]
    for c in cols:
        s = df[c]
        hit = s.astype("object").map(lambda v: v == pos or str(v) == str(pos))
        df[c] = hit.astype("float64").where(s.notna()).astype("Int64")
    return df


# --------------------------------------------------------------------------- discretization

def _kbins(strategy: str) -> StepFn:
    def run(df, cols, params):
        for c in cols:
            s = numeric_series(df, c)
            valid = s.dropna()
            enc = KBinsDiscretizer(n_bins=params["n_bins"], encode="ordinal", strategy=strategy)
            out = pd.Series(np.nan, index=df.index)
            out[valid.index] = enc.fit_transform(valid.to_frame()).ravel()
            df[c] = out.astype("Int64")
        return df

    return run


_NB = {"n_bins": _p("integer", "分箱數", 5, minimum=2)}
register("kbins_uniform", "等寬分箱", "discretization", NUMERIC, params=_NB)(_kbins("uniform"))
register("kbins_quantile", "等頻（分位數）分箱", "discretization", NUMERIC, params=_NB)(_kbins("quantile"))
register("kbins_kmeans", "K-Means 分箱", "discretization", NUMERIC, params=_NB)(_kbins("kmeans"))


@register("binarize", "二值化（大於門檻為 1）", "discretization", NUMERIC,
          params={"threshold": _p("number", "門檻", 0)})
def _binarize(df, cols, params):
    for c in cols:
        s = numeric_series(df, c)
        df[c] = (s > params["threshold"]).astype("float64").where(s.notna()).astype("Int64")
    return df


# --------------------------------------------------------------------------- outliers

def _iqr_bounds(s: pd.Series, k: float) -> tuple[float, float]:
    q1, q3 = s.quantile(0.25), s.quantile(0.75)
    return q1 - k * (q3 - q1), q3 + k * (q3 - q1)


def _z_bounds(s: pd.Series, t: float) -> tuple[float, float]:
    mean, std = s.mean(), s.std(ddof=0)
    return mean - t * std, mean + t * std


def _outlier(bounds: Callable[[pd.Series, float], tuple[float, float]], key: str, remove: bool) -> StepFn:
    def run(df, cols, params):
        keep = pd.Series(True, index=df.index)
        for c in cols:
            s = numeric_series(df, c)
            lo, hi = bounds(s, params[key])
            if remove:
                keep &= s.isna() | s.between(lo, hi)
            else:
                df[c] = s.clip(lo, hi)
        return _reset(df[keep]) if remove else df

    return run


_K = {"k": _p("number", "四分位距倍數", 1.5, exclusiveMinimum=0)}
_T = {"threshold": _p("number", "Z 分數門檻", 3, exclusiveMinimum=0)}
register("iqr_clip", "IQR 截斷離群值", "outliers", NUMERIC, params=_K)(_outlier(_iqr_bounds, "k", False))
register("iqr_remove", "IQR 刪除離群列", "outliers", NUMERIC, params=_K)(_outlier(_iqr_bounds, "k", True))
register("zscore_clip", "Z 分數截斷離群值", "outliers", NUMERIC, params=_T)(_outlier(_z_bounds, "threshold", False))
register("zscore_remove", "Z 分數刪除離群列", "outliers", NUMERIC, params=_T)(_outlier(_z_bounds, "threshold", True))


def _winsorize(p: float) -> StepFn:
    def run(df, cols, params):
        for c in cols:
            s = numeric_series(df, c)
            df[c] = s.clip(s.quantile(p), s.quantile(1 - p))
        return df

    return run


register("winsorize_1", "縮尾處理（1% / 99%）", "outliers", NUMERIC)(_winsorize(0.01))
register("winsorize_5", "縮尾處理（5% / 95%）", "outliers", NUMERIC)(_winsorize(0.05))


# --------------------------------------------------------------------------- features

def _poly(interaction_only: bool) -> StepFn:
    def run(df, cols, params):
        frame = _no_missing(df, cols, "多項式特徵")
        poly = PolynomialFeatures(degree=2, include_bias=False, interaction_only=interaction_only)
        values = poly.fit_transform(frame)
        for i, name in enumerate(poly.get_feature_names_out(cols)):
            if name not in cols:
                df[name] = values[:, i]
        return df

    return run


register("polynomial_2", "二次多項式特徵", "features", NUMERIC, requires_columns=True)(_poly(False))
register("interaction_terms", "交互作用項", "features", NUMERIC, requires_columns=True)(_poly(True))


@register("pca", "主成分分析（PCA）", "features", NUMERIC, requires_columns=True,
          params={"n_components": _p("integer", "主成分數", 2, minimum=1),
                  "standardize": _p("boolean", "先標準化", True),
                  "keep_original": _p("boolean", "保留原始欄位", False)})
def _pca(df, cols, params):
    n = params["n_components"]
    if n > len(cols):
        raise _fail(f"主成分數（{n}）不可大於欄位數（{len(cols)}）", code="invalid_params")
    frame = _no_missing(df, cols, "主成分分析").to_numpy()
    if params["standardize"]:
        frame = StandardScaler().fit_transform(frame)
    comps = PCA(n_components=n, random_state=0).fit_transform(frame)
    if not params["keep_original"]:
        df = df.drop(columns=cols)
    for i in range(n):
        df[f"PC{i + 1}"] = comps[:, i]
    return df


# --------------------------------------------------------------------------- cleaning

@register("drop_duplicate_rows", "刪除重複列", "cleaning", ANY, auto_all=True)
def _drop_duplicates(df, cols, params):
    return _reset(df.drop_duplicates(subset=cols, keep="first"))


@register("drop_constant_columns", "刪除常數欄位", "cleaning", ANY, auto_all=True)
def _drop_constant(df, cols, params):
    return df.drop(columns=[c for c in cols if df[c].nunique(dropna=False) <= 1])


def _text(func: Callable[[str], str]) -> StepFn:
    def run(df, cols, params):
        for c in cols:
            df[c] = df[c].astype("object").map(lambda v: func(v) if isinstance(v, str) else v)
        return df

    return run


register("strip_text", "去除前後空白", "cleaning", TEXTUAL)(_text(str.strip))
register("lower_text", "轉小寫", "cleaning", TEXTUAL)(_text(str.lower))
register("upper_text", "轉大寫", "cleaning", TEXTUAL)(_text(str.upper))


@register("replace_value", "取代特定值", "cleaning", ANY, auto_all=True,
          params={"to_replace": _p(["string", "number", "boolean"], "原值"),
                  "value": _p(["string", "number", "boolean", "null"], "新值", None)},
          required=["to_replace"])
def _replace_value(df, cols, params):
    new = np.nan if params["value"] is None else params["value"]
    for c in cols:
        s = df[c]
        if isinstance(s.dtype, pd.CategoricalDtype):
            s = s.astype("object")
        df[c] = s.replace(params["to_replace"], new)
    return df


@register("to_numeric", "轉為數值（無法轉換者設為缺值）", "cleaning", ANY, requires_columns=True)
def _to_numeric(df, cols, params):
    for c in cols:
        df[c] = pd.to_numeric(df[c].astype("object"), errors="coerce").astype("float64")
    return df


@register("to_datetime", "轉為日期時間（無法轉換者設為缺值）", "cleaning", ANY, requires_columns=True,
          params={"format": _p(["string", "null"], "日期格式（如 %Y-%m-%d，留空自動判斷）", None)})
def _to_datetime(df, cols, params):
    for c in cols:
        df[c] = pd.to_datetime(df[c], errors="coerce", format=params["format"])
    return df


def _extract(part: str) -> StepFn:
    def run(df, cols, params):
        for c in cols:
            s = df[c]
            if not pd.api.types.is_datetime64_any_dtype(s):
                s = pd.to_datetime(s, errors="coerce")
            if s.notna().sum() == 0:
                raise _fail(f"欄位「{c}」沒有可辨識的日期", code="invalid_values")
            values = s.dt.weekday if part == "weekday" else getattr(s.dt, part)
            df[f"{c}_{part}"] = values.astype("Int64")
        return df

    return run


_DT = ["datetime", "text", "categorical"]
register("extract_year", "擷取年份", "cleaning", _DT, requires_columns=True)(_extract("year"))
register("extract_month", "擷取月份", "cleaning", _DT, requires_columns=True)(_extract("month"))
register("extract_day", "擷取日", "cleaning", _DT, requires_columns=True)(_extract("day"))
register("extract_weekday", "擷取星期（週一為 0）", "cleaning", _DT, requires_columns=True)(_extract("weekday"))


@register("rename_columns", "重新命名欄位", "cleaning", ANY,
          params={"mapping": _p("object", "欄位對照（舊名 → 新名）")}, required=["mapping"])
def _rename(df, cols, params):
    mapping = params["mapping"]
    require_columns(df, mapping.keys())
    if not all(isinstance(v, str) and v for v in mapping.values()):
        raise _fail("新欄位名稱必須是非空字串", code="invalid_params")
    result = [mapping.get(c, c) for c in df.columns]
    if len(set(result)) != len(result):
        raise _fail("重新命名後出現重複的欄位名稱", code="column_conflict")
    return df.rename(columns=mapping)


@register("drop_columns", "刪除欄位", "cleaning", ANY, requires_columns=True)
def _drop_columns(df, cols, params):
    return df.drop(columns=cols)


@register("select_columns", "只保留指定欄位", "cleaning", ANY, requires_columns=True)
def _select_columns(df, cols, params):
    return df[cols].copy()


_TRUE = {"true", "1", "yes", "y", "t", "是", "1.0"}
_FALSE = {"false", "0", "no", "n", "f", "否", "0.0"}


@register("cast_type", "轉換資料型別", "cleaning", ANY, requires_columns=True,
          params={"dtype": _p("string", "目標型別", None, enum=["int", "float", "str", "category", "bool"])},
          required=["dtype"])
def _cast_type(df, cols, params):
    target = params["dtype"]
    for c in cols:
        s = df[c]
        if target in ("int", "float"):
            num = pd.to_numeric(s.astype("object"), errors="coerce").astype("float64")
            if (num.isna() & s.notna()).any():
                raise _fail(f"欄位「{c}」含無法轉為數值的內容", code="invalid_values")
            if target == "int":
                if ((num.dropna() % 1) != 0).any():
                    raise _fail(f"欄位「{c}」含小數，無法轉為整數", code="invalid_values")
                num = num.astype("Int64")
            df[c] = num
        elif target == "str":
            df[c] = s.astype("object").map(lambda v: v if pd.isna(v) else str(v))
        elif target == "category":
            df[c] = s.astype("category")
        else:
            def to_bool(v: Any) -> Any:
                if pd.isna(v):
                    return pd.NA
                key = str(v).strip().lower()
                if key in _TRUE:
                    return True
                if key in _FALSE:
                    return False
                raise _fail(f"欄位「{c}」的值「{v}」無法轉為布林值", code="invalid_values")

            df[c] = s.astype("object").map(to_bool).astype("boolean")
    return df


@register("round", "四捨五入", "cleaning", NUMERIC,
          params={"decimals": _p("integer", "小數位數", 0)})
def _round(df, cols, params):
    for c in cols:
        df[c] = numeric_series(df, c).round(params["decimals"])
    return df


# --------------------------------------------------------------------------- API

_JSON_TYPES: dict[str, Callable[[Any], bool]] = {
    "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "string": lambda v: isinstance(v, str),
    "boolean": lambda v: isinstance(v, bool),
    "object": lambda v: isinstance(v, dict),
    "null": lambda v: v is None,
}


def catalogue() -> list[dict[str, Any]]:
    """All registered preprocessing methods, in registration (documentation) order."""
    return [s.to_dict() for s in REGISTRY.values()]


def get_step(step_id: Any) -> Step:
    if step_id not in REGISTRY:
        raise TabularError(f"找不到前處理方法「{step_id}」", code="unknown_step", detail={"id": step_id})
    return REGISTRY[step_id]


def _validate_params(step: Step, params: Any) -> dict[str, Any]:
    if params is None:
        params = {}
    if not isinstance(params, dict):
        raise TabularError(f"「{step.name_zh}」的參數必須是物件", code="invalid_params")
    unknown = sorted(set(params) - set(step.params))
    if unknown:
        raise TabularError(f"「{step.name_zh}」不支援參數：{'、'.join(unknown)}", code="invalid_params")
    out: dict[str, Any] = {}
    for name, spec in step.params.items():
        if name not in params:
            if name in step.required_params:
                raise TabularError(f"「{step.name_zh}」缺少必要參數「{spec['title']}」（{name}）",
                                   code="invalid_params")
            out[name] = copy.deepcopy(spec.get("default"))
            continue
        value = params[name]
        types = spec["type"] if isinstance(spec["type"], list) else [spec["type"]]
        if not any(_JSON_TYPES[t](value) for t in types):
            raise TabularError(f"「{step.name_zh}」的參數「{spec['title']}」（{name}）型別錯誤",
                               code="invalid_params")
        if "enum" in spec and value not in spec["enum"]:
            raise TabularError(
                f"「{step.name_zh}」的參數「{spec['title']}」只能是：{'、'.join(map(str, spec['enum']))}",
                code="invalid_params")
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            if "minimum" in spec and value < spec["minimum"]:
                raise TabularError(f"「{step.name_zh}」的參數「{spec['title']}」不可小於 {spec['minimum']}",
                                   code="invalid_params")
            if "maximum" in spec and value > spec["maximum"]:
                raise TabularError(f"「{step.name_zh}」的參數「{spec['title']}」不可大於 {spec['maximum']}",
                                   code="invalid_params")
            if "exclusiveMinimum" in spec and value <= spec["exclusiveMinimum"]:
                raise TabularError(
                    f"「{step.name_zh}」的參數「{spec['title']}」必須大於 {spec['exclusiveMinimum']}",
                    code="invalid_params")
        out[name] = copy.deepcopy(value)
    return out


def validate_steps(steps: Any) -> list[dict[str, Any]]:
    """Validate step ids and params (no data needed); return normalised steps with defaults."""
    if not isinstance(steps, list):
        raise TabularError("前處理步驟必須是清單", code="invalid_steps")
    result = []
    for i, raw in enumerate(steps):
        if not isinstance(raw, dict) or "id" not in raw:
            raise TabularError(f"第 {i + 1} 個前處理步驟缺少 id", code="invalid_steps")
        step = get_step(raw["id"])
        columns = raw.get("columns") or []
        if not isinstance(columns, list) or not all(isinstance(c, str) for c in columns):
            raise TabularError(f"「{step.name_zh}」的欄位清單格式錯誤", code="invalid_steps")
        if step.requires_columns and not columns:
            raise TabularError(f"「{step.name_zh}」必須指定欄位", code="invalid_steps")
        result.append({"id": step.id, "columns": list(columns), "params": _validate_params(step, raw.get("params"))})
    return result


def _accepts(step: Step, kind: str) -> bool:
    types = step.column_types
    if "any" in types or kind in types:
        return True
    return kind == "boolean" and "numeric" in types


def _resolve_columns(step: Step, df: pd.DataFrame, columns: list[str]) -> list[str]:
    if columns:
        require_columns(df, columns)
        for c in columns:
            kind = column_kind(df[c])
            if not _accepts(step, kind) and df[c].notna().any():
                raise TabularError(
                    f"「{step.name_zh}」不適用於欄位「{c}」（型別：{kind}），適用型別：{'、'.join(step.column_types)}",
                    code="column_type_mismatch", detail={"column": c})
        return columns
    if step.auto_all or "any" in step.column_types:
        return list(df.columns)
    return [c for c in df.columns if column_kind(df[c]) in step.column_types and df[c].notna().any()]


def apply_pipeline(df: pd.DataFrame, steps: list[dict[str, Any]]) -> pd.DataFrame:
    """Apply steps in order to a copy of ``df``. Raises :class:`TabularError` on any failure."""
    normalised = validate_steps(steps)
    out = df.copy()
    for i, spec in enumerate(normalised):
        step = REGISTRY[spec["id"]]
        cols = _resolve_columns(step, out, spec["columns"])
        if not cols and not step.auto_all:
            continue
        try:
            out = step.fn(out, cols, spec["params"])
        except TabularError as exc:
            exc.detail = {**exc.detail, "step_index": i, "step_id": step.id}
            raise
        except (ValueError, TypeError, KeyError, ArithmeticError) as exc:
            raise TabularError(
                f"第 {i + 1} 步「{step.name_zh}」執行失敗：{exc}",
                code="step_failed",
                detail={"step_index": i, "step_id": step.id},
            ) from exc
    return out
