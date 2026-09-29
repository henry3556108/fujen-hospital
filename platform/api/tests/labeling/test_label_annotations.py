"""標註 CRUD：三種標註、重新載入差異 0、權限、研究可存取性、稽核。"""
from itertools import product

import pytest
from sqlalchemy import func, select

from app.labeling.models import Annotation
from app.models import AuditLog
from conftest import det_payload, seg_payload
from imaging_support import STUDIES, accession, study_uid

TARGETS = list(product(STUDIES, (1, 2, 3)))[:10]   # 10 張影像


def _payload(kind: str, i: int) -> dict:
    return {"classification": {"label": ("nodule", "normal")[i % 2]},
            "segmentation": seg_payload(i), "detection": det_payload(i)}[kind]


@pytest.mark.parametrize("kind", ["classification", "segmentation", "detection"])
def test_tc_b02_04_ten_annotations_saved_and_reloaded_identical(client, lab, kind):
    sent = []
    for i, (no, s) in enumerate(TARGETS):
        body = {**lab.target(no, s), "kind": kind, "payload": _payload(kind, i)}
        r = client.post(f"{lab.base}/annotations", headers=lab.doctor, json=body)
        assert r.status_code == 201, r.text
        sent.append((r.json()["id"], body))
    assert len(sent) == 10
    listed = {a["id"]: a for a in client.get(f"{lab.base}/annotations", headers=lab.doctor, params={"kind": kind}).json()}
    assert len(listed) == 10
    for annotation_id, body in sent:
        got = client.get(f"{lab.base}/annotations/{annotation_id}", headers=lab.doctor).json()
        assert got == listed[annotation_id]
        assert {k: got[k] for k in body} == body
        assert got["source"] == "manual" and got["version"] == 1 and got["rating"] is None
        assert got["created_by"] == got["updated_by"] == "md01"


def test_study_level_classification_needs_no_image(client, lab):
    r = client.post(f"{lab.base}/annotations", headers=lab.doctor,
                    json={**lab.target(1, None), "kind": "classification", "payload": {"label": "normal"}})
    assert r.status_code == 201
    assert r.json()["sop_instance_uid"] is None and r.json()["series_instance_uid"] is None


@pytest.mark.parametrize("kind", ["segmentation", "detection"])
def test_segmentation_and_detection_require_an_image(client, lab, kind):
    r = client.post(f"{lab.base}/annotations", headers=lab.doctor,
                    json={**lab.target(1, None), "kind": kind, "payload": _payload(kind, 0)})
    assert r.status_code == 422 and "影像" in r.json()["detail"]


def test_invalid_payload_is_422_in_chinese_and_writes_nothing(client, lab, session):
    r = client.post(f"{lab.base}/annotations", headers=lab.doctor,
                    json={**lab.target(1), "kind": "detection", "payload": {"shape": [8, 8], "box_format": "xyxy", "boxes": []}})
    assert r.status_code == 422 and r.json()["detail"] == "boxes 至少要有一個框"
    assert session.scalar(select(func.count()).select_from(Annotation)) == 0


def test_update_bumps_version_and_records_editor(client, lab, member):
    created = client.post(f"{lab.base}/annotations", headers=lab.doctor,
                          json={**lab.target(1), "kind": "detection", "payload": det_payload(0)}).json()
    other = member("ra01", lab.project)
    r = client.put(f"{lab.base}/annotations/{created['id']}", headers=other, json={"payload": det_payload(3)})
    assert r.status_code == 200, r.text
    got = client.get(f"{lab.base}/annotations/{created['id']}", headers=lab.doctor).json()
    assert got["payload"] == det_payload(3) and got["version"] == 2
    assert got["created_by"] == "md01" and got["updated_by"] == "ra01" and got["kind"] == "detection"
    assert got["updated_at"] >= got["created_at"]


def test_delete(client, lab):
    created = client.post(f"{lab.base}/annotations", headers=lab.doctor,
                          json={**lab.target(1), "kind": "classification", "payload": {"label": "x"}}).json()
    assert client.delete(f"{lab.base}/annotations/{created['id']}", headers=lab.doctor).status_code == 204
    assert client.get(f"{lab.base}/annotations/{created['id']}", headers=lab.doctor).status_code == 404
    assert client.delete(f"{lab.base}/annotations/{created['id']}", headers=lab.doctor).status_code == 404


def test_filters(client, lab):
    for no, s, kind in [(1, 1, "classification"), (1, 2, "detection"), (2, 1, "detection")]:
        assert client.post(f"{lab.base}/annotations", headers=lab.doctor,
                           json={**lab.target(no, s), "kind": kind, "payload": _payload(kind, 0)}).status_code == 201
    get = lambda **p: client.get(f"{lab.base}/annotations", headers=lab.doctor, params=p).json()  # noqa: E731
    assert len(get()) == 3
    assert len(get(study_uid=study_uid(1))) == 2
    assert len(get(kind="detection")) == 2
    assert len(get(study_uid=study_uid(1), kind="detection")) == 1
    assert len(get(sop_uid=lab.target(2, 1)["sop_instance_uid"])) == 1
    assert len(get(source="autolabel")) == 0
    assert client.get(f"{lab.base}/annotations", headers=lab.doctor, params={"kind": "polygon"}).status_code == 422


