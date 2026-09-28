"""TC-B04-07 (Logistic, Linear, Kaplan-Meier, Cox: statistics + chart data, equal to
statsmodels / lifelines reference to 1e-9) and TC-B04-08 (text / all-empty columns)."""

import json

import numpy as np
import pandas as pd
import pytest
import statsmodels.api as sm
from lifelines import CoxPHFitter, KaplanMeierFitter
from lifelines.datasets import load_rossi
from lifelines.statistics import multivariate_logrank_test
from sklearn.metrics import roc_auc_score

from tabular.errors import TabularError
from tabular.stats import cox, kaplan_meier, linear, logistic

TOL = 1e-9
LOGIT_FEATURES = ["age", "bmi", "cholesterol", "smoker"]
OLS_FEATURES = ["age", "bmi", "smoker"]


def _strict_json(obj):
    return json.loads(json.dumps(obj, allow_nan=False))


def _is_zh(text):
    return any("一" <= ch <= "鿿" for ch in text)


def _ref_frame(df, cols):
    return df[cols].astype("float64").dropna()


def _coef_table(result):
    return {c["name"]: c for c in result["coefficients"]}


# ------------------------------------------------------------------ logistic

def test_logistic_matches_statsmodels(patients_df):
    result = _strict_json(logistic(patients_df, "outcome", LOGIT_FEATURES))
    d = _ref_frame(patients_df, ["outcome", *LOGIT_FEATURES])
    ref = sm.Logit(d["outcome"], sm.add_constant(d[LOGIT_FEATURES])).fit(disp=0)
    ci = ref.conf_int()
    table = _coef_table(result)
    assert list(table) == ["const", *LOGIT_FEATURES]
    for name in table:
        row = table[name]
        assert abs(row["coef"] - ref.params[name]) < TOL
        assert abs(row["std_err"] - ref.bse[name]) < TOL
        assert abs(row["z"] - ref.tvalues[name]) < TOL
        assert abs(row["p"] - ref.pvalues[name]) < TOL
        assert abs(row["ci_low"] - ci.loc[name, 0]) < TOL
        assert abs(row["ci_high"] - ci.loc[name, 1]) < TOL
        assert abs(row["odds_ratio"] - np.exp(ref.params[name])) < TOL
        assert abs(row["or_ci_low"] - np.exp(ci.loc[name, 0])) < TOL
        assert abs(row["or_ci_high"] - np.exp(ci.loc[name, 1])) < TOL
    assert abs(result["aic"] - ref.aic) < TOL
    assert abs(result["pseudo_r2"] - ref.prsquared) < TOL
    assert result["n"] == len(d) == 94
    assert result["n_dropped"] == 6


def test_logistic_roc_curve(patients_df):
    result = _strict_json(logistic(patients_df, "outcome", LOGIT_FEATURES))
    d = _ref_frame(patients_df, ["outcome", *LOGIT_FEATURES])
    ref = sm.Logit(d["outcome"], sm.add_constant(d[LOGIT_FEATURES])).fit(disp=0)
    roc = result["roc"]
    assert abs(roc["auc"] - roc_auc_score(d["outcome"], ref.predict())) < TOL
    assert roc["fpr"][0] == 0 and roc["tpr"][-1] == 1
    assert len(roc["fpr"]) == len(roc["tpr"]) == len(roc["thresholds"])


def test_logistic_rejects_non_binary_target(patients_df):
    with pytest.raises(TabularError) as exc:
        logistic(patients_df, "age", ["bmi"])
    assert _is_zh(exc.value.message)


def test_logistic_perfect_separation_is_tabular_error():
    df = pd.DataFrame({"y": [0, 0, 0, 0, 1, 1, 1, 1], "x": [1, 2, 3, 4, 5, 6, 7, 8]})
    with pytest.raises(TabularError) as exc:
        logistic(df, "y", ["x"])
    assert _is_zh(exc.value.message)


# ------------------------------------------------------------------ linear

