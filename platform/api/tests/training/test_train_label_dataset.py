"""以標註資料集訓練：送出時自動建版、只用已確認的標註、run 記錄資料集與版本、測試集筆數；專案首頁的訓練區塊。"""
from app.labeling.models import Annotation
from conftest_training import finish, ok, start, upload_dicom
from test_train_from_annotations import slices


def _classify_studies(client, pi, pid, synth, labels: dict[int, str]) -> None:
    for no, label in labels.items():
        study, _, _ = slices(synth, no)[0]
        ok(client.post(f"/api/projects/{pid}/labels/annotations", headers=pi,
                       json={"study_instance_uid": study, "kind": "classification", "payload": {"label": label}}), 201)


def _body(dataset_id, kind="image_classification", name="資料集訓練"):
    return {"name": name, "config": {
        "kind": kind, "label_dataset_id": dataset_id,
        "source": {"type": "dicom", "studies": "all"},
        "image": {"resize": [32, 32], "labels": ["nodule", "normal"]}, "split": {"train": 0.6, "validation": 0.2, "test": 0.2},
        "seed": 42}}


def _version(client, pi, run):
    return ok(client.get(f"/api/projects/{run['project_id']}/training/dataset-versions/{run['dataset_version_id']}",
                         headers=pi))


def test_run_uses_label_dataset_version(client, pi, project, backend, orthanc, synth, session, tmp_path):
    upload_dicom(client, pi, project.id, synth, range(1, 6))
    _classify_studies(client, pi, project.id, synth, {1: "nodule", 2: "normal", 3: "nodule", 4: "normal"})
    study5, _, _ = slices(synth, 5)[0]
    session.add(Annotation(project_id=project.id, study_instance_uid=study5, kind="classification",
                           payload={"label": "nodule"}, source="autolabel", status="draft",
                           created_by="robot", updated_by="robot"))
    session.commit()
    base = f"/api/projects/{project.id}/labels/datasets"
    ds = ok(client.get(base, headers=pi))[0]
    assert ds["task"] == "classification" and ds["current"]["drafts_excluded"] == 1

    setting = ok(client.post(f"/api/projects/{project.id}/training/settings", headers=pi, json=_body(ds["id"])), 201)
    assert setting["config"]["source"]["label_dataset_id"] == ds["id"]
    assert "label_dataset_id" not in setting["config"]
    run = ok(client.post(f"/api/projects/{project.id}/training/settings/{setting['id']}/runs", headers=pi,
                         json={"executor": "fake"}), 201)
    assert run["label_dataset"] == {"id": ds["id"], "name": ds["name"], "version": 1}
    assert run["test_count"] is None
    frozen = _version(client, pi, run)
    assert frozen["item_count"] == 4 * 5                      # 草稿（研究 5）不納入

    again = ok(client.post(f"/api/projects/{project.id}/training/settings/{setting['id']}/runs", headers=pi,
                           json={"executor": "fake"}), 201)
    assert again["label_dataset"]["version"] == 1             # 內容沒變：沿用第 1 版
    versions = ok(client.get(f"{base}/{ds['id']}/versions", headers=pi))
    assert [v["version"] for v in versions] == [1]

    done = finish(client, backend, pi, run, tmp_path)
    assert done["status"] == "succeeded" and isinstance(done["test_count"], int) and done["test_count"] >= 1

    rerun = ok(client.post(f"/api/projects/{project.id}/training/runs/{run['id']}/rerun", headers=pi), 201)
    assert rerun["label_dataset"] == run["label_dataset"]

    # 確認草稿後再送：自動建第 2 版
    draft = session.query(Annotation).filter_by(status="draft").one()
    ok(client.post(f"/api/projects/{project.id}/labels/annotations/{draft.id}/confirm", headers=pi))
    third = ok(client.post(f"/api/projects/{project.id}/training/settings/{setting['id']}/runs", headers=pi,
                           json={"executor": "fake"}), 201)
    assert third["label_dataset"]["version"] == 2 and _version(client, pi, third)["item_count"] == 5 * 5

    overview = ok(client.get(f"/api/projects/{project.id}/overview", headers=pi))
    assert [r["id"] for r in overview["training"]["recent"]] == [third["id"], rerun["id"], again["id"], run["id"]]
    assert overview["training"]["recent"][0]["task"] == "image_classification"
    assert overview["training"]["recent"][0]["setting_name"] == "資料集訓練"
    assert overview["training"]["recent_completed"] == [run["id"]]
    assert [m["run_id"] for m in overview["models"]] == [run["id"]]


def test_label_dataset_task_must_match(client, pi, project, backend, orthanc, synth):
    upload_dicom(client, pi, project.id, synth, range(1, 3))
    _classify_studies(client, pi, project.id, synth, {1: "nodule", 2: "normal"})
    ds = ok(client.get(f"/api/projects/{project.id}/labels/datasets", headers=pi))[0]
    setting = ok(client.post(f"/api/projects/{project.id}/training/settings", headers=pi,
                             json=_body(ds["id"], kind="image_detection")), 201)
    r = client.post(f"/api/projects/{project.id}/training/settings/{setting['id']}/runs", headers=pi,
                    json={"executor": "fake"})
    assert r.status_code == 422 and "不符" in r.text
    setting = ok(client.post(f"/api/projects/{project.id}/training/settings", headers=pi,
                             json=_body(999, name="不存在")), 201)
    r = client.post(f"/api/projects/{project.id}/training/settings/{setting['id']}/runs", headers=pi,
                    json={"executor": "fake"})
    assert r.status_code == 404
