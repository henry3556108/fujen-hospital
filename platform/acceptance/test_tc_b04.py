"""TC-B04 結構式資料與醫學統計（經 Gateway）。執行方式見 tabular_support.py。

與 pandas／statsmodels／lifelines 的逐值比對在 platform/api/tests/test_tabular_*.py；
這裡驗證經 Gateway、真實 Keycloak token 與 PostgreSQL 時整條路徑可用且數值合理。
"""
import csv
import statistics

import pytest

from tabular_support import p2, synth, upload  # noqa: F401


@pytest.fixture
def ds(api, p2, synth):
    pid, pi, vw, created = p2
    response = upload(api, pid, pi, synth / "cohort_01.csv", (synth / "schema.json").read_text(), created)
    assert response.status_code == 201, response.text
    base = f"/api/projects/{pid}/tabular/datasets/{response.json()['dataset']['id']}"
    return base, pi, vw


def test_tc_b04_01_describe_and_preview(api, ds, synth):
    base, pi, _ = ds
    rows = list(csv.DictReader((synth / "cohort_01.csv").open()))
    ages = [int(r["age"]) for r in rows]
    describe = api.get(f"{base}/describe", headers=pi).json()
    age = next(c for c in describe["columns"] if c["name"] == "age")
    assert (age["count"], age["min"], age["max"]) == (len(ages), min(ages), max(ages))
    assert abs(age["mean"] - statistics.mean(ages)) < 1e-9 and abs(age["std"] - statistics.stdev(ages)) < 1e-9
    hist = api.get(f"{base}/histogram", headers=pi, params={"column": "age", "bins": 5}).json()
    assert sum(hist["counts"]) == len(ages)
    preview = api.get(f"{base}/preview", headers=pi, params={"offset": 0, "limit": 5}).json()
    assert [r[0] for r in preview["rows"]] == [r["patient_id"] for r in rows[:5]]


def test_tc_b04_03_target_feature_round_trip(api, ds):
    base, pi, vw = ds
    configs = [
        {"target": "diagnosis", "features": ["age", "sbp"], "steps": []},
        {"target": "diagnosis", "features": ["age", "glucose"], "steps": [{"id": "impute_mean", "columns": ["glucose"]}]},
        {"target": "event", "features": ["age", "smoker_current", "smoker_former", "smoker_never"],
         "steps": [{"id": "onehot", "columns": ["smoker"]}]},
    ]
    for config in configs:
        saved = api.put(f"{base}/target-feature", headers=pi, json=config)
        assert saved.status_code == 200, saved.text
        assert api.get(f"{base}/target-feature", headers=pi).json()["config"] == saved.json()["config"]
    assert api.put(f"{base}/target-feature", headers=vw, json=configs[0]).status_code == 403


def test_tc_b04_05_correlation_and_scatter(api, ds):
    base, pi, _ = ds
    assert api.get(f"{base}/correlation", headers=pi).status_code == 200
    scatter = api.get(f"{base}/scatter", headers=pi, params={"x": "age", "y": "sbp"})
    assert scatter.status_code == 200 and scatter.json()["total"] == 100


def test_tc_b04_06_catalogue(api, p2):
    pid, _, vw, _ = p2
    items = api.get(f"/api/projects/{pid}/tabular/preprocessing/catalogue", headers=vw).json()
    assert len(items) >= 50


def test_tc_b04_07_four_statistics(api, ds):
    base, pi, _ = ds
    calls = {
        "logistic": {"target": "diagnosis", "features": ["age", "sbp"]},
        "linear": {"target": "sbp", "features": ["age", "bmi"]},
        "kaplan-meier": {"duration": "time_to_event", "event": "event", "group": "sex"},
        "cox": {"duration": "time_to_event", "event": "event", "covariates": ["age", "diagnosis"]},
    }
    for kind, body in calls.items():
        response = api.post(f"{base}/stats/{kind}", headers=pi, json=body, timeout=60)
        assert response.status_code == 200, (kind, response.text)
    km = api.post(f"{base}/stats/kaplan-meier", headers=pi, json=calls["kaplan-meier"]).json()
    assert len(km["groups"]) == 2 and km["logrank"]["p_value"] is not None


def test_tc_b04_08_text_column_is_422(api, ds):
    base, pi, _ = ds
    response = api.post(f"{base}/stats/linear", headers=pi, json={"target": "sbp", "features": ["patient_id"]})
    assert response.status_code == 422
    assert response.json()["detail"]["message"] == "欄位「patient_id」不是數值欄位，無法進行數值分析"