def test_linear_matches_statsmodels(patients_df):
    result = _strict_json(linear(patients_df, "cholesterol", OLS_FEATURES))
    d = _ref_frame(patients_df, ["cholesterol", *OLS_FEATURES])
    ref = sm.OLS(d["cholesterol"], sm.add_constant(d[OLS_FEATURES])).fit()
    ci = ref.conf_int()
    for name, row in _coef_table(result).items():
        assert abs(row["coef"] - ref.params[name]) < TOL
        assert abs(row["std_err"] - ref.bse[name]) < TOL
        assert abs(row["t"] - ref.tvalues[name]) < TOL
        assert abs(row["p"] - ref.pvalues[name]) < TOL
        assert abs(row["ci_low"] - ci.loc[name, 0]) < TOL
        assert abs(row["ci_high"] - ci.loc[name, 1]) < TOL
    assert abs(result["r2"] - ref.rsquared) < TOL
    assert abs(result["adj_r2"] - ref.rsquared_adj) < TOL
    assert abs(result["f_statistic"] - ref.fvalue) < TOL
    assert abs(result["f_p_value"] - ref.f_pvalue) < TOL
    assert abs(result["aic"] - ref.aic) < TOL
    assert result["n"] == len(d)


def test_linear_residual_points(patients_df):
    result = _strict_json(linear(patients_df, "cholesterol", OLS_FEATURES))
    d = _ref_frame(patients_df, ["cholesterol", *OLS_FEATURES])
    ref = sm.OLS(d["cholesterol"], sm.add_constant(d[OLS_FEATURES])).fit()
    pts = result["residuals"]["points"]
    assert len(pts) == len(d)
    assert np.allclose(np.array(pts), np.column_stack([ref.fittedvalues, ref.resid]), atol=TOL)


# ------------------------------------------------------------------ Kaplan-Meier

def test_kaplan_meier_single_group_matches_lifelines(patients_df):
    result = _strict_json(kaplan_meier(patients_df, "time", "event"))
    kmf = KaplanMeierFitter().fit(patients_df["time"].astype(float), patients_df["event"].astype(float))
    assert len(result["groups"]) == 1 and result["logrank"] is None
    g = result["groups"][0]
    assert g["n"] == 100 and g["events"] == int(patients_df["event"].sum())
    assert np.allclose(g["timeline"], kmf.survival_function_.index.to_numpy(), atol=TOL)
    assert np.allclose(g["survival"], kmf.survival_function_.iloc[:, 0].to_numpy(), atol=TOL)
    assert np.allclose(g["ci_lower"], kmf.confidence_interval_.iloc[:, 0].to_numpy(), atol=TOL)
    assert np.allclose(g["ci_upper"], kmf.confidence_interval_.iloc[:, 1].to_numpy(), atol=TOL)
    assert g["median_survival"] == kmf.median_survival_time_ or (
        g["median_survival"] is None and np.isinf(kmf.median_survival_time_))


def test_kaplan_meier_grouped_with_logrank(patients_df):
    result = _strict_json(kaplan_meier(patients_df, "time", "event", group="group"))
    assert [g["group"] for g in result["groups"]] == ["A", "B"]
    for g in result["groups"]:
        sub = patients_df[patients_df["group"] == g["group"]]
        kmf = KaplanMeierFitter().fit(sub["time"].astype(float), sub["event"].astype(float))
        assert np.allclose(g["survival"], kmf.survival_function_.iloc[:, 0].to_numpy(), atol=TOL)
        assert g["n"] == len(sub)
    ref = multivariate_logrank_test(patients_df["time"].astype(float), patients_df["group"].astype(str),
                                    patients_df["event"].astype(float))
    assert abs(result["logrank"]["p_value"] - ref.p_value) < TOL
    assert abs(result["logrank"]["test_statistic"] - ref.test_statistic) < TOL


def test_kaplan_meier_rossi_median_matches_lifelines():
    rossi = load_rossi()
    result = kaplan_meier(rossi, "week", "arrest", group="fin")
    for g in result["groups"]:
        sub = rossi[rossi["fin"].astype(str) == g["group"]]
        kmf = KaplanMeierFitter().fit(sub["week"], sub["arrest"])
        ref = kmf.median_survival_time_
        assert (g["median_survival"] is None and np.isinf(ref)) or g["median_survival"] == ref


# ------------------------------------------------------------------ Cox

COX_COVARIATES = ["fin", "age", "race", "wexp", "mar", "paro", "prio"]


