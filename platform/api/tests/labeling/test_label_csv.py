"""以 CSV 診斷結果自動做分類標註（TC-B02-05）。"""
import pytest
from sqlalchemy import func, select

from app.labeling.csv_labels import CsvError, parse
from app.labeling.models import Annotation
from app.models import AuditLog
from app.permissions import AccountType
from imaging_support import STUDIES, accession, make_dicom, study_uid, upload


def _csv(rows, header="patient_id,diagnosis"):
    return ("\n".join([header, *[",".join(r) for r in rows]]) + "\n").encode()


def _post(client, lab, data: bytes, headers=None, **form):
    return client.post(f"{lab.base}/classification-csv", headers=headers or lab.doctor,
                       files={"file": ("diagnosis.csv", data, "text/csv")}, data=form)


def _more_studies(client, lab, monkeypatch):
    """補到 10 個研究：沿用 imaging_support 的產生器，多 6 個研究編號。"""
    extra = {no: dict(STUDIES[1 + (no % 4)]) for no in range(5, 11)}
    for no, meta in extra.items():
        monkeypatch.setitem(STUDIES, no, meta)
    files = [(f"study_{no:04d}/series_001/IM0001.dcm", make_dicom(no, 1)) for no in extra]
    assert upload(client, lab.doctor, lab.pid, files).json()["counts"]["imported"] == 6


def test_tc_b02_05_ten_rows_by_patient_id_align_without_error(client, lab, monkeypatch):
    _more_studies(client, lab, monkeypatch)
    expected = {no: ("nodule", "normal", "pneumonia")[no % 3] for no in range(1, 11)}
    r = _post(client, lab, _csv([(f"PAT{no:04d}", label) for no, label in expected.items()]), key="patient_id")
    assert r.status_code == 201, r.text
    body = r.json()
    assert (body["rows"], body["matched"], body["unmatched"], body["conflict"], body["invalid"]) == (10, 10, 0, 0, 0)
    assert body["annotated_studies"] == 10
    saved = {a["study_instance_uid"]: a for a in
             client.get(f"{lab.base}/annotations", headers=lab.doctor, params={"source": "csv"}).json()}
    assert len(saved) == 10
    for no, label in expected.items():
        a = saved[study_uid(no)]
        assert a["payload"] == {"label": label} and a["kind"] == "classification"
        assert a["sop_instance_uid"] is None and a["created_by"] == "md01"
    for row, (no, label) in zip(body["results"], expected.items()):
        assert row["status"] == "matched" and row["label"] == label
        assert row["study_instance_uids"] == [study_uid(no)]
        assert row["annotation_ids"] == [saved[study_uid(no)]["id"]]


def test_tc_b02_05_by_accession_number(client, lab):
    rows = [(accession(no), f"dx{no}") for no in STUDIES]
    body = _post(client, lab, _csv(rows, "accession_number,diagnosis"), key="accession_number").json()
    assert body["matched"] == len(STUDIES)
    saved = {a["study_instance_uid"]: a["payload"]["label"]
             for a in client.get(f"{lab.base}/annotations", headers=lab.doctor).json()}
    assert saved == {study_uid(no): f"dx{no}" for no in STUDIES}


def test_chinese_headers_bom_and_big5(client, lab):
    text = "病歷號,診斷結果\nPAT0001,肺結節\nPAT0002,正常\n"
    for data in (b"\xef\xbb\xbf" + text.encode("utf-8"), text.encode("cp950")):
        body = _post(client, lab, data, key="patient_id").json()
        assert body["matched"] == 2, body
    labels = sorted(a["payload"]["label"] for a in client.get(f"{lab.base}/annotations", headers=lab.doctor).json())
    assert labels == ["正常", "肺結節"]


def test_explicit_column_names(client, lab):
    data = _csv([("x", "PAT0001", "nodule")], "seq,chart_no,result")
    assert _post(client, lab, data, key="patient_id").status_code == 422
    body = _post(client, lab, data, key="patient_id", key_column="chart_no", label_column="result").json()
    assert body["matched"] == 1


def test_one_patient_with_two_studies_labels_both(client, lab, monkeypatch):
    monkeypatch.setitem(STUDIES, 9, dict(STUDIES[1]))
    data = make_dicom(9, 1)
    import io
    import pydicom
    ds = pydicom.dcmread(io.BytesIO(data))
    ds.PatientID = "PAT0001"
    buf = io.BytesIO()
    ds.save_as(buf, enforce_file_format=True)
    assert upload(client, lab.doctor, lab.pid, [("study_0009/IM1.dcm", buf.getvalue())]).json()["counts"]["imported"] == 1
    body = _post(client, lab, _csv([("PAT0001", "nodule")]), key="patient_id").json()
    assert body["matched"] == 1 and body["annotated_studies"] == 2
    assert sorted(body["results"][0]["study_instance_uids"]) == sorted([study_uid(1), study_uid(9)])


