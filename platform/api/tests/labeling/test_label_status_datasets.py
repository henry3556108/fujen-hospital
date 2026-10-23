"""第二期：標註狀態（draft／confirmed）、標註資料集與版本、資料範圍、專案首頁 API。"""
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.labeling.autolabel import HttpAutolabel
from app.labeling.models import Annotation, LabelDataset
from app.models import AuditLog
from imaging_support import STUDIES, accession, sop_uid, study_uid

REPO = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(REPO / "platform" / "fakes"))
from fakes import faults  # noqa: E402
from fakes.autolabel import app as fake_app  # noqa: E402


@pytest.fixture
def fake_service(app, monkeypatch):
    monkeypatch.delenv("FAKE_AUTOLABEL_FAIL_RATE", raising=False)
    monkeypatch.delenv("FAKE_AUTOLABEL_DELAY_MS", raising=False)
    faults.reset_counter(fake_app)
    app.state.autolabel = HttpAutolabel("http://autolabel", client=TestClient(fake_app, base_url="http://autolabel"))
    return app.state.autolabel


def _classify(client, lab, no, label, headers=None):
    r = client.post(f"{lab.base}/annotations", headers=headers or lab.doctor,
                    json={**lab.target(no, None), "kind": "classification", "payload": {"label": label}})
    assert r.status_code == 201, r.text
    return r.json()


def _draft(session, lab, no, label="nodule") -> int:
    """直接寫一筆待確認的分類標註（模擬自動標註）。"""
    a = Annotation(project_id=lab.pid, study_instance_uid=study_uid(no), kind="classification",
                   payload={"label": label}, source="autolabel", status="draft", created_by="robot", updated_by="robot")
    session.add(a)
    session.commit()
    return a.id


def _csv(rows, header="accession_number,diagnosis"):
    return ("\n".join([header, *[",".join(r) for r in rows]]) + "\n").encode()


# ---------------------------------------------------------------- 標註狀態

def test_manual_annotation_is_confirmed_by_saver(client, lab):
    a = _classify(client, lab, 1, "nodule")
    assert a["status"] == "confirmed" and a["confirmed_by"] == "md01" and a["confirmed_at"]


def test_autolabel_creates_draft_then_put_confirms(client, lab, fake_service):
    r = client.post(f"{lab.base}/autolabel", headers=lab.doctor,
                    json={"model": "fake_detection", "study_instance_uid": study_uid(1),
                          "sop_instance_uid": sop_uid(1, 1)})
    assert r.status_code == 201, r.text
    a = r.json()["annotation"]
    assert a["status"] == "draft" and a["confirmed_by"] is None and a["confirmed_at"] is None
    r = client.put(f"{lab.base}/annotations/{a['id']}", headers=lab.doctor, json={"payload": a["payload"]})
    body = r.json()
    assert body["status"] == "confirmed" and body["confirmed_by"] == "md01" and body["version"] == 2


def test_confirm_endpoint_and_permissions(client, lab, session):
    aid = _draft(session, lab, 1)
    assert client.post(f"{lab.base}/annotations/{aid}/confirm", headers=lab.viewer).status_code == 403
    r = client.post(f"{lab.base}/annotations/{aid}/confirm", headers=lab.doctor)
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "confirmed" and body["confirmed_by"] == "md01" and body["version"] == 1
    actions = session.scalars(select(AuditLog.action).where(AuditLog.target.like(f"%annotation:{aid}"))).all()
    assert "annotation.confirm" in actions
    # 再確認一次：不再寫稽核
    client.post(f"{lab.base}/annotations/{aid}/confirm", headers=lab.doctor)
    session.expire_all()
    assert session.scalars(select(AuditLog.action).where(AuditLog.target.like(f"%annotation:{aid}"))).all() \
        .count("annotation.confirm") == 1


