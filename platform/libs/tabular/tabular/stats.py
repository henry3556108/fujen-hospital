"""Medical statistics: logistic / linear regression (statsmodels), Kaplan–Meier and Cox
proportional hazards (lifelines).

Rows with a missing value in any used column are dropped (listwise deletion); the number of
dropped rows is reported. Features/covariates must be numeric (encode categorical columns
first, e.g. with the ``onehot`` preprocessing step). Every result is JSON-serialisable and
contains both statistics and chart-ready data.
"""

from __future__ import annotations

import warnings
from typing import Any

import numpy as np
import pandas as pd
import statsmodels.api as sm
from lifelines import CoxPHFitter, KaplanMeierFitter
from lifelines.statistics import multivariate_logrank_test
from sklearn.metrics import roc_auc_score, roc_curve
from statsmodels.tools.sm_exceptions import PerfectSeparationError, PerfectSeparationWarning

from tabular.columns import numeric_series, require_columns
from tabular.errors import TabularError
from tabular.jsonutil import to_jsonable

MAX_GROUPS = 20
MAX_POINTS = 5000


def _check_roles(outcome: list[str], predictors: Any, label: str) -> list[str]:
    if not isinstance(predictors, list) or not predictors:
        raise TabularError(f"請至少指定一個{label}", code="invalid_argument")
    overlap = [c for c in predictors if c in outcome]
    if overlap:
        raise TabularError(f"欄位「{'、'.join(overlap)}」不可同時作為結果與{label}", code="invalid_argument")
    if len(set(predictors)) != len(predictors):
        raise TabularError(f"{label}欄位重複", code="invalid_argument")
    return predictors


def _model_frame(df: pd.DataFrame, columns: list[str], n_params: int) -> tuple[pd.DataFrame, int]:
    require_columns(df, columns)
    frame = pd.DataFrame({c: numeric_series(df, c) for c in columns}, index=df.index)
    clean = frame.dropna()
    if len(clean) <= n_params:
        raise TabularError(
            f"排除缺值後僅剩 {len(clean)} 筆資料，不足以估計 {n_params} 個參數",
            code="insufficient_data",
        )
    return clean, int(len(frame) - len(clean))


def _binary(series: pd.Series, column: str, role: str) -> None:
    values = set(np.unique(series.to_numpy()))
    if not values <= {0.0, 1.0}:
        raise TabularError(f"{role}欄位「{column}」必須只包含 0 與 1", code="not_binary", detail={"column": column})
    if role == "結果" and len(values) < 2:
        raise TabularError(f"結果欄位「{column}」只有單一類別，無法建立模型", code="not_binary")


def _check_finite(values: pd.Series | np.ndarray, what: str) -> None:
    if not np.all(np.isfinite(np.asarray(values, dtype=float))):
        raise TabularError(f"{what}無法收斂或參數不可估計，請檢查共線性或資料分布", code="model_failed")


def _limit_points(points: np.ndarray) -> np.ndarray:
    if len(points) <= MAX_POINTS:
        return points
    idx = np.sort(np.random.default_rng(0).choice(len(points), MAX_POINTS, replace=False))
    return points[idx]


# ------------------------------------------------------------------ logistic regression

