import math

import numpy as np
import pandas as pd
import pytest

from tabular_helpers import PROJECT_ONLY, dataset, member, schema_text, synth, upload  # noqa: F401

NUMERIC = ["age", "bmi", "sbp", "dbp", "glucose", "diagnosis", "time_to_event", "event"]


@pytest.fixture
def ref(synth) -> pd.DataFrame:
    """直接以 pandas 讀原始 CSV 的參考值（TC-B04-01：與 pandas 直接計算差異 0）。"""
    return pd.read_csv(synth / "cohort_01.csv", float_precision="round_trip", keep_default_na=False,
                       na_values=[""])


def _get(client, pid, did, path, headers, **params):
    return client.get(f"/api/projects/{pid}/tabular/datasets/{did}/{path}", headers=headers, params=params)


def test_tc_b04_01_describe_matches_pandas(client, dataset, ref):
    pid, headers, did = dataset
    body = _get(client, pid, did, "describe", headers).json()
    assert body["row_count"] == len(ref) == 100
    cols = {c["name"]: c for c in body["columns"]}
    for name in NUMERIC:
        d = ref[name].describe()
        got = cols[name]
        assert (got["count"], got["missing"]) == (int(d["count"]), int(ref[name].isna().sum()))
        for key, ref_key in [("mean", "mean"), ("std", "std"), ("min", "min"), ("p25", "25%"),
                             ("p50", "50%"), ("p75", "75%"), ("max", "max")]:
            assert got[key] == d[ref_key], (name, key)
    for name in ["sex", "smoker"]:
        d = ref[name].describe()
        assert (cols[name]["top"], cols[name]["freq"], cols[name]["unique"]) == (d["top"], d["freq"], d["unique"])


def test_tc_b04_01_histogram_and_value_counts_match(client, dataset, ref):
    pid, headers, did = dataset
    hist = _get(client, pid, did, "histogram", headers, column="glucose", bins=8).json()
    counts, edges = np.histogram(ref["glucose"].dropna().to_numpy(), bins=8)
    assert hist["counts"] == counts.tolist() and hist["edges"] == edges.tolist() and hist["missing"] == 5
    vc = _get(client, pid, did, "value-counts", headers, column="smoker").json()
    assert {i["value"]: i["count"] for i in vc["items"]} == ref["smoker"].value_counts().to_dict()


def test_tc_b04_01_preview_matches_csv(client, dataset, ref):
    pid, headers, did = dataset
    body = _get(client, pid, did, "preview", headers, offset=10, limit=5).json()
    assert body["total_rows"] == 100 and body["columns"] == list(ref.columns)
    expected = [[None if isinstance(v, float) and math.isnan(v) else v for v in row]
                for row in ref.iloc[10:15].astype(object).values.tolist()]
    assert body["rows"] == expected


def test_tc_b04_02_preview_only_visible_columns(client, dataset):
    pid, headers, did = dataset
    visible = ["patient_id", "age", "diagnosis"]
    response = client.get(f"/api/projects/{pid}/tabular/datasets/{did}/preview", headers=headers,
                          params=[("columns", c) for c in visible] + [("limit", "3")])
    body = response.json()
    assert body["columns"] == visible and all(len(r) == 3 for r in body["rows"]) and len(body["rows"]) == 3


def test_tc_b04_05_correlation_and_scatter(client, dataset, ref):
    pid, headers, did = dataset
    corr = _get(client, pid, did, "correlation", headers).json()
    assert corr["columns"] == NUMERIC
    np.testing.assert_array_equal(np.array(corr["matrix"], dtype=float), ref[NUMERIC].corr().to_numpy())
    spearman = client.get(f"/api/projects/{pid}/tabular/datasets/{did}/correlation", headers=headers,
                          params=[("columns", "age"), ("columns", "sbp"), ("method", "spearman")]).json()
    assert spearman["matrix"][0][1] == ref[["age", "sbp"]].corr(method="spearman").iloc[0, 1]
    sc = _get(client, pid, did, "scatter", headers, x="age", y="glucose").json()
    assert sc["total"] == 95 and sc["returned"] == 95
    assert sc["points"] == ref[["age", "glucose"]].dropna().astype(float).values.tolist()


def test_tc_b04_08_text_and_empty_columns_give_clear_422(client, member, synth, schema_text):
    pid, headers = member("pi01")
    lines = (synth / "cohort_01.csv").read_text().splitlines()
    header = lines[0].split(",")
    bmi = header.index("bmi")
    blanked = [lines[0]] + [",".join("" if i == bmi else v for i, v in enumerate(line.split(",")))
                            for line in lines[1:]]
    did = upload(client, pid, headers, ("\n".join(blanked) + "\n").encode(), schema_text,
                 name="no-bmi").json()["dataset"]["id"]
    text = _get(client, pid, did, "histogram", headers, column="patient_id")
    assert text.status_code == 422 and text.json()["detail"]["message"] == "欄位「patient_id」不是數值欄位，無法進行數值分析"
    empty = _get(client, pid, did, "histogram", headers, column="bmi")
    assert empty.status_code == 422 and empty.json()["detail"]["code"] == "column_all_empty"
    scatter = _get(client, pid, did, "scatter", headers, x="sex", y="age")
    assert scatter.status_code == 422 and "不是數值欄位" in scatter.json()["detail"]["message"]


def test_unknown_column_and_bad_arguments_are_422(client, dataset):
    pid, headers, did = dataset
    missing = _get(client, pid, did, "value-counts", headers, column="nope")
    assert missing.status_code == 422 and missing.json()["detail"]["code"] == "column_not_found"
    assert _get(client, pid, did, "preview", headers, limit=5000).status_code == 422
    assert _get(client, pid, did, "correlation", headers, method="magic").status_code == 422


def test_viewer_can_explore_and_outsider_cannot(client, dataset, member, add_user):
    pid, _, did = dataset
    _, viewer = member("vw01", PROJECT_ONLY)
    assert _get(client, pid, did, "describe", viewer).status_code == 200
    _, outsider = add_user("user01")
    assert _get(client, pid, did, "describe", outsider).status_code == 403


def test_frame_loaded_from_clean_file_matches_upload_types(client, dataset):
    pid, headers, did = dataset
    body = client.get(f"/api/projects/{pid}/tabular/datasets/{did}", headers=headers).json()
    kinds = {c["name"]: c["kind"] for c in body["columns"]}
    assert kinds["age"] == "numeric" and kinds["smoker"] == "categorical" and kinds["patient_id"] == "categorical"
