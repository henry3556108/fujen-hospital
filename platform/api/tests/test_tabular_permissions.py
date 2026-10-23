"""CSV 越權修正：建立／刪除資料集、儲存 Target／Feature 與前處理步驟需 Training；預檢、讀取、欄位隱藏、統計維持 Project。"""
from tabular_helpers import PROJECT_ONLY, WITH_TRAINING, dataset, member, schema_text, synth, upload  # noqa: F401

CONFIG = {"target": "diagnosis", "features": ["age", "sbp"]}
CONFIG_WITH_STEPS = {"target": "diagnosis", "features": ["age", "sbp"],
                     "steps": [{"id": "impute_median", "columns": ["sbp"]}]}


def _base(pid):
    return f"/api/projects/{pid}/tabular"


def _denied(response):
    assert response.status_code == 403, response.text
    assert response.json()["detail"]["permission"] == "training"


def test_viewer_cannot_create_delete_or_save(client, dataset, member, synth, schema_text):
    pid, _, did = dataset
    _, viewer = member("vw01", PROJECT_ONLY)
    _denied(upload(client, pid, viewer, (synth / "cohort_01.csv").read_bytes(), schema_text, name="x"))
    _denied(client.delete(f"{_base(pid)}/datasets/{did}", headers=viewer))
    _denied(client.put(f"{_base(pid)}/datasets/{did}/target-feature", headers=viewer, json=CONFIG))
    _denied(client.put(f"{_base(pid)}/datasets/{did}/target-feature", headers=viewer, json=CONFIG_WITH_STEPS))
    # 資料集仍在、設定沒存
    assert client.get(f"{_base(pid)}/datasets/{did}", headers=viewer).status_code == 200
    assert client.get(f"{_base(pid)}/datasets/{did}/target-feature", headers=viewer).status_code == 404


def test_viewer_keeps_project_level_actions(client, dataset, member, synth, schema_text):
    pid, _, did = dataset
    _, viewer = member("vw01", PROJECT_ONLY)
    raw = (synth / "cohort_01.csv").read_bytes()
    files = {"file": ("data.csv", raw, "text/csv")}
    assert client.post(f"{_base(pid)}/schema/infer", headers=viewer, files=files).status_code == 200
    assert client.post(f"{_base(pid)}/schema/check", headers=viewer, files=files,
                       data={"schema": schema_text}).status_code == 200
    assert client.get(f"{_base(pid)}/datasets", headers=viewer).status_code == 200
    assert client.get(f"{_base(pid)}/datasets/{did}/preview", headers=viewer).status_code == 200
    assert client.put(f"{_base(pid)}/datasets/{did}/column-view", headers=viewer,
                      json={"hidden": ["age"]}).status_code == 200
    assert client.post(f"{_base(pid)}/datasets/{did}/stats/linear", headers=viewer,
                       json={"target": "sbp", "features": ["age"]}).status_code == 200


def test_ra_with_training_can_create_save_and_delete(client, member, synth, schema_text):
    pid, ra = member("ra01", WITH_TRAINING)
    created = upload(client, pid, ra, (synth / "cohort_01.csv").read_bytes(), schema_text, name="ra")
    assert created.status_code == 201, created.text
    did = created.json()["dataset"]["id"]
    saved = client.put(f"{_base(pid)}/datasets/{did}/target-feature", headers=ra, json=CONFIG)
    assert saved.status_code == 200, saved.text
    assert client.delete(f"{_base(pid)}/datasets/{did}", headers=ra).status_code == 204
