"""訓練設定：TC-B05-02（參數保存）、TC-B05-03（資料增強 6 項）。"""
import copy

import pytest

from app.training import config as cfg
from conftest_training import AUGMENT, ok, setting_body

KINDS = list(cfg.KINDS)


def base(pid):
    return f"/api/projects/{pid}/training"


def body_for(kind, synth, table):
    return setting_body(kind, synth=synth, dataset_id=table)


@pytest.mark.parametrize("kind", KINDS)
def test_tc_b05_02_saved_parameters_reload_identically(kind, client, pi, project, synth, table):
    """設定影像範圍、Label、Resize、切分、隨機種子後重新載入，一致 100%。"""
    body = body_for(kind, synth, table)
    body["config"] |= {"split": {"train": 0.7, "validation": 0.1, "test": 0.2}, "seed": 20260929}
    if kind in cfg.IMAGE_KINDS:
        body["config"]["image"]["resize"] = [64, 48]
        if body["config"]["source"]["type"] == "dicom":
            chosen = sorted(body["config"]["source"]["label_source"].get("values", {"a": 1}))[:5]
            body["config"]["source"]["studies"] = chosen if kind == "image_classification" else "all"
    saved = ok(client.post(f"{base(project.id)}/settings", headers=pi, json=body), 201)
    for _ in range(3):
        again = ok(client.get(f"{base(project.id)}/settings/{saved['id']}", headers=pi))
        assert again == saved
    config = saved["config"]
    assert config["seed"] == 20260929 and config["split"] == {"train": 0.7, "validation": 0.1, "test": 0.2}
    if kind in cfg.IMAGE_KINDS:
        assert config["image"]["resize"] == [64, 48]
        assert config["image"]["labels"] == body["config"]["image"]["labels"]
        assert config["source"]["type"] == body["config"]["source"]["type"]
    else:
        assert config["tabular"]["target"] == body["config"]["tabular"]["target"]
        assert config["tabular"]["features"] == body["config"]["tabular"]["features"]
    # 存回去的就是正規化後的樣子：再存一次不會變
    updated = ok(client.put(f"{base(project.id)}/settings/{saved['id']}", headers=pi,
                            json={"name": saved["name"], "config": saved["config"]}))
    assert updated["config"] == saved["config"]
    assert [s["id"] for s in ok(client.get(f"{base(project.id)}/settings", headers=pi))] == [saved["id"]]


@pytest.mark.parametrize("kind", cfg.IMAGE_KINDS)
def test_tc_b05_03_six_augmentation_settings_are_kept_exactly(kind, client, pi, project, synth, table):
    """旋轉、長寬位移、Shear、Zoom、水平翻轉、垂直翻轉：存下來的設定與輸入差異 0。"""
    body = body_for(kind, synth, table)
    body["config"]["augmentation"] = AUGMENT
    saved = ok(client.post(f"{base(project.id)}/settings", headers=pi, json=body), 201)
    assert saved["config"]["augmentation"] == AUGMENT
    assert list(saved["config"]["augmentation"]) == list(cfg.AUGMENTATION)
    # 交給 Job 的 config.json 由同一份設定產生
    job = cfg.job_config(saved["config"], executor="template")
    assert job["augmentation"] == AUGMENT and "source" not in job


def test_tc_b05_03_each_augmentation_is_independent_and_defaults_to_off():
    base_config = setting_body("image_classification", synth=None, dataset_id=None,
                               source={"type": "dicom", "studies": "all",
                                       "label_source": {"provider": "makesense"}})["config"]
    for key, value in AUGMENT.items():
        config = copy.deepcopy(base_config) | {"augmentation": {key: value}}
        out = cfg.normalise(config)["augmentation"]
        assert out[key] == value
        assert all(not v for k, v in out.items() if k != key), "沒設定的項目維持關閉"