def test_unmatched_conflict_and_invalid_rows_are_reported_not_written(client, lab, session):
    rows = [("PAT0001", "nodule"), ("PAT9999", "nodule"),          # 第 2 列對不到
            ("PAT0002", "nodule"), ("PAT0002", "normal"),          # 同一鍵不同診斷 → 衝突
            ("", "nodule"), ("PAT0003", ""),                       # 缺鍵、缺診斷
            ("PAT0004", "normal"), ("PAT0004", "normal")]          # 重複且一致 → 都算對到
    body = _post(client, lab, _csv(rows), key="patient_id").json()
    assert [r["status"] for r in body["results"]] == [
        "matched", "unmatched", "conflict", "conflict", "invalid", "invalid", "matched", "matched"]
    assert [r["row"] for r in body["results"]] == [2, 3, 4, 5, 6, 7, 8, 9]   # 含標題列的行號
    assert (body["matched"], body["unmatched"], body["conflict"], body["invalid"]) == (3, 1, 2, 2)
    assert all(r["reason"] for r in body["results"] if r["status"] != "matched")
    saved = {a.study_instance_uid: a.payload["label"] for a in session.scalars(select(Annotation))}
    assert saved == {study_uid(1): "nodule", study_uid(4): "normal"}


def test_reupload_updates_instead_of_duplicating(client, lab):
    first = _post(client, lab, _csv([("PAT0001", "nodule"), ("PAT0002", "normal")]), key="patient_id").json()
    second = _post(client, lab, _csv([("PAT0001", "pneumonia"), ("PAT0002", "normal")]), key="patient_id").json()
    assert [r["annotation_ids"] for r in first["results"]] == [r["annotation_ids"] for r in second["results"]]
    assert (second["created"], second["updated"], second["unchanged"]) == (0, 1, 1)
    rows = {a["study_instance_uid"]: a for a in client.get(f"{lab.base}/annotations", headers=lab.doctor).json()}
    assert len(rows) == 2
    assert rows[study_uid(1)]["payload"] == {"label": "pneumonia"} and rows[study_uid(1)]["version"] == 2
    assert rows[study_uid(2)]["version"] == 1


def test_manual_annotations_are_left_alone(client, lab):
    manual = client.post(f"{lab.base}/annotations", headers=lab.doctor,
                         json={**lab.target(1, None), "kind": "classification", "payload": {"label": "manual"}}).json()
    _post(client, lab, _csv([("PAT0001", "nodule")]), key="patient_id")
    rows = client.get(f"{lab.base}/annotations", headers=lab.doctor, params={"study_uid": study_uid(1)}).json()
    assert sorted((a["source"], a["payload"]["label"]) for a in rows) == [("csv", "nodule"), ("manual", "manual")]
    assert client.get(f"{lab.base}/annotations/{manual['id']}", headers=lab.doctor).json()["version"] == 1


def test_studies_outside_allowlist_do_not_match(client, lab, add_user):
    admin = add_user("admin01", AccountType.ADMIN)[1]
    client.put(f"/api/projects/{lab.pid}/imaging/accession-allowlist", headers=admin,
               json={"accession_numbers": [accession(1)]})
    body = _post(client, lab, _csv([("PAT0001", "a"), ("PAT0002", "b")]), key="patient_id").json()
    assert [r["status"] for r in body["results"]] == ["matched", "unmatched"]


@pytest.mark.parametrize("data,form", [
    (b"", {"key": "patient_id"}),
    (b"patient_id,diagnosis\n", {"key": "patient_id"}),                       # 只有標題
    (b"foo,bar\n1,2\n", {"key": "patient_id"}),                               # 找不到鍵欄
    (b"patient_id,foo\n1,2\n", {"key": "patient_id"}),                        # 找不到診斷欄
    (b"patient_id,diagnosis\nPAT0001,x\n", {"key": "mrn"}),                   # key 不在允許值
    (b"patient_id,patient_id,diagnosis\nPAT0001,PAT0001,x\n", {"key": "patient_id"}),   # 欄名重複
    (b"\xff\xfe\x00\x01" * 8, {"key": "patient_id"}),                         # 不是文字
])
def test_bad_files_are_422_and_write_nothing(client, lab, session, data, form):
    r = _post(client, lab, data, **form)
    assert r.status_code == 422, r.text
    assert session.scalar(select(func.count()).select_from(Annotation)) == 0


def test_permission_and_audit(client, lab, session):
    data = _csv([("PAT0001", "nodule"), ("PAT9999", "x")])
    assert _post(client, lab, data, headers=lab.viewer, key="patient_id").status_code == 403
    before = session.scalar(select(func.max(AuditLog.id))) or 0
    body = _post(client, lab, data, key="patient_id").json()
    rows = session.scalars(select(AuditLog).where(AuditLog.id > before)).all()
    assert len(rows) == 1
    a = rows[0]
    assert (a.category, a.action, a.actor, a.target) == ("dataset", "annotation.csv_classification", "md01",
                                                         f"project:{lab.pid}")
    assert a.detail["matched"] == 1 and a.detail["unmatched"] == 1 and a.detail["filename"] == "diagnosis.csv"
    assert a.detail["annotation_ids"] == body["results"][0]["annotation_ids"]


def test_parse_is_pure_and_reports_line_numbers():
    rows = parse(b"patient_id,diagnosis\n A1 , x \n\nA2,y\n", key="patient_id")
    assert [(r.row, r.key, r.label) for r in rows] == [(2, "A1", "x"), (4, "A2", "y")]
    with pytest.raises(CsvError):
        parse(b"a,b\n1,2\n", key="patient_id")
