import re
from pathlib import Path

import numpy as np
import pandas as pd
import tabular
from sklearn.impute import SimpleImputer
from sklearn.preprocessing import OneHotEncoder
from tabular import preprocess

from tabular_helpers import PROJECT_ONLY, dataset, member, schema_text, synth, upload  # noqa: F401


def _preview(client, pid, did, headers, body):
    return client.post(f"/api/projects/{pid}/tabular/datasets/{did}/preprocess/preview", headers=headers, json=body)


def test_tc_b04_06_catalogue_at_least_50_and_matches_library(client, member):
    pid, headers = member("vw01", PROJECT_ONLY)
    response = client.get(f"/api/projects/{pid}/tabular/preprocessing/catalogue", headers=headers)
    assert response.status_code == 200
    items = response.json()
    assert len(items) >= 50
    assert items == preprocess.catalogue()
    readme = (Path(tabular.__file__).resolve().parents[1] / "README.md").read_text()
    table = readme.split("<!-- catalogue:start -->")[1].split("<!-- catalogue:end -->")[0]
    documented = re.findall(r"^\| `([a-z0-9_]+)` \|", table, flags=re.M)
    assert [i["id"] for i in items] == documented  # 與文件清單差異 0


def test_catalogue_requires_membership(client, member, add_user):
    pid, _ = member("pi01")
    _, outsider = add_user("user01")
    assert client.get(f"/api/projects/{pid}/tabular/preprocessing/catalogue", headers=outsider).status_code == 403


def test_tc_b04_04_impute_and_onehot_match_sklearn(client, dataset, synth):
    pid, headers, did = dataset
    steps = [{"id": "impute_mean", "columns": ["glucose"]}, {"id": "onehot", "columns": ["smoker"]}]
    response = _preview(client, pid, did, headers, {"steps": steps, "limit": 100})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["row_count"] == 100
    out = pd.DataFrame(body["preview"]["rows"], columns=body["preview"]["columns"])

    ref = pd.read_csv(synth / "cohort_01.csv", float_precision="round_trip")
    imputed = SimpleImputer(strategy="mean").fit_transform(ref[["glucose"]])[:, 0]
    np.testing.assert_allclose(out["glucose"].to_numpy(dtype=float), imputed, rtol=0, atol=1e-12)
    enc = OneHotEncoder(sparse_output=False).fit(ref[["smoker"]])
    expected = pd.DataFrame(enc.transform(ref[["smoker"]]), columns=enc.get_feature_names_out(["smoker"]))
    for name in expected.columns:
        assert out[name].tolist() == expected[name].astype(int).tolist()
    assert "smoker" not in out.columns
    kinds = {c["name"]: c["kind"] for c in body["columns"]}
    assert kinds["smoker_current"] == "numeric" and kinds["glucose"] == "numeric"


def test_preview_does_not_change_stored_dataset(client, dataset):
    pid, headers, did = dataset
    _preview(client, pid, did, headers, {"steps": [{"id": "drop_columns", "columns": ["age"]}]})
    describe = client.get(f"/api/projects/{pid}/tabular/datasets/{did}/describe", headers=headers).json()
    assert "age" in [c["name"] for c in describe["columns"]]


def test_preview_bad_step_is_422(client, dataset):
    pid, headers, did = dataset
    unknown = _preview(client, pid, did, headers, {"steps": [{"id": "magic"}]})
    assert unknown.status_code == 422 and unknown.json()["detail"]["code"] == "unknown_step"
    wrong_type = _preview(client, pid, did, headers, {"steps": [{"id": "scale_standard", "columns": ["sex"]}]})
    assert wrong_type.status_code == 422 and "不適用於欄位「sex」" in wrong_type.json()["detail"]["message"]
