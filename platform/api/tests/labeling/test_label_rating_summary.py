"""評分與摘要。"""
import pytest
from sqlalchemy import select

from app.models import AuditLog
from conftest import det_payload, seg_payload
from imaging_support import STUDIES, study_uid


def _create(client, lab, no, s, kind="classification", payload=None):
    r = client.post(f"{lab.base}/annotations", headers=lab.doctor,
                    json={**lab.target(no, s), "kind": kind, "payload": payload or {"label": "nodule"}})
    assert r.status_code == 201, r.text
    return r.json()


def test_tc_b02_03_rate_ten_annotations_then_reload_identical(client, lab):
    targets = [(no, s) for no in STUDIES for s in (1, 2, 3)][:10]
    expected = {}
    for i, (no, s) in enumerate(targets):
        a = _create(client, lab, no, s)
        rating = 1 + i % 5
        r = client.put(f"{lab.base}/annotations/{a['id']}/rating", headers=lab.doctor, json={"rating": rating})
        assert r.status_code == 200 and r.json()["rating"] == rating
        expected[a["id"]] = rating
    assert len(expected) == 10
    reloaded = {a["id"]: a["rating"] for a in client.get(f"{lab.base}/annotations", headers=lab.doctor).json()}
    assert reloaded == expected
    for annotation_id, rating in expected.items():
        assert client.get(f"{lab.base}/annotations/{annotation_id}", headers=lab.doctor).json()["rating"] == rating


def test_rating_does_not_change_content_version(client, lab):
    a = _create(client, lab, 1, 1, "detection", det_payload())
    got = client.put(f"{lab.base}/annotations/{a['id']}/rating", headers=lab.doctor, json={"rating": 4}).json()
    assert got["version"] == 1 and got["payload"] == det_payload() and got["updated_by"] == "md01"
    cleared = client.put(f"{lab.base}/annotations/{a['id']}/rating", headers=lab.doctor, json={"rating": None})
    assert cleared.status_code == 200 and cleared.json()["rating"] is None


@pytest.mark.parametrize("rating", [0, 6, -1, 2.5, "5", True])
def test_rating_out_of_range_is_422(client, lab, rating):
    a = _create(client, lab, 1, 1)
    assert client.put(f"{lab.base}/annotations/{a['id']}/rating", headers=lab.doctor,
                      json={"rating": rating}).status_code == 422
    assert client.get(f"{lab.base}/annotations/{a['id']}", headers=lab.doctor).json()["rating"] is None


def test_rating_needs_labeling_permission_and_is_audited(client, lab, session):
    a = _create(client, lab, 1, 1)
    assert client.put(f"{lab.base}/annotations/{a['id']}/rating", headers=lab.viewer, json={"rating": 3}).status_code == 403
    assert client.put(f"{lab.base}/annotations/{a['id']}/rating", headers=lab.doctor, json={"rating": 3}).status_code == 200
    row = session.scalars(select(AuditLog).order_by(AuditLog.id.desc())).first()
    assert (row.category, row.action, row.detail["rating"]) == ("dataset", "annotation.rate", 3)
    assert client.put(f"{lab.base}/annotations/9999/rating", headers=lab.doctor, json={"rating": 3}).status_code == 404


def test_summary_counts_per_study_kind_and_label(client, lab):
    _create(client, lab, 1, 1)                                         # nodule
    _create(client, lab, 1, 2, payload={"label": "normal"})
    _create(client, lab, 1, 1, "detection", det_payload())             # nodule + lung
    _create(client, lab, 2, 1, "segmentation", seg_payload())          # lung + nodule
    rated = _create(client, lab, 2, None, payload={"label": "nodule"})
    client.put(f"{lab.base}/annotations/{rated['id']}/rating", headers=lab.doctor, json={"rating": 5})
    summary = client.get(f"{lab.base}/summary", headers=lab.viewer).json()
    assert summary["total"] == 5
    assert summary["by_kind"] == {"classification": 3, "segmentation": 1, "detection": 1}
    assert summary["by_source"] == {"manual": 5, "csv": 0, "autolabel": 0}
    assert summary["labels"] == {"classification": {"nodule": 2, "normal": 1},
                                 "segmentation": {"lung": 1, "nodule": 1},
                                 "detection": {"lung": 1, "nodule": 1}}
    assert summary["rated"] == 1
    studies = {s["study_instance_uid"]: s for s in summary["studies"]}
    assert set(studies) == {study_uid(no) for no in STUDIES}        # 沒標註的研究也列出，數量為 0
    assert studies[study_uid(1)]["annotations"] == 3 and studies[study_uid(2)]["annotations"] == 2
    assert studies[study_uid(3)]["annotations"] == 0
    assert studies[study_uid(1)]["by_kind"] == {"classification": 2, "segmentation": 0, "detection": 1}
    assert studies[study_uid(1)]["classification_labels"] == ["nodule", "normal"]
    assert studies[study_uid(2)]["classification_labels"] == ["nodule"]          # 研究層級也算
    assert studies[study_uid(3)]["classification_labels"] == []
