import numpy as np
import pandas as pd
import pytest
import statsmodels.api as sm
from lifelines import CoxPHFitter, KaplanMeierFitter
from lifelines.statistics import multivariate_logrank_test

from tabular_helpers import PROJECT_ONLY, dataset, member, schema_text, synth, upload  # noqa: F401

TOL = 1e-9


@pytest.fixture
def ref(synth) -> pd.DataFrame:
    return pd.read_csv(synth / "cohort_01.csv", float_precision="round_trip")


def _stats(client, pid, did, headers, kind, body):
    return client.post(f"/api/projects/{pid}/tabular/datasets/{did}/stats/{kind}", headers=headers, json=body)


def _coefs(body):
    return {c["name"]: c for c in body["coefficients"]}


def test_tc_b04_07_logistic_matches_statsmodels(client, dataset, ref):
    pid, headers, did = dataset
    features = ["age", "sbp", "glucose"]
    response = _stats(client, pid, did, headers, "logistic", {"target": "diagnosis", "features": features})
    assert response.status_code == 200, response.text
    body = response.json()
    data = ref[["diagnosis", *features]].dropna()
    model = sm.Logit(data["diagnosis"], sm.add_constant(data[features])).fit(disp=0)
    assert body["n"] == 95 and body["n_dropped"] == 5
    got = _coefs(body)
    for name, coef in model.params.items():
        assert abs(got[name]["coef"] - coef) < TOL and abs(got[name]["p"] - model.pvalues[name]) < TOL
    assert abs(body["aic"] - model.aic) < TOL
    assert len(body["roc"]["fpr"]) == len(body["roc"]["tpr"]) > 2  # 圖表資料


def test_tc_b04_07_linear_matches_statsmodels(client, dataset, ref):
    pid, headers, did = dataset
    body = _stats(client, pid, did, headers, "linear", {"target": "sbp", "features": ["age", "bmi"]}).json()
    model = sm.OLS(ref["sbp"].astype(float), sm.add_constant(ref[["age", "bmi"]].astype(float))).fit()
    got = _coefs(body)
    for name, coef in model.params.items():
        assert abs(got[name]["coef"] - coef) < TOL
    assert abs(body["r2"] - model.rsquared) < TOL and abs(body["adj_r2"] - model.rsquared_adj) < TOL
    assert len(body["residuals"]["points"]) == 100


def test_tc_b04_07_kaplan_meier_matches_lifelines(client, dataset, ref):
    pid, headers, did = dataset
    body = _stats(client, pid, did, headers, "kaplan-meier",
                  {"duration": "time_to_event", "event": "event", "group": "sex"}).json()
    assert [g["group"] for g in body["groups"]] == ["F", "M"]
    for g in body["groups"]:
        part = ref[ref["sex"] == g["group"]]
        kmf = KaplanMeierFitter().fit(part["time_to_event"], part["event"])
        np.testing.assert_allclose(g["survival"], kmf.survival_function_.iloc[:, 0].to_numpy(), rtol=0, atol=TOL)
        assert g["timeline"] == kmf.survival_function_.index.tolist()
    test = multivariate_logrank_test(ref["time_to_event"], ref["sex"], ref["event"])
    assert abs(body["logrank"]["p_value"] - test.p_value) < TOL


def test_tc_b04_07_cox_matches_lifelines(client, dataset, ref):
    pid, headers, did = dataset
    response = _stats(client, pid, did, headers, "cox", {
        "duration": "time_to_event", "event": "event", "covariates": ["age", "diagnosis", "sex_M"],
        "steps": [{"id": "onehot", "columns": ["sex"], "params": {"drop_first": True}}]})
    assert response.status_code == 200, response.text
    body = response.json()
    frame = ref[["time_to_event", "event", "age", "diagnosis"]].astype(float)
    frame["sex_M"] = (ref["sex"] == "M").astype(float)
    cph = CoxPHFitter().fit(frame, duration_col="time_to_event", event_col="event")
    got = _coefs(body)
    for name in ["age", "diagnosis", "sex_M"]:
        assert abs(got[name]["coef"] - cph.params_[name]) < 1e-6
        assert abs(got[name]["hr"] - np.exp(cph.params_[name])) < 1e-6
    assert abs(body["concordance"] - cph.concordance_index_) < 1e-9
    assert len(body["forest"]) == 3 and len(body["baseline_survival"]["timeline"]) > 0


def test_tc_b04_08_text_and_empty_columns_in_statistics_give_clear_422(client, member, synth, schema_text):
    pid, headers = member("pi01")
    lines = (synth / "cohort_01.csv").read_text().splitlines()
    bmi = lines[0].split(",").index("bmi")
    blanked = [lines[0]] + [",".join("" if i == bmi else v for i, v in enumerate(line.split(",")))
                            for line in lines[1:]]
    did = upload(client, pid, headers, ("\n".join(blanked) + "\n").encode(), schema_text,
                 name="no-bmi").json()["dataset"]["id"]
    cases = [
        ("linear", {"target": "sbp", "features": ["patient_id"]}, "column_not_numeric"),
        ("logistic", {"target": "diagnosis", "features": ["smoker"]}, "column_not_numeric"),
        ("linear", {"target": "sbp", "features": ["bmi"]}, "column_all_empty"),
        ("cox", {"duration": "time_to_event", "event": "event", "covariates": ["bmi"]}, "column_all_empty"),
        ("kaplan-meier", {"duration": "sex", "event": "event"}, "column_not_numeric"),
        ("logistic", {"target": "age", "features": ["sbp"]}, "not_binary"),
    ]
    for kind, body, code in cases:
        response = _stats(client, pid, did, headers, kind, body)
        assert response.status_code == 422, (kind, body, response.text)
        detail = response.json()["detail"]
        assert detail["code"] == code and detail["message"], (kind, body)


def test_missing_fields_are_422_and_viewer_can_run_stats(client, dataset, member):
    pid, _, did = dataset
    _, viewer = member("vw01", PROJECT_ONLY)
    assert _stats(client, pid, did, viewer, "linear", {"target": "sbp"}).status_code == 422
    assert _stats(client, pid, did, viewer, "linear", {"target": "sbp", "features": ["age"]}).status_code == 200