def logistic(df: pd.DataFrame, target: str, features: list[str]) -> dict[str, Any]:
    """Binary logistic regression (``statsmodels.Logit``) with odds ratios and ROC curve."""
    features = _check_roles([target], features, "特徵")
    data, dropped = _model_frame(df, [target, *features], len(features) + 1)
    y = data[target]
    _binary(y, target, "結果")
    X = sm.add_constant(data[features], has_constant="add")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            warnings.simplefilter("error", PerfectSeparationWarning)
            model = sm.Logit(y, X).fit(disp=0)
    except (PerfectSeparationError, PerfectSeparationWarning):
        raise TabularError("資料出現完全分離（特徵可完美預測結果），無法估計邏輯斯迴歸係數",
                           code="perfect_separation") from None
    except (np.linalg.LinAlgError, ValueError) as exc:
        raise TabularError(f"邏輯斯迴歸無法估計：{exc}", code="model_failed") from None
    _check_finite(model.bse, "邏輯斯迴歸")
    ci = model.conf_int()
    coefficients = [
        {
            "name": name,
            "coef": model.params[name],
            "std_err": model.bse[name],
            "z": model.tvalues[name],
            "p": model.pvalues[name],
            "ci_low": ci.loc[name, 0],
            "ci_high": ci.loc[name, 1],
            "odds_ratio": np.exp(model.params[name]),
            "or_ci_low": np.exp(ci.loc[name, 0]),
            "or_ci_high": np.exp(ci.loc[name, 1]),
        }
        for name in X.columns
    ]
    prob = model.predict()
    fpr, tpr, thresholds = roc_curve(y, prob)
    return to_jsonable({
        "model": "logistic",
        "target": target,
        "features": features,
        "n": int(len(data)),
        "n_dropped": dropped,
        "events": int(y.sum()),
        "coefficients": coefficients,
        "aic": model.aic,
        "bic": model.bic,
        "log_likelihood": model.llf,
        "pseudo_r2": model.prsquared,
        "llr_p_value": model.llr_pvalue,
        "converged": bool(model.mle_retvals.get("converged", True)),
        "roc": {"fpr": fpr, "tpr": tpr, "thresholds": np.minimum(thresholds, 1.0),
                "auc": roc_auc_score(y, prob)},
    })


# ------------------------------------------------------------------ linear regression

def linear(df: pd.DataFrame, target: str, features: list[str]) -> dict[str, Any]:
    """Ordinary least squares (``statsmodels.OLS``) with residual-vs-fitted points."""
    features = _check_roles([target], features, "特徵")
    data, dropped = _model_frame(df, [target, *features], len(features) + 1)
    y = data[target]
    X = sm.add_constant(data[features], has_constant="add")
    try:
        model = sm.OLS(y, X).fit()
    except (np.linalg.LinAlgError, ValueError) as exc:
        raise TabularError(f"線性迴歸無法估計：{exc}", code="model_failed") from None
    _check_finite(model.params, "線性迴歸")
    ci = model.conf_int()
    coefficients = [
        {
            "name": name,
            "coef": model.params[name],
            "std_err": model.bse[name],
            "t": model.tvalues[name],
            "p": model.pvalues[name],
            "ci_low": ci.loc[name, 0],
            "ci_high": ci.loc[name, 1],
        }
        for name in X.columns
    ]
    points = _limit_points(np.column_stack([model.fittedvalues.to_numpy(), model.resid.to_numpy()]))
    return to_jsonable({
        "model": "linear",
        "target": target,
        "features": features,
        "n": int(len(data)),
        "n_dropped": dropped,
        "coefficients": coefficients,
        "r2": model.rsquared,
        "adj_r2": model.rsquared_adj,
        "f_statistic": model.fvalue,
        "f_p_value": model.f_pvalue,
        "aic": model.aic,
        "bic": model.bic,
        "log_likelihood": model.llf,
        "residuals": {"points": points, "total": int(len(data))},
    })


# ------------------------------------------------------------------ survival

def _survival_frame(df: pd.DataFrame, duration: str, event: str, extra: list[str]) -> tuple[pd.DataFrame, int]:
    data, dropped = _model_frame(df, [duration, event, *extra], len(extra))
    if (data[duration] < 0).any():
        raise TabularError(f"存活時間欄位「{duration}」不可有負值", code="invalid_values")
    _binary(data[event], event, "事件")
    return data, dropped


def _km_curve(label: str, t: pd.Series, e: pd.Series) -> dict[str, Any]:
    kmf = KaplanMeierFitter().fit(t, e, label=label)
    sf = kmf.survival_function_
    ci = kmf.confidence_interval_
    table = kmf.event_table
    return {
        "group": label,
        "n": int(len(t)),
        "events": int(e.sum()),
        "median_survival": kmf.median_survival_time_,
        "timeline": sf.index.to_numpy(),
        "survival": sf.iloc[:, 0].to_numpy(),
        "ci_lower": ci.iloc[:, 0].to_numpy(),
        "ci_upper": ci.iloc[:, 1].to_numpy(),
        "at_risk": table["at_risk"].reindex(sf.index).to_numpy(),
    }