def test_cox_matches_lifelines_on_rossi():
    rossi = load_rossi()
    result = _strict_json(cox(rossi, "week", "arrest", COX_COVARIATES))
    ref = CoxPHFitter().fit(rossi, duration_col="week", event_col="arrest")
    s = ref.summary
    table = _coef_table(result)
    assert list(table) == COX_COVARIATES
    for name, row in table.items():
        assert abs(row["coef"] - s.loc[name, "coef"]) < TOL
        assert abs(row["hr"] - s.loc[name, "exp(coef)"]) < TOL
        assert abs(row["std_err"] - s.loc[name, "se(coef)"]) < TOL
        assert abs(row["z"] - s.loc[name, "z"]) < TOL
        assert abs(row["p"] - s.loc[name, "p"]) < TOL
        assert abs(row["hr_ci_low"] - s.loc[name, "exp(coef) lower 95%"]) < TOL
        assert abs(row["hr_ci_high"] - s.loc[name, "exp(coef) upper 95%"]) < TOL
    assert abs(result["concordance"] - ref.concordance_index_) < TOL
    assert abs(result["aic_partial"] - ref.AIC_partial_) < TOL
    assert abs(result["log_likelihood"] - ref.log_likelihood_) < TOL
    assert result["n"] == 432 and result["events"] == int(rossi["arrest"].sum())
    base = result["baseline_survival"]
    assert np.allclose(base["survival"], ref.baseline_survival_.iloc[:, 0].to_numpy(), atol=TOL)
    assert len(result["forest"]) == len(COX_COVARIATES)


def test_cox_on_fixture_drops_missing(patients_df):
    result = cox(patients_df, "time", "event", ["age", "bmi"])
    d = _ref_frame(patients_df, ["time", "event", "age", "bmi"])
    ref = CoxPHFitter().fit(d, duration_col="time", event_col="event")
    assert abs(_coef_table(result)["age"]["coef"] - ref.params_["age"]) < TOL
    assert result["n"] == len(d)


# ------------------------------------------------------------------ TC-B04-08

@pytest.fixture
def bad_df(patients_df):
    df = patients_df.copy()
    df["empty"] = np.nan
    df["empty_text"] = pd.Series([None] * len(df), dtype="object")
    return df


@pytest.mark.parametrize(
    "call",
    [
        lambda d: logistic(d, "outcome", ["diagnosis"]),
        lambda d: logistic(d, "outcome", ["empty"]),
        lambda d: logistic(d, "diagnosis", ["age"]),
        lambda d: logistic(d, "outcome", ["outcome"]),
        lambda d: logistic(d, "outcome", []),
        lambda d: linear(d, "diagnosis", ["age"]),
        lambda d: linear(d, "cholesterol", ["sex"]),
        lambda d: linear(d, "empty", ["age"]),
        lambda d: linear(d, "cholesterol", ["empty_text"]),
        lambda d: linear(d, "cholesterol", ["nope"]),
        lambda d: kaplan_meier(d, "diagnosis", "event"),
        lambda d: kaplan_meier(d, "time", "empty"),
        lambda d: kaplan_meier(d, "time", "age"),       # event must be 0/1
        lambda d: kaplan_meier(d, "age", "event", group="patient_id"),  # too many groups
        lambda d: cox(d, "time", "event", ["diagnosis"]),
        lambda d: cox(d, "time", "event", ["empty"]),
        lambda d: cox(d, "empty", "event", ["age"]),
    ],
)
def test_statistics_reject_bad_columns_with_chinese_message(bad_df, call):
    with pytest.raises(TabularError) as exc:
        call(bad_df)
    assert _is_zh(exc.value.message)
    json.dumps(exc.value.to_dict(), allow_nan=False)


def test_negative_durations_rejected(patients_df):
    df = patients_df.copy()
    df.loc[0, "time"] = -1
    with pytest.raises(TabularError):
        kaplan_meier(df, "time", "event")


def test_all_results_are_strict_json(patients_df):
    for obj in [
        logistic(patients_df, "outcome", LOGIT_FEATURES),
        linear(patients_df, "cholesterol", OLS_FEATURES),
        kaplan_meier(patients_df, "time", "event", group="sex"),
        cox(patients_df, "time", "event", ["age", "smoker"]),
    ]:
        json.dumps(obj, allow_nan=False)
