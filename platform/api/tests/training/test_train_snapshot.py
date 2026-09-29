"""資料凍結：內容定址、版本雜湊、影像範圍與 Label 選擇、Accession 清單。"""
import hashlib
import json

from app.training.snapshot import blob_key
from conftest_training import ok, setting_body, start, study_uids, upload_csv, upload_dicom


def version_of(client, headers, run):
    return ok(client.get(f"/api/projects/{run['project_id']}/training/dataset-versions/"
                         f"{run['dataset_version_id']}", headers=headers))


def test_freeze_all_images_with_labels(client, pi, project, backend, images, store):
    run = start(client, pi, project.id, setting_body("image_classification", synth=images))
    version = version_of(client, pi, run)
    assert version["item_count"] == 100 and version["label_names"] == ["CT", "MR"]
    assert {i["label"] for i in version["items"]} == {"CT", "MR"}
    assert len({i["group"] for i in version["items"]}) == 20
    for item in version["items"][:10]:       # blob 的檔名就是內容的 sha256
        ref = item["files"]["image"]
        assert hashlib.sha256(store.get(blob_key(project.id, ref["sha256"]))).hexdigest() == ref["sha256"]
    assert run["dataset_version"]["content_hash"] == version["content_hash"]


def test_partial_image_range_and_label_selection(client, pi, project, backend, images):
    """「全部或部分影像」「Label 選擇」。"""
    uids = [s["study_instance_uid"] for s in study_uids(images, range(1, 6)).values()]
    body = setting_body("image_classification", synth=images)
    body["config"]["source"]["studies"] = uids
    version = version_of(client, pi, start(client, pi, project.id, body))
    assert version["item_count"] == 25 and {i["group"] for i in version["items"]} == set(uids)

    boxes = setting_body("image_detection", name="只要 nodule")
    boxes["config"]["image"]["labels"] = ["nodule"]
    version = version_of(client, pi, start(client, pi, project.id, boxes))
    assert version["label_names"] == ["nodule"] and 0 < version["item_count"] <= 15
    assert version["summary"]["skipped"]["unlabelled"] == 85, "沒有標註的 17 個研究不進資料集"


def test_same_content_is_the_same_version_and_new_data_makes_a_new_one(client, pi, project, backend, orthanc,
                                                                      synth):
    upload_dicom(client, pi, project.id, synth, range(1, 11))
    body = setting_body("image_classification", synth=synth)
    first = start(client, pi, project.id, body)
    again = ok(client.post(f"/api/projects/{project.id}/training/settings/{first['setting_id']}/runs",
                           headers=pi, json={"executor": "fake"}), 201)
    assert again["dataset_version_id"] == first["dataset_version_id"]

    upload_dicom(client, pi, project.id, synth, range(11, 21))
    later = ok(client.post(f"/api/projects/{project.id}/training/settings/{first['setting_id']}/runs",
                           headers=pi, json={"executor": "fake"}), 201)
    assert later["dataset_version_id"] != first["dataset_version_id"]
    assert version_of(client, pi, first)["item_count"] == 50, "已凍結的版本不會多出新資料"
    assert version_of(client, pi, later)["item_count"] == 100


def test_accession_allowlist_limits_what_can_be_frozen(client, pi, admin, project, backend, images):
    studies = study_uids(images)
    allowed = [studies[n]["accession_number"] for n in (1, 2, 3, 4)]
    ok(client.put(f"/api/projects/{project.id}/imaging/accession-allowlist", headers=admin,
                  json={"accession_numbers": allowed}))
    run = start(client, pi, project.id, setting_body("image_classification", synth=images))
    version = version_of(client, pi, run)
    assert version["item_count"] == 20
    assert {i["group"] for i in version["items"]} == {studies[n]["study_instance_uid"] for n in (1, 2, 3, 4)}

    outside = setting_body("image_classification", synth=images, name="清單外")
    outside["config"]["source"]["studies"] = [studies[9]["study_instance_uid"]]
    setting = ok(client.post(f"/api/projects/{project.id}/training/settings", headers=pi, json=outside), 201)
    response = client.post(f"/api/projects/{project.id}/training/settings/{setting['id']}/runs", headers=pi,
                           json={"executor": "fake"})
    assert response.status_code == 422 and "Accession 清單" in response.json()["detail"]


def test_freeze_segmentation_cases_and_tabular_dataset(client, pi, project, backend, volumes, table, store):
    seg = version_of(client, pi, start(client, pi, project.id, setting_body("image_segmentation")))
    assert seg["item_count"] == 3 and seg["label_names"] == ["class_1", "class_2"]
    assert all(set(i["files"]) == {"image", "mask"} for i in seg["items"])
    assert [i["id"] for i in seg["items"]] == ["case_001", "case_002", "case_003"]

    run = start(client, pi, project.id, setting_body("tabular_classification", dataset_id=table))
    tab = version_of(client, pi, run)
    assert tab["item_count"] == 1 and tab["summary"]["rows"] == 100
    csv = store.get(blob_key(project.id, tab["items"][0]["files"]["csv"]["sha256"]))
    assert csv.count(b"\n") == 101
    schema = json.loads(store.get(blob_key(project.id, tab["items"][0]["files"]["schema"]["sha256"])))
    assert "diagnosis" in [c["name"] for c in schema["columns"]]


def test_nothing_to_train_on_is_a_clear_error(client, pi, project, backend, orthanc, synth):
    upload_dicom(client, pi, project.id, synth, range(1, 3))       # 有影像但沒有任何標註
    setting = ok(client.post(f"/api/projects/{project.id}/training/settings", headers=pi,
                             json=setting_body("image_detection")), 201)
    response = client.post(f"/api/projects/{project.id}/training/settings/{setting['id']}/runs", headers=pi,
                           json={"executor": "fake"})
    assert response.status_code == 409 and "沒有可用於訓練的資料" in response.json()["detail"]
    assert ok(client.get(f"/api/projects/{project.id}/training/runs", headers=pi)) == []

    missing = setting_body("tabular_regression", dataset_id=999)
    setting = ok(client.post(f"/api/projects/{project.id}/training/settings", headers=pi, json=missing), 201)
    response = client.post(f"/api/projects/{project.id}/training/settings/{setting['id']}/runs", headers=pi,
                           json={"executor": "fake"})
    assert response.status_code == 422 and "找不到結構式資料集" in response.json()["detail"]