def test_target_must_be_in_project_and_consistent(client, lab, project, member):
    post = lambda body: client.post(f"{lab.base}/annotations", headers=lab.doctor,  # noqa: E731
                                    json={"kind": "classification", "payload": {"label": "x"}, **body})
    assert post({"study_instance_uid": "1.2.3.999"}).status_code == 404
    wrong_series = {**lab.target(1), "series_instance_uid": lab.target(2)["series_instance_uid"]}
    assert post(wrong_series).status_code == 404
    wrong_image = {**lab.target(1), "sop_instance_uid": lab.target(2)["sop_instance_uid"]}
    assert post(wrong_image).status_code == 404
    # 別的專案看不到這個專案的標註
    created = post(lab.target(1)).json()
    p2 = project("P2")
    outsider = member("md02", p2)
    assert client.get(f"/api/projects/{p2.id}/labels/annotations/{created['id']}", headers=outsider).status_code == 404
    assert client.get(f"/api/projects/{p2.id}/labels/annotations", headers=outsider).json() == []
    assert client.get(f"{lab.base}/annotations", headers=outsider).status_code == 403


def test_study_outside_accession_allowlist_cannot_be_annotated_or_listed(client, lab, add_user):
    from app.permissions import AccountType
    body = {**lab.target(2), "kind": "classification", "payload": {"label": "x"}}
    created = client.post(f"{lab.base}/annotations", headers=lab.doctor, json=body).json()
    admin = add_user("admin01", AccountType.ADMIN)[1]
    assert client.put(f"/api/projects/{lab.pid}/imaging/accession-allowlist", headers=admin,
                      json={"accession_numbers": [accession(1)]}).status_code == 200
    assert client.post(f"{lab.base}/annotations", headers=lab.doctor, json=body).status_code == 404
    assert client.get(f"{lab.base}/annotations/{created['id']}", headers=lab.doctor).status_code == 404
    assert client.get(f"{lab.base}/annotations", headers=lab.doctor).json() == []
    assert client.put(f"{lab.base}/annotations/{created['id']}", headers=lab.doctor,
                      json={"payload": {"label": "y"}}).status_code == 404


def test_tc_b02_07_viewer_cannot_save_five_attempts(client, lab, session):
    created = client.post(f"{lab.base}/annotations", headers=lab.doctor,
                          json={**lab.target(1), "kind": "classification", "payload": {"label": "x"}}).json()
    attempts = [
        client.post(f"{lab.base}/annotations", headers=lab.viewer,
                    json={**lab.target(1), "kind": "classification", "payload": {"label": "x"}}),
        client.post(f"{lab.base}/annotations", headers=lab.viewer,
                    json={**lab.target(1), "kind": "segmentation", "payload": seg_payload()}),
        client.post(f"{lab.base}/annotations", headers=lab.viewer,
                    json={**lab.target(1), "kind": "detection", "payload": det_payload()}),
        client.put(f"{lab.base}/annotations/{created['id']}", headers=lab.viewer, json={"payload": {"label": "y"}}),
        client.delete(f"{lab.base}/annotations/{created['id']}", headers=lab.viewer),
    ]
    assert [r.status_code for r in attempts] == [403] * 5
    assert all(r.json()["detail"]["permission"] == "labeling" for r in attempts)
    assert session.scalar(select(func.count()).select_from(Annotation)) == 1
    # 看得到但不能改
    got = client.get(f"{lab.base}/annotations/{created['id']}", headers=lab.viewer)
    assert got.status_code == 200 and got.json()["payload"] == {"label": "x"} and got.json()["version"] == 1


def test_unauthenticated_is_401(client, lab):
    assert client.get(f"{lab.base}/annotations").status_code == 401
    assert client.post(f"{lab.base}/annotations", json={}).status_code == 401


def test_every_write_has_dataset_audit_in_same_transaction(client, lab, session):
    before = session.scalar(select(func.max(AuditLog.id))) or 0
    created = client.post(f"{lab.base}/annotations", headers=lab.doctor,
                          json={**lab.target(1), "kind": "classification", "payload": {"label": "x"}}).json()
    client.put(f"{lab.base}/annotations/{created['id']}", headers=lab.doctor, json={"payload": {"label": "y"}})
    client.delete(f"{lab.base}/annotations/{created['id']}", headers=lab.doctor)
    rows = session.scalars(select(AuditLog).where(AuditLog.id > before).order_by(AuditLog.id)).all()
    assert [(a.category, a.action, a.actor, a.result) for a in rows] == [
        ("dataset", "annotation.create", "md01", "success"),
        ("dataset", "annotation.update", "md01", "success"),
        ("dataset", "annotation.delete", "md01", "success")]
    assert all(a.target == f"project:{lab.pid}/annotation:{created['id']}" for a in rows)
    assert rows[0].detail["kind"] == "classification" and rows[0].detail["study_instance_uid"] == study_uid(1)
