"""Fit-on-train / apply-to-others preprocessing (avoids train→test leakage).

:func:`tabular.preprocess.apply_pipeline` is stateless: every step fits and transforms the frame
it receives. That is right for exploring one dataset, but wrong for modelling, where statistics
(means, scaling ranges, category lists, outlier bounds, principal components…) must come from the
training split only.

``fit_pipeline(train, steps)`` returns the transformed training frame and a :class:`FittedPipeline`
holding what was learned. ``FittedPipeline.transform(df)`` applies it to validation, test or
inference data.

Every registered step belongs to exactly one mode (``STEP_MODES``):

- ``stateless``  no statistics involved; the registry function is applied to each frame on its own.
- ``fitted``     statistics are learned on the training frame and reused.
- ``train_only`` removes rows (outliers, duplicates, rows with missing values). Applied while
                 fitting; skipped in ``transform`` so every input row keeps its place.

On the training frame the result equals ``apply_pipeline(train, steps)``.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from typing import Any

import numpy as np
import pandas as pd
from sklearn.decomposition import PCA
from sklearn.impute import KNNImputer
from sklearn.preprocessing import (
    KBinsDiscretizer,
    MaxAbsScaler,
    MinMaxScaler,
    OneHotEncoder,
    OrdinalEncoder,
    PowerTransformer,
    QuantileTransformer,
    RobustScaler,
    StandardScaler,
)

from tabular.columns import numeric_series, require_columns
from tabular.errors import TabularError
from tabular.preprocess import (
    REGISTRY,
    _as_object,
    _assign,
    _fail,
    _float_frame,
    _iqr_bounds,
    _no_missing,
    _nullable_int,
    _reset,
    _resolve_columns,
    _z_bounds,
    validate_steps,
)

FitFn = Callable[[pd.DataFrame, list[str], dict[str, Any]], Any]
ApplyFn = Callable[[pd.DataFrame, list[str], dict[str, Any], Any], pd.DataFrame]

_FITTED: dict[str, tuple[FitFn, ApplyFn]] = {}
_JOINT: set[str] = set()  # fitted on several columns together: none of them may be absent later

TRAIN_ONLY = frozenset({"drop_missing_rows", "drop_duplicate_rows", "iqr_remove", "zscore_remove"})


def _fitted(step_id: str, fit: FitFn, apply: ApplyFn, *, joint: bool = False) -> None:
    _FITTED[step_id] = (fit, apply)
    if joint:
        _JOINT.add(step_id)


# --------------------------------------------------------------------------- imputation

def _fit_stat(stat: str) -> FitFn:
    return lambda df, cols, p: {c: float(getattr(numeric_series(df, c), stat)()) for c in cols}


def _apply_fill_numeric(df, cols, params, state):
    for c in cols:
        df[c] = _numeric(df, c).fillna(state[c])
    return df


def _numeric(df: pd.DataFrame, column: str) -> pd.Series:
    """Like numeric_series, but an all-empty column is fine here: the statistics come from training."""
    if df[column].notna().sum() == 0:
        return pd.Series(np.nan, index=df.index, dtype="float64")
    return numeric_series(df, column)


_fitted("impute_mean", _fit_stat("mean"), _apply_fill_numeric)
_fitted("impute_median", _fit_stat("median"), _apply_fill_numeric)


def _fit_mode(df, cols, params):
    state = {}
    for c in cols:
        mode = df[c].mode(dropna=True)
        if mode.empty:
            raise _fail(f"欄位「{c}」全部是空值，無法以眾數補值", code="column_all_empty")
        state[c] = mode.iloc[0]
    return state


def _apply_mode(df, cols, params, state):
    for c in cols:
        s = df[c]
        if isinstance(s.dtype, pd.CategoricalDtype) and state[c] not in s.cat.categories:
            s = s.cat.add_categories([state[c]])
        df[c] = s.fillna(state[c])
    return df


_fitted("impute_most_frequent", _fit_mode, _apply_mode)

_fitted("impute_knn",
        lambda df, cols, p: KNNImputer(n_neighbors=p["n_neighbors"]).fit(_float_frame(df, cols)),
        lambda df, cols, p, imputer: _assign(df, imputer.transform(_frame(df, cols)), cols),
        joint=True)


def _frame(df: pd.DataFrame, cols: list[str]) -> pd.DataFrame:
    return pd.DataFrame({c: _numeric(df, c) for c in cols}, index=df.index)


def _fit_missing_ratio(df, cols, params):
    ratio = df[cols].isna().mean()
    return [c for c in cols if ratio[c] > params["threshold"]]


def _apply_drop(df, cols, params, state):
    return df.drop(columns=[c for c in state if c in df.columns])


_fitted("drop_columns_missing_ratio", _fit_missing_ratio, _apply_drop)
_fitted("drop_constant_columns",
        lambda df, cols, p: [c for c in cols if df[c].nunique(dropna=False) <= 1], _apply_drop)


# --------------------------------------------------------------------------- scaling
# These transformers work column by column, so one is fitted per column. A column that is
# absent later (for example the target at inference time) does not affect the others.

def _per_column(make: Callable[[pd.DataFrame, str, dict[str, Any]], Any]) -> tuple[FitFn, ApplyFn]:
    def fit(df, cols, params):
        return {c: make(df, c, params).fit(_float_frame(df, [c])) for c in cols}

    def apply(df, cols, params, state):
        for c in cols:
            df[c] = state[c].transform(_frame(df, [c]))[:, 0].astype("float64")
        return df

    return fit, apply


def _minmax(df, c, params):
    if params["min"] >= params["max"]:
        raise _fail("最小最大值縮放的下限必須小於上限", code="invalid_params")
    return MinMaxScaler(feature_range=(params["min"], params["max"]))


def _quantile(dist: str):
    def make(df, c, params):
        n = int(min(params["n_quantiles"], max(df[c].notna().sum(), 1)))
        return QuantileTransformer(n_quantiles=n, output_distribution=dist)

    return make


def _box_cox(df, c, params):
    if (numeric_series(df, c).dropna() <= 0).any():
        raise _fail(f"欄位「{c}」含 0 或負值，Box-Cox 轉換只接受正數", code="invalid_values")
    return PowerTransformer(method="box-cox", standardize=params["standardize"])


_fitted("scale_standard", *_per_column(lambda df, c, p: StandardScaler()))
_fitted("scale_minmax", *_per_column(_minmax))
_fitted("scale_maxabs", *_per_column(lambda df, c, p: MaxAbsScaler()))
_fitted("scale_robust", *_per_column(lambda df, c, p: RobustScaler()))
_fitted("quantile_uniform", *_per_column(_quantile("uniform")))
_fitted("quantile_normal", *_per_column(_quantile("normal")))
_fitted("power_yeo_johnson", *_per_column(
    lambda df, c, p: PowerTransformer(method="yeo-johnson", standardize=p["standardize"])))
_fitted("power_box_cox", *_per_column(_box_cox))


def _fit_zscore(df, cols, params):
    state = {}
    for c in cols:
        s = numeric_series(df, c)
        std = s.std(ddof=0)
        if not std > 0:
            raise _fail(f"欄位「{c}」標準差為 0，無法標準化", code="invalid_values")
        state[c] = (float(s.mean()), float(std))
    return state


def _apply_zscore(df, cols, params, state):
    t = params["threshold"]
    for c in cols:
        mean, std = state[c]
        df[c] = ((_numeric(df, c) - mean) / std).clip(-t, t)
    return df


_fitted("scale_zscore_clip", _fit_zscore, _apply_zscore)


# --------------------------------------------------------------------------- encoding

def _objects(df: pd.DataFrame, cols: list[str]) -> pd.DataFrame:
    return pd.DataFrame({c: _as_object(df[c]) for c in cols}, index=df.index)


def _fit_onehot(df, cols, params):
    # 訓練資料沒看過的類別在之後的資料出現時，該列所有指示欄為 0
    return {c: OneHotEncoder(sparse_output=False, drop="first" if params["drop_first"] else None,
                             handle_unknown="ignore").fit(_objects(df, [c])) for c in cols}


def _apply_onehot(df, cols, params, state):
    blocks, names = [], []
    for c in cols:
        enc = state[c]
        blocks.append(enc.transform(_objects(df, [c])))
        names.extend(enc.get_feature_names_out([c]))
    out = df.drop(columns=cols)
    clash = [n for n in names if n in out.columns]
    if clash:
        raise _fail(f"One-Hot 產生的欄位名稱與既有欄位衝突：{'、'.join(clash)}", code="column_conflict")
    values = np.hstack(blocks) if blocks else np.empty((len(df), 0))
    return pd.concat([out, pd.DataFrame(values.astype("int64"), columns=names, index=df.index)], axis=1)


_fitted("onehot", _fit_onehot, _apply_onehot)


def _fit_ordinal(df, cols, params):
    return {c: OrdinalEncoder(handle_unknown="use_encoded_value", unknown_value=np.nan).fit(_objects(df, [c]))
            for c in cols}


def _apply_ordinal(df, cols, params, state):
    for c in cols:
        df[c] = _nullable_int(state[c].transform(_objects(df, [c]))[:, 0], df.index)
    return df


_fitted("ordinal", _fit_ordinal, _apply_ordinal)


def _fit_label(df, cols, params):
    state = {}
    for c in cols:
        if df[c].isna().any():
            raise _fail(f"欄位「{c}」含缺值，標籤編碼前請先補值", code="missing_values")
        state[c] = sorted(set(df[c].astype("object").astype(str)))
    return state


def _apply_label(df, cols, params, state):
    for c in cols:
        if df[c].isna().any():
            raise _fail(f"欄位「{c}」含缺值，標籤編碼前請先補值", code="missing_values")
        index = {value: i for i, value in enumerate(state[c])}
        codes = df[c].astype("object").astype(str).map(index)
        # 沒看過的類別無法編碼，留空值讓下游決定（訓練資料上不會發生）
        df[c] = codes.astype("int64") if codes.notna().all() else codes.astype("Int64")
    return df


_fitted("label", _fit_label, _apply_label)


def _fit_counts(normalize: bool) -> FitFn:
    return lambda df, cols, p: {c: _as_object(df[c]).value_counts(normalize=normalize).to_dict() for c in cols}


def _apply_frequency(df, cols, params, state):
    for c in cols:
        s = _as_object(df[c])
        df[c] = s.map(state[c]).where(s.isna(), s.map(state[c]).fillna(0.0)).astype("float64")
    return df


def _apply_count(df, cols, params, state):
    for c in cols:
        s = _as_object(df[c])
        df[c] = _nullable_int(s.map(state[c]).where(s.isna(), s.map(state[c]).fillna(0)), df.index)
    return df


_fitted("frequency", _fit_counts(True), _apply_frequency)
_fitted("count", _fit_counts(False), _apply_count)


# --------------------------------------------------------------------------- discretization

def _fit_kbins(strategy: str) -> FitFn:
    def fit(df, cols, params):
        state = {}
        for c in cols:
            valid = numeric_series(df, c).dropna()
            state[c] = KBinsDiscretizer(n_bins=params["n_bins"], encode="ordinal", strategy=strategy).fit(
                valid.to_frame())
        return state

    return fit


def _apply_kbins(df, cols, params, state):
    for c in cols:
        s = _numeric(df, c)
        valid = s.dropna()
        out = pd.Series(np.nan, index=df.index)
        if len(valid):
            out[valid.index] = state[c].transform(valid.to_frame()).ravel()
        df[c] = out.astype("Int64")
    return df


for _strategy in ("uniform", "quantile", "kmeans"):
    _fitted(f"kbins_{_strategy}", _fit_kbins(_strategy), _apply_kbins)


# --------------------------------------------------------------------------- outliers

def _fit_bounds(bounds: Callable[[pd.Series], tuple[float, float]]) -> FitFn:
    def fit(df, cols, params):
        return {c: tuple(float(v) for v in bounds(numeric_series(df, c), params)) for c in cols}

    return fit


def _apply_clip(df, cols, params, state):
    for c in cols:
        df[c] = _numeric(df, c).clip(*state[c])
    return df


def _apply_remove(df, cols, params, state):
    keep = pd.Series(True, index=df.index)
    for c in cols:
        s = _numeric(df, c)
        keep &= s.isna() | s.between(*state[c])
    return _reset(df[keep])


_iqr = _fit_bounds(lambda s, p: _iqr_bounds(s, p["k"]))
_z = _fit_bounds(lambda s, p: _z_bounds(s, p["threshold"]))
_fitted("iqr_clip", _iqr, _apply_clip)
_fitted("zscore_clip", _z, _apply_clip)
_fitted("iqr_remove", _iqr, _apply_remove)
_fitted("zscore_remove", _z, _apply_remove)
_fitted("winsorize_1", _fit_bounds(lambda s, p: (s.quantile(0.01), s.quantile(0.99))), _apply_clip)
_fitted("winsorize_5", _fit_bounds(lambda s, p: (s.quantile(0.05), s.quantile(0.95))), _apply_clip)


# --------------------------------------------------------------------------- features

def _fit_pca(df, cols, params):
    n = params["n_components"]
    if n > len(cols):
        raise _fail(f"主成分數（{n}）不可大於欄位數（{len(cols)}）", code="invalid_params")
    frame = _no_missing(df, cols, "主成分分析").to_numpy()
    scaler = StandardScaler().fit(frame) if params["standardize"] else None
    if scaler is not None:
        frame = scaler.transform(frame)
    return scaler, PCA(n_components=n, random_state=0).fit(frame)


def _apply_pca(df, cols, params, state):
    scaler, pca = state
    frame = _no_missing(df, cols, "主成分分析").to_numpy()
    if scaler is not None:
        frame = scaler.transform(frame)
    comps = pca.transform(frame)
    if not params["keep_original"]:
        df = df.drop(columns=cols)
    for i in range(comps.shape[1]):
        df[f"PC{i + 1}"] = comps[:, i]
    return df


_fitted("pca", _fit_pca, _apply_pca, joint=True)


# --------------------------------------------------------------------------- pipeline

def step_mode(step_id: str) -> str:
    if step_id in TRAIN_ONLY:
        return "train_only"
    return "fitted" if step_id in _FITTED else "stateless"


STEP_MODES: dict[str, str] = {step_id: step_mode(step_id) for step_id in REGISTRY}

# 逐列或整個欄位一起運算、缺一欄就無法計算的無狀態方法
_STATELESS_JOINT = {"normalize_l1", "normalize_l2", "normalize_max", "polynomial_2", "interaction_terms",
                    "select_columns", "rename_columns"}


@dataclass
class FittedStep:
    id: str
    columns: list[str]
    params: dict[str, Any]
    mode: str
    state: Any = None


@dataclass
class FittedPipeline:
    steps: list[FittedStep] = field(default_factory=list)
    input_columns: list[str] = field(default_factory=list)
    output_columns: list[str] = field(default_factory=list)

    def transform(self, df: pd.DataFrame, *, optional: Iterable[str] = ()) -> pd.DataFrame:
        """Apply the fitted steps. Row-removing steps are skipped, so rows keep their position.

        ``optional`` names columns that may be absent (typically the target at inference time);
        steps skip them. Any other missing column raises :class:`TabularError`.
        """
        optional = set(optional)
        out = df.copy()
        for i, step in enumerate(self.steps):
            if step.mode == "train_only":
                continue
            absent = [c for c in step.columns if c not in out.columns]
            if any(c not in optional for c in absent):
                require_columns(out, step.columns)
            cols = [c for c in step.columns if c not in absent]
            if absent and (step.id in _JOINT or step.id in _STATELESS_JOINT):
                raise TabularError(
                    f"「{REGISTRY[step.id].name_zh}」需要欄位「{'、'.join(absent)}」，資料中沒有",
                    code="column_not_found", detail={"columns": absent, "step_index": i, "step_id": step.id})
            if not cols:
                continue
            out = _run(i, step.id, lambda: _apply(step, out, cols))
        return out


def _apply(step: FittedStep, df: pd.DataFrame, cols: list[str]) -> pd.DataFrame:
    if step.mode == "stateless":
        return REGISTRY[step.id].fn(df, cols, step.params)
    return _FITTED[step.id][1](df, cols, step.params, step.state)


def _run(index: int, step_id: str, call: Callable[[], Any]) -> Any:
    name = REGISTRY[step_id].name_zh
    try:
        return call()
    except TabularError as exc:
        exc.detail = {**exc.detail, "step_index": index, "step_id": step_id}
        raise
    except (ValueError, TypeError, KeyError, ArithmeticError) as exc:
        raise TabularError(f"第 {index + 1} 步「{name}」執行失敗：{exc}", code="step_failed",
                           detail={"step_index": index, "step_id": step_id}) from exc


def fit_pipeline(train: pd.DataFrame, steps: list[dict[str, Any]]) -> tuple[FittedPipeline, pd.DataFrame]:
    """Fit ``steps`` on ``train``. Returns the fitted pipeline and the transformed training frame."""
    out = train.copy()
    fitted = FittedPipeline(input_columns=list(map(str, train.columns)))
    for i, spec in enumerate(validate_steps(steps)):
        step = REGISTRY[spec["id"]]
        cols = _run(i, step.id, lambda: _resolve_columns(step, out, spec["columns"]))
        if not cols and not step.auto_all:
            continue
        mode = step_mode(step.id)
        record = FittedStep(id=step.id, columns=list(cols), params=spec["params"], mode=mode)
        if step.id in _FITTED:
            fit, apply = _FITTED[step.id]
            record.state = _run(i, step.id, lambda: fit(out, cols, spec["params"]))
            out = _run(i, step.id, lambda: apply(out, cols, spec["params"], record.state))
        else:
            out = _run(i, step.id, lambda: step.fn(out, cols, spec["params"]))
        fitted.steps.append(record)
    fitted.output_columns = list(map(str, out.columns))
    return fitted, out
