from sqlalchemy import select
from tabular.modeling_config import TargetFeatureConfig

from app.models import AuditLog
from tabular_helpers import PROJECT_ONLY, dataset, member, schema_text, synth, upload  # noqa: F401

CONFIGS = [
    {"target": "diagnosis", "features": ["age", "sbp", "glucose"],
     "steps": [{"id": "impute_median", "columns": ["glucose"]}]},
    {"target": "diagnosis", "features": ["age", "bmi", "smoker_former", "smoker_never"],
     "steps": [{"id": "impute_mean", "columns": ["bmi"]}, {"id": "onehot", "columns": ["smoker"],
                                                          "params": {"drop_first": True}}]},
    {"target": "time_to_event", "features": ["age", "dbp"], "steps": []},
]


def _url(pid, did):
    return f"/api/projects/{pid}/tabular/datasets/{did}/target-feature"


def test_tc_b04_03_target_feature_round_trip_three_times(client, dataset):
    pid, headers, did = dataset
    for config in CONFIGS:
        saved = client.put(_url(pid, did), headers=headers, json=config)
        assert saved.status_code == 200, saved.text
        expected = TargetFeatureConfig.from_dict(config).to_dict()
        assert saved.json()["config"] == expected
        loaded = client.get(_url(pid, did), headers=headers)  # 「重新載入」
        assert loaded.status_code == 200 and loaded.json()["config"] == expected
        assert TargetFeatureConfig.from_dict(loaded.json()["config"]) == TargetFeatureConfig.from_dict(config)
        # 再存一次讀回的內容，仍完全一致
        again = client.put(_url(pid, did), headers=headers, json=loaded.json()["config"]).json()["config"]
        assert again == expected


def test_no_config_yet_is_404(client, dataset):
    pid, headers, did = dataset
    response = client.get(_url(pid, did), headers=headers)
    assert response.status_code == 404 and "尚未設定" in response.json()["detail"]


def test_saving_requires_training_permission(client, dataset, member):
    pid, _, did = dataset
    _, viewer = member("vw01", PROJECT_ONLY)
    response = client.put(_url(pid, did), headers=viewer, json=CONFIGS[0])
    assert response.status_code == 403 and response.json()["detail"]["permission"] == "training"
    assert client.get(_url(pid, did), headers=viewer).status_code == 404  # 讀取只需 project


def test_config_columns_must_exist_after_steps(client, dataset):
    pid, headers, did = dataset
    missing = client.put(_url(pid, did), headers=headers, json={"target": "diagnosis", "features": ["nope"]})
    assert missing.status_code == 422 and missing.json()["detail"]["code"] == "column_not_found"
    # smoker 被 onehot 移除後就不能再當特徵
    dropped = client.put(_url(pid, did), headers=headers, json={
        "target": "diagnosis", "features": ["smoker"], "steps": [{"id": "onehot", "columns": ["smoker"]}]})
    assert dropped.status_code == 422
    same = client.put(_url(pid, did), headers=headers, json={"target": "age", "features": ["age"]})
    assert same.status_code == 422 and "不可同時作為特徵欄位" in same.json()["detail"]["message"]


def test_config_save_is_audited_as_training_with_row_counts(client, dataset, session):
    pid, headers, did = dataset
    client.put(_url(pid, did), headers=headers, json=CONFIGS[0])
    entry = session.scalars(select(AuditLog).where(AuditLog.action == "target_feature_save")).one()
    assert entry.category == "training" and entry.actor == "pi01"
    assert entry.target == f"tabular_dataset:{did}"
    assert entry.detail["target"] == "diagnosis" and entry.detail["features"] == ["age", "sbp", "glucose"]
    assert entry.detail["valid_rows"] == 100 and entry.detail["project_id"] == pid


def test_config_removed_with_dataset(client, dataset):
    pid, headers, did = dataset
    client.put(_url(pid, did), headers=headers, json=CONFIGS[0])
    assert client.delete(f"/api/projects/{pid}/tabular/datasets/{did}", headers=headers).status_code == 204
    assert client.get(_url(pid, did), headers=headers).status_code == 404