def test_summary_pending_and_confirmed(client, lab, session):
    _classify(client, lab, 1, "nodule")
    _draft(session, lab, 2)
    s = client.get(f"{lab.base}/summary", headers=lab.viewer).json()
    # 4 個研究：1 已確認；2、3、4 沒有已確認標註（3 個）＋1 筆草稿
    assert s["confirmed"] == 1 and s["pending"] == 4
    by = {x["study_instance_uid"]: x for x in s["studies"]}
    assert (by[study_uid(1)]["confirmed"], by[study_uid(1)]["drafts"]) == (1, 0)
    assert (by[study_uid(2)]["confirmed"], by[study_uid(2)]["drafts"]) == (0, 1)


def test_training_provider_skips_drafts(client, lab, session):
    from app.training.labels import AnnotationLabels, InstanceRef

    _classify(client, lab, 1, "nodule")
    _draft(session, lab, 2, "normal")
    refs = [InstanceRef(sop_instance_uid=sop_uid(no, 1), study_instance_uid=study_uid(no),
                        accession_number=accession(no), source_path="") for no in (1, 2)]
    found, names = AnnotationLabels().labels(session, None, lab.pid, refs, {"kind": "classification"})
    assert set(found) == {sop_uid(1, 1)} and names == ["nodule"]


# ---------------------------------------------------------------- 標註資料集

def test_first_annotation_creates_default_dataset(client, lab, session):
    assert client.get(f"{lab.base}/datasets", headers=lab.viewer).json() == []
    _classify(client, lab, 1, "nodule")
    _classify(client, lab, 2, "normal")
    rows = client.get(f"{lab.base}/datasets", headers=lab.viewer).json()
    assert len(rows) == 1
    ds = rows[0]
    assert ds["name"] == "P1 分類標註" and ds["task"] == "classification" and ds["auto"] is True
    assert ds["current"]["annotations"] == 2 and ds["current"]["studies"] == 2
    assert ds["current"]["by_class"] == {"nodule": 1, "normal": 1}
    assert ds["current"]["by_source"] == {"manual": 2, "csv": 0, "autolabel": 0}
    assert ds["latest_version"] is None


def test_existing_annotations_get_default_dataset_on_list(client, lab, session):
    _draft(session, lab, 1)       # 繞過 API 寫入：模擬功能上線前的舊資料
    session.execute(LabelDataset.__table__.delete())
    session.commit()
    rows = client.get(f"{lab.base}/datasets", headers=lab.viewer).json()
    assert [r["task"] for r in rows] == ["classification"]
    assert rows[0]["current"]["drafts_excluded"] == 1 and rows[0]["current"]["annotations"] == 0


def test_dataset_crud_items_versions(client, lab, session):
    _classify(client, lab, 1, "nodule")
    _classify(client, lab, 2, "normal")
    draft = _draft(session, lab, 3, "nodule")
    body = {"name": "結節", "task": "classification", "classes": ["nodule"]}
    assert client.post(f"{lab.base}/datasets", headers=lab.viewer, json=body).status_code == 403
    r = client.post(f"{lab.base}/datasets", headers=lab.doctor, json=body)
    assert r.status_code == 201, r.text
    ds = r.json()
    assert ds["classes"] == ["nodule"] and ds["scope_id"] is None
    assert ds["current"]["annotations"] == 1 and ds["current"]["drafts_excluded"] == 1
    assert client.post(f"{lab.base}/datasets", headers=lab.doctor, json=body).status_code == 409

    items = client.get(f"{lab.base}/datasets/{ds['id']}/items", headers=lab.viewer).json()
    assert items["total"] == 2
    assert {(i["study_instance_uid"], i["status"]) for i in items["items"]} == {
        (study_uid(1), "confirmed"), (study_uid(3), "draft")}
    assert items["items"][0]["accession_number"] == accession(1) and items["items"][0]["label"] == "nodule"

    url = f"{lab.base}/datasets/{ds['id']}/versions"
    r = client.post(url, headers=lab.doctor)
    assert r.status_code == 201 and r.json()["created"] is True and r.json()["version"] == 1
    assert r.json()["annotations"] == 1 and r.json()["by_class"] == {"nodule": 1}
    r = client.post(url, headers=lab.doctor)
    assert r.status_code == 200 and r.json()["created"] is False and r.json()["version"] == 1
    client.post(f"{lab.base}/annotations/{draft}/confirm", headers=lab.doctor)
    r = client.post(url, headers=lab.doctor)
    assert r.json()["created"] is True and r.json()["version"] == 2 and r.json()["annotations"] == 2
    versions = client.get(url, headers=lab.viewer).json()
    assert [v["version"] for v in versions] == [2, 1]
    got = client.get(f"{lab.base}/datasets/{ds['id']}", headers=lab.viewer).json()
    assert got["latest_version"]["version"] == 2

    r = client.put(f"{lab.base}/datasets/{ds['id']}", headers=lab.doctor, json={"name": "全部", "classes": []})
    assert r.status_code == 200 and r.json()["name"] == "全部" and r.json()["current"]["annotations"] == 3
    assert client.put(f"{lab.base}/datasets/{ds['id']}", headers=lab.doctor,
                      json={"task": "detection"}).status_code == 422
    assert client.delete(f"{lab.base}/datasets/{ds['id']}", headers=lab.viewer).status_code == 403
    assert client.delete(f"{lab.base}/datasets/{ds['id']}", headers=lab.doctor).status_code == 204
    assert client.get(f"{lab.base}/datasets/{ds['id']}", headers=lab.viewer).status_code == 404