@pytest.mark.parametrize("change,message", [
    ({"augmentation": {"rotation_range": 200}}, "旋轉角度"),
    ({"augmentation": {"zoom_range": 1.5}}, "Zoom"),
    ({"augmentation": {"horizontal_flip": "yes"}}, "水平翻轉"),
    ({"augmentation": {"brightness": 0.2}}, "不支援的資料增強"),
    ({"split": {"train": 0.5, "validation": 0.2, "test": 0.2}}, "總和"),
    ({"split": {"train": 0, "validation": 0.5, "test": 0.5}}, "訓練集比例"),
    ({"seed": -1}, "亂數種子"),
    ({"seed": 1.5}, "亂數種子"),
    ({"image": {"resize": [32]}}, "Resize"),
    ({"image": {"resize": [4, 32]}}, "Resize"),
    ({"image": {"resize": [32, 32], "labels": ["CT"]}}, "至少需要 2 種"),
    ({"image": {"resize": [32, 32], "labels": ["CT", "CT"]}}, "重複"),
    ({"hyperparameters": {"epochs": 0}}, "訓練回合數"),
    ({"hyperparameters": {"momentum": 0.9}}, "不支援的超參數"),
    ({"kind": "image_captioning"}, "訓練種類"),
    ({"source": {"type": "tabular", "dataset_id": 1}}, "資料來源"),
    ({"tabular": {"target": "x", "features": ["y"]}}, "不可帶結構式設定"),
    ({"unknown": 1}, "不支援的設定欄位"),
])
def test_invalid_image_settings_are_rejected_in_chinese(change, message, client, pi, project, synth, table):
    body = body_for("image_classification", synth, table)
    body["config"] |= change
    response = client.post(f"{base(project.id)}/settings", headers=pi, json=body)
    assert response.status_code == 422 and message in response.json()["detail"], response.text


@pytest.mark.parametrize("change,message", [
    ({"tabular": {"target": "diagnosis", "features": []}}, "至少選擇一個特徵"),
    ({"tabular": {"target": "age", "features": ["age"]}}, "不可同時作為特徵"),
    ({"tabular": {"target": "diagnosis", "features": ["age"], "algorithm": "svm"}}, "可用的演算法"),
    ({"tabular": {"target": "diagnosis", "features": ["age"], "steps": [{"id": "nope"}]}}, "找不到前處理方法"),
    ({"hyperparameters": {"epochs": 3}}, "不支援的超參數"),
    ({"augmentation": {"rotation_range": 10}}, "不可帶影像設定或資料增強"),
])
def test_invalid_tabular_settings_are_rejected_in_chinese(change, message, client, pi, project, synth, table):
    body = body_for("tabular_classification", synth, table)
    body["config"] |= change
    response = client.post(f"{base(project.id)}/settings", headers=pi, json=body)
    assert response.status_code == 422 and message in response.json()["detail"], response.text


def test_segmentation_requires_labels_and_even_resize():
    good = setting_body("image_segmentation")["config"]
    assert cfg.normalise(good)["image"]["labels"] == ["class_1", "class_2"]
    for change, message in [({"resize": [33, 32], "labels": ["a"]}, "偶數"), ({"resize": [32, 32]}, "前景類別")]:
        with pytest.raises(cfg.ConfigError, match=message):
            cfg.normalise(good | {"image": change})


def test_settings_need_training_permission_and_are_audited(client, pi, member, project, synth, table, session,
                                                           add_user):
    from app.models import AuditLog
    from app.permissions import Role

    body = body_for("tabular_regression", synth, table)
    viewer, doctor = member("vw01", Role.VIEWER), member("md01", Role.MEDICAL_DOCTOR)
    outsider = add_user("user01")[1]
    for headers in (viewer, doctor, outsider):
        assert client.post(f"{base(project.id)}/settings", headers=headers, json=body).status_code == 403
        assert client.get(f"{base(project.id)}/settings", headers=headers).status_code == 403
    assert client.get(f"{base(project.id)}/settings").status_code == 401

    saved = ok(client.post(f"{base(project.id)}/settings", headers=pi, json=body), 201)
    assert client.post(f"{base(project.id)}/settings", headers=pi, json=body).status_code == 409, "同名"
    ok(client.put(f"{base(project.id)}/settings/{saved['id']}", headers=pi, json=body | {"name": "改名"}))
    assert client.delete(f"{base(project.id)}/settings/{saved['id']}", headers=pi).status_code == 204
    assert client.get(f"{base(project.id)}/settings/{saved['id']}", headers=pi).status_code == 404
    actions = [a.action for a in session.query(AuditLog).filter_by(category="training")
               if a.action.startswith("training_setting")]
    assert actions == ["training_setting.create", "training_setting.update", "training_setting.delete"]


def test_catalogue_lists_five_kinds_and_six_augmentations(client, pi, project):
    out = ok(client.get(f"{base(project.id)}/catalogue", headers=pi))
    assert [k["kind"] for k in out["kinds"]] == KINDS and len(KINDS) == 5
    assert {k["kind"]: k["model_format"] for k in out["kinds"]} == {
        "image_classification": "h5", "image_segmentation": "h5", "image_detection": "h5",
        "tabular_classification": "pkl", "tabular_regression": "pkl"}
    assert [a["name"] for a in out["augmentation"]] == list(AUGMENT)