def kaplan_meier(df: pd.DataFrame, duration: str, event: str, group: str | None = None) -> dict[str, Any]:
    """Kaplan–Meier survival curves, optionally per group with a (multivariate) log-rank test."""
    if group is None:
        data, dropped = _survival_frame(df, duration, event, [])
        return to_jsonable({
            "model": "kaplan_meier", "duration": duration, "event": event, "group_by": None,
            "n": int(len(data)), "n_dropped": dropped,
            "groups": [_km_curve("全部", data[duration], data[event])],
            "logrank": None,
        })

    require_columns(df, [group])
    if group in (duration, event):
        raise TabularError("分組欄位不可與存活時間或事件欄位相同", code="invalid_argument")
    base, dropped = _survival_frame(df, duration, event, [])
    labels = df.loc[base.index, group]
    keep = labels.notna()
    dropped += int((~keep).sum())
    data = base[keep]
    labels = labels[keep].astype("object").map(str)
    names = sorted(labels.unique())
    if len(names) > MAX_GROUPS:
        raise TabularError(f"分組欄位「{group}」有 {len(names)} 個類別，超過上限 {MAX_GROUPS}",
                           code="too_many_groups")
    if len(names) < 2:
        raise TabularError(f"分組欄位「{group}」至少需要 2 個類別才能比較", code="invalid_argument")
    curves = [_km_curve(n, data.loc[labels == n, duration], data.loc[labels == n, event]) for n in names]
    test = multivariate_logrank_test(data[duration], labels, data[event])
    return to_jsonable({
        "model": "kaplan_meier", "duration": duration, "event": event, "group_by": group,
        "n": int(len(data)), "n_dropped": dropped,
        "groups": curves,
        "logrank": {"test_statistic": test.test_statistic, "p_value": test.p_value,
                    "degrees_of_freedom": len(names) - 1},
    })


def cox(df: pd.DataFrame, duration: str, event: str, covariates: list[str]) -> dict[str, Any]:
    """Cox proportional hazards (``lifelines.CoxPHFitter``): hazard ratios, CI, concordance."""
    covariates = _check_roles([duration, event], covariates, "共變數")
    data, dropped = _survival_frame(df, duration, event, covariates)
    for c in covariates:
        if data[c].nunique() < 2:
            raise TabularError(f"共變數「{c}」在有效資料中為常數，無法估計", code="invalid_values")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            cph = CoxPHFitter().fit(data, duration_col=duration, event_col=event)
    except (ValueError, np.linalg.LinAlgError, ZeroDivisionError) as exc:
        raise TabularError(f"Cox 模型無法收斂：{exc}", code="model_failed") from None
    s = cph.summary
    _check_finite(s["se(coef)"], "Cox 模型")
    coefficients = [
        {
            "name": name,
            "coef": s.loc[name, "coef"],
            "std_err": s.loc[name, "se(coef)"],
            "z": s.loc[name, "z"],
            "p": s.loc[name, "p"],
            "ci_low": s.loc[name, "coef lower 95%"],
            "ci_high": s.loc[name, "coef upper 95%"],
            "hr": s.loc[name, "exp(coef)"],
            "hr_ci_low": s.loc[name, "exp(coef) lower 95%"],
            "hr_ci_high": s.loc[name, "exp(coef) upper 95%"],
        }
        for name in covariates
    ]
    base = cph.baseline_survival_
    return to_jsonable({
        "model": "cox",
        "duration": duration,
        "event": event,
        "covariates": covariates,
        "n": int(len(data)),
        "n_dropped": dropped,
        "events": int(data[event].sum()),
        "coefficients": coefficients,
        "concordance": cph.concordance_index_,
        "log_likelihood": cph.log_likelihood_,
        "aic_partial": cph.AIC_partial_,
        "forest": [{"name": c["name"], "hr": c["hr"], "low": c["hr_ci_low"], "high": c["hr_ci_high"]}
                   for c in coefficients],
        "baseline_survival": {"timeline": base.index.to_numpy(), "survival": base.iloc[:, 0].to_numpy()},
    })