def test_version_needs_confirmed_annotations(client, lab):
    ds = client.post(f"{lab.base}/datasets", headers=lab.doctor,
                     json={"name": "空的", "task": "segmentation"}).json()
    assert client.post(f"{lab.base}/datasets/{ds['id']}/versions", headers=lab.doctor).status_code == 422


def test_dataset_with_scope(client, lab):
    _classify(client, lab, 1, "a")       # CT
    _classify(client, lab, 2, "b")       # MR
    scope = client.post(f"/api/projects/{lab.pid}/imaging/scopes", headers=lab.doctor,
                        json={"name": "CT", "filters": {"modality": "CT"}}).json()
    ds = client.post(f"{lab.base}/datasets", headers=lab.doctor,
                     json={"name": "CT 分類", "task": "classification", "scope_id": scope["id"]}).json()
    assert ds["scope_id"] == scope["id"] and ds["current"]["by_class"] == {"a": 1}
    assert client.post(f"{lab.base}/datasets", headers=lab.doctor,
                       json={"name": "x", "task": "classification", "scope_id": 999}).status_code == 404
    # 刪除範圍：資料集改成不限範圍
    client.delete(f"/api/projects/{lab.pid}/imaging/scopes/{scope['id']}", headers=lab.doctor)
    ds = client.get(f"{lab.base}/datasets/{ds['id']}", headers=lab.viewer).json()
    assert ds["scope_id"] is None and ds["current"]["annotations"] == 2


