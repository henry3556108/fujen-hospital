"""以影像標註平台的標註訓練（TC-B02-06 標註後直接訓練，網頁的「建立訓練任務」走這條路）。"""
import io
import json

import numpy as np
import pydicom

from app.labeling.payloads import rle_from_mask
from app.training.snapshot import blob_key
from conftest_training import finish, ok, start, study_uids, upload_dicom


def slices(synth, study_no):
    out = []
    for path in sorted((synth / "dicom" / f"study_{study_no:04d}").rglob("*.dcm")):
        ds = pydicom.dcmread(path, stop_before_pixels=True)
        out.append((str(ds.StudyInstanceUID), str(ds.SeriesInstanceUID), str(ds.SOPInstanceUID)))
    return out


def annotate(client, headers, pid, study, series, sop, kind, payload):
    ok(client.post(f"/api/projects/{pid}/labels/annotations", headers=headers,
                   json={"study_instance_uid": study, "series_instance_uid": series, "sop_instance_uid": sop,
                         "kind": kind, "payload": payload}), 201)


def body(kind, labels, resize=32):
    return {"name": f"標註頁 {kind}", "config": {
        "kind": f"image_{kind}", "source": {"type": "dicom", "studies": "all",
                                            "label_source": {"provider": "annotations"}},
        "image": {"resize": [resize, resize], "labels": labels}, "split": {"train": 0.6, "validation": 0.2,
                                                                          "test": 0.2}, "seed": 42}}


def version(client, headers, run):
    return ok(client.get(f"/api/projects/{run['project_id']}/training/dataset-versions/"
                         f"{run['dataset_version_id']}", headers=headers))


def test_classification_uses_image_label_first_then_study_label(client, pi, project, backend, orthanc, synth,
                                                                tmp_path):
    upload_dicom(client, pi, project.id, synth, range(1, 6))
    for no in range(1, 6):                           # 研究層級：整個研究 5 張都是這個 Label
        study, _, _ = slices(synth, no)[0]
        ok(client.post(f"/api/projects/{project.id}/labels/annotations", headers=pi,
                       json={"study_instance_uid": study, "kind": "classification",
                             "payload": {"label": "nodule" if no % 2 else "normal"}}), 201)
    study, series, sop = slices(synth, 1)[0]         # 影像層級覆蓋研究層級
    annotate(client, pi, project.id, study, series, sop, "classification", {"label": "normal"})

    run = start(client, pi, project.id, body("classification", ["nodule", "normal"]))
    items = {i["id"]: i for i in version(client, pi, run)["items"]}
    assert len(items) == 25 and items[sop]["label"] == "normal"
    assert sum(i["label"] == "nodule" for i in items.values()) == 3 * 5 - 1
    assert finish(client, backend, pi, run, tmp_path)["status"] == "succeeded"


def test_detection_boxes_become_xywh(client, pi, project, backend, orthanc, synth, store):
    upload_dicom(client, pi, project.id, synth, range(1, 4))
    for no in range(1, 4):
        study, series, sop = slices(synth, no)[2]
        annotate(client, pi, project.id, study, series, sop, "detection",
                 {"shape": [64, 64], "box_format": "xyxy", "boxes": [{"label": "nodule", "box": [4, 8, 20, 30]}]})
    run = start(client, pi, project.id, body("detection", ["nodule"]))
    frozen = version(client, pi, run)
    assert len(frozen["items"]) == 3 and frozen["items"][0]["boxes"] == 1
    assert frozen["summary"]["skipped"]["unlabelled"] == 12
    manifest = json.loads(store.get(f"projects/{project.id}/training/datasets/{frozen['content_hash']}/manifest.json"))
    assert manifest["items"][0]["boxes"] == [{"label": "nodule", "bbox": [4.0, 8.0, 16.0, 22.0]}]


def test_segmentation_mask_is_renumbered_by_selected_labels(client, pi, project, backend, orthanc, synth, store):
    upload_dicom(client, pi, project.id, synth, range(1, 4))
    mask = np.zeros((64, 64), dtype=int)
    mask[10:20, 10:20] = 3            # 在標註裡 lesion＝3、organ＝5
    mask[30:40, 30:40] = 5
    for no in range(1, 4):
        study, series, sop = slices(synth, no)[0]
        annotate(client, pi, project.id, study, series, sop, "segmentation",
                 {"shape": [64, 64], "encoding": "rle", "rle": rle_from_mask(mask.ravel().tolist()),
                  "label_names": {"background": 0, "lesion": 3, "organ": 5}})
    run = start(client, pi, project.id, body("segmentation", ["organ", "lesion"]))
    items = version(client, pi, run)["items"]
    assert len(items) == 3 and items[0]["files"]["mask"]["format"] == "npy"
    saved = np.load(io.BytesIO(store.get(blob_key(project.id, items[0]["files"]["mask"]["sha256"]))))
    assert saved[15, 15] == 2 and saved[35, 35] == 1 and saved[0, 0] == 0, "依設定的 Label 順序：organ＝1、lesion＝2"
    assert json.dumps(sorted(np.unique(saved).tolist())) == "[0, 1, 2]"


def test_annotations_outside_the_allowlist_are_not_frozen(client, pi, admin, project, backend, orthanc, synth):
    upload_dicom(client, pi, project.id, synth, range(1, 5))
    for no in range(1, 5):
        study, _, _ = slices(synth, no)[0]
        ok(client.post(f"/api/projects/{project.id}/labels/annotations", headers=pi,
                       json={"study_instance_uid": study, "kind": "classification",
                             "payload": {"label": "a" if no % 2 else "b"}}), 201)
    accessions = [study_uids(synth)[n]["accession_number"] for n in (1, 2)]
    ok(client.put(f"/api/projects/{project.id}/imaging/accession-allowlist", headers=admin,
                  json={"accession_numbers": accessions}))
    items = version(client, pi, start(client, pi, project.id, body("classification", ["a", "b"])))["items"]
    assert {i["group"] for i in items} == {slices(synth, n)[0][0] for n in (1, 2)}