def test_csv_new_and_existing_dataset(client, lab):
    rows = [(accession(no), "nodule" if no % 2 else "normal") for no in STUDIES]
    r = client.post(f"{lab.base}/classification-csv", headers=lab.doctor,
                    files={"file": ("dx.csv", _csv(rows), "text/csv")},
                    data={"key": "accession_number", "dataset_name": "門診診斷"})
    assert r.status_code == 201, r.text
    new_id = r.json()["dataset_id"]
    by_name = {d["name"]: d for d in client.get(f"{lab.base}/datasets", headers=lab.viewer).json()}
    assert set(by_name) == {"P1 分類標註", "門診診斷"}
    assert by_name["門診診斷"]["id"] == new_id and by_name["門診診斷"]["classes"] == ["nodule", "normal"]
    assert by_name["門診診斷"]["current"]["by_source"]["csv"] == 4

    limited = client.post(f"{lab.base}/datasets", headers=lab.doctor,
                          json={"name": "只有結節", "task": "classification", "classes": ["nodule"]}).json()
    r = client.post(f"{lab.base}/classification-csv", headers=lab.doctor,
                    files={"file": ("dx2.csv", _csv([(accession(1), "mass")]), "text/csv")},
                    data={"key": "accession_number", "dataset_id": str(limited["id"])})
    assert r.json()["dataset_id"] == limited["id"]
    got = client.get(f"{lab.base}/datasets/{limited['id']}", headers=lab.viewer).json()
    assert got["classes"] == ["mass", "nodule"]
    # 不給資料集：回預設分類資料集
    r = client.post(f"{lab.base}/classification-csv", headers=lab.doctor,
                    files={"file": ("dx3.csv", _csv([(accession(2), "normal")]), "text/csv")},
                    data={"key": "accession_number"})
    assert r.json()["dataset_id"] == by_name["P1 分類標註"]["id"]
    # 偵測資料集不能收診斷表
    det = client.post(f"{lab.base}/datasets", headers=lab.doctor, json={"name": "框", "task": "detection"}).json()
    r = client.post(f"{lab.base}/classification-csv", headers=lab.doctor,
                    files={"file": ("dx4.csv", _csv([(accession(2), "normal")]), "text/csv")},
                    data={"key": "accession_number", "dataset_id": str(det["id"])})
    assert r.status_code == 422


def test_csv_annotations_are_confirmed(client, lab):
    r = client.post(f"{lab.base}/classification-csv", headers=lab.doctor,
                    files={"file": ("dx.csv", _csv([(accession(1), "nodule")]), "text/csv")},
                    data={"key": "accession_number"})
    assert r.status_code == 201
    a = client.get(f"{lab.base}/annotations", headers=lab.doctor, params={"source": "csv"}).json()[0]
    assert a["status"] == "confirmed" and a["confirmed_by"] == "md01"


# ---------------------------------------------------------------- 資料範圍

def test_scopes_crud_and_study_filter(client, lab):
    base = f"/api/projects/{lab.pid}/imaging"
    body = {"name": "2024 Q1 CT", "filters": {"modality": "CT", "study_date_from": "2024-01-01",
                                               "study_date_to": "20240331", "sex": ""}}
    assert client.post(f"{base}/scopes", headers=lab.viewer, json=body).status_code == 403
    r = client.post(f"{base}/scopes", headers=lab.doctor, json=body)
    assert r.status_code == 201, r.text
    scope = r.json()
    # 研究 1（CT 2024-01-15）與 3（CT 2024-03-10）
    assert scope["study_count"] == 2 and scope["created_by"] == "md01"
    assert scope["filters"] == {"modality": "CT", "study_date_from": "2024-01-01", "study_date_to": "20240331"}
    assert client.post(f"{base}/scopes", headers=lab.doctor, json=body).status_code == 409
    assert client.post(f"{base}/scopes", headers=lab.doctor,
                       json={"name": "bad", "filters": {"color": "red"}}).status_code == 422
    assert client.post(f"{base}/scopes", headers=lab.doctor,
                       json={"name": "bad", "filters": {"study_date_from": "2024"}}).status_code == 422

    listed = client.get(f"{base}/studies", headers=lab.viewer, params={"scope_id": scope["id"]}).json()
    assert {s["study_instance_uid"] for s in listed} == {study_uid(1), study_uid(3)}
    paged = client.get(f"{base}/studies", headers=lab.viewer,
                       params={"scope_id": scope["id"], "patient_sex": "M", "limit": 10}).json()
    assert paged["total"] == 1 and paged["items"][0]["study_instance_uid"] == study_uid(3)
    assert client.get(f"{base}/studies", headers=lab.viewer, params={"scope_id": 999}).status_code == 404

    r = client.put(f"{base}/scopes/{scope['id']}", headers=lab.doctor, json={"filters": {"patient_sex": "F"}})
    assert r.status_code == 200 and r.json()["study_count"] == 2 and r.json()["name"] == "2024 Q1 CT"
    assert [s["name"] for s in client.get(f"{base}/scopes", headers=lab.viewer).json()] == ["2024 Q1 CT"]
    assert client.delete(f"{base}/scopes/{scope['id']}", headers=lab.viewer).status_code == 403
    assert client.delete(f"{base}/scopes/{scope['id']}", headers=lab.doctor).status_code == 204
    assert client.get(f"{base}/scopes", headers=lab.viewer).json() == []


# ---------------------------------------------------------------- 專案首頁

def test_overview_sections_follow_permissions(client, lab, session):
    _classify(client, lab, 2, "nodule")
    _draft(session, lab, 3)
    url = f"/api/projects/{lab.pid}/overview"
    viewer = client.get(url, headers=lab.viewer).json()
    assert viewer["project"] == {"id": lab.pid, "name": "P1"}
    assert viewer["me"] == {"role": "custom", "permissions": ["prediction", "project"]}
    assert viewer["data"] == {"studies": 4, "tabular_datasets": 0}
    assert viewer["models"] == [] and viewer["predictions"] == []
    assert "labeling" not in viewer and "training" not in viewer

    doctor = client.get(url, headers=lab.doctor).json()
    assert doctor["labeling"]["confirmed"] == 1 and doctor["labeling"]["pending"] == 4
    assert doctor["labeling"]["total_studies"] == 4
    assert doctor["labeling"]["last"]["study_instance_uid"] == study_uid(2)
    assert doctor["labeling"]["last"]["accession_number"] == accession(2)
    assert "training" not in doctor


def test_overview_needs_membership(client, lab, add_user):
    _, outsider = add_user("someone")
    assert client.get(f"/api/projects/{lab.pid}/overview", headers=outsider).status_code == 403


def test_project_delete_cleans_datasets_and_scopes(client, lab, session):
    from app import project_cleanup
    from app.imaging.models import ImagingScope
    from app.labeling.models import LabelDatasetVersion

    _classify(client, lab, 1, "nodule")
    client.post(f"/api/projects/{lab.pid}/imaging/scopes", headers=lab.doctor, json={"name": "全部", "filters": {}})
    ds = client.get(f"{lab.base}/datasets", headers=lab.viewer).json()[0]
    client.post(f"{lab.base}/datasets/{ds['id']}/versions", headers=lab.doctor)
    project_cleanup.stage(session, lab.pid)
    session.commit()
    for model in (LabelDataset, LabelDatasetVersion, ImagingScope):
        assert session.scalars(select(model).where(model.project_id == lab.pid)).all() == []


def test_db_init_adds_new_columns():
    from app.db_init import ADDED_COLUMNS

    added = {(t, c) for t, c, _ in ADDED_COLUMNS}
    assert {("label_annotations", "status"), ("label_annotations", "confirmed_by"),
            ("label_annotations", "confirmed_at"), ("training_runs", "label_dataset_id"),
            ("training_runs", "label_dataset_version"), ("training_runs", "test_count")} <= added
    assert "DEFAULT 'confirmed'" in dict(((t, c), d) for t, c, d in ADDED_COLUMNS)[("label_annotations", "status")]


def test_scope_with_list_query_keys(client, lab):
    """前端照研究列表的查詢參數送：modality、patient_sex、study_description、study_date、series_description。"""
    base = f"/api/projects/{lab.pid}/imaging"
    body = {"name": "MR 2024 上半年", "filters": {"modality": "MR", "patient_sex": "", "study_description": "mr",
                                               "study_date": "20240201-20240430", "series_description": "ax"}}
    scope = client.post(f"{base}/scopes", headers=lab.doctor, json=body).json()
    assert scope["filters"] == {"modality": "MR", "series_description": "ax", "study_date": "20240201-20240430",
                                "study_description": "mr"}
    assert scope["study_count"] == 2          # 研究 2（MR 0220）、4（MR 0405）
    assert client.post(f"{base}/scopes", headers=lab.doctor,
                       json={"name": "bad", "filters": {"study_date": "2024"}}).status_code == 422
