"""DICOM 上傳：索引、去重、壞檔隔離、稽核、權限。"""
from sqlalchemy import select

from app.models import AuditLog
from imaging_support import (STUDIES, SLICES, make_dicom, member, orthanc, project, sop_uid, study_files,  # noqa: F401
                             study_uid, upload)


def _all_files():
    return [f for no in STUDIES for f in study_files(no)]


def test_tc_b01_02_counts_match_and_dataset_audit(client, session, orthanc, project, member):
    p1 = project()
    h = member("ra01", p1)
    r = upload(client, h, p1.id, _all_files())
    assert r.status_code == 201, r.text
    job = r.json()
    assert job["status"] == "succeeded"
    assert job["counts"] == {"imported": len(STUDIES) * SLICES, "duplicate": 0, "failed": 0}
    studies = client.get(f"/api/projects/{p1.id}/imaging/studies", headers=h).json()
    assert len(studies) == len(STUDIES)
    assert sum(len(s["series"]) for s in studies) == len(STUDIES)
    assert sum(s["instances"] for s in studies) == len(STUDIES) * SLICES
    assert len(orthanc.instances) == len(STUDIES) * SLICES
    audit = session.scalars(select(AuditLog).where(AuditLog.category == "dataset")).all()
    assert len(audit) == 1 and audit[0].actor == "ra01" and audit[0].detail["job_id"] == job["id"]
    assert audit[0].target == f"project:{p1.id}"


def test_tc_b01_06_second_import_is_all_duplicates(client, orthanc, project, member):
    p1 = project()
    h = member("ra01", p1)
    upload(client, h, p1.id, study_files(1))
    job = upload(client, h, p1.id, study_files(1)).json()
    assert job["counts"] == {"imported": 0, "duplicate": SLICES, "failed": 0}
    assert all(f["status"] == "duplicate" for f in job["files"])
    studies = client.get(f"/api/projects/{p1.id}/imaging/studies", headers=h).json()
    assert studies[0]["instances"] == SLICES


def test_tc_b01_06_duplicate_within_same_batch(client, orthanc, project, member):
    p1 = project()
    h = member("ra01", p1)
    data = make_dicom(1, 1)
    job = upload(client, h, p1.id, [("a/IM1.dcm", data), ("b/IM1-copy.dcm", data)]).json()
    assert job["counts"] == {"imported": 1, "duplicate": 1, "failed": 0}


def test_tc_b01_05_bad_files_isolated_with_reasons(client, orthanc, project, member):
    p1 = project()
    h = member("ra01", p1)
    good = study_files(1)
    truncated = make_dicom(2, 1)[:300]
    files = [good[0], ("bad/truncated.dcm", truncated), ("bad/readme.txt", b"hello"),
             ("bad/fake.dcm", b"not a dicom"), good[1]]
    r = upload(client, h, p1.id, files)
    assert r.status_code == 201
    job = r.json()
    assert job["status"] == "partial"
    by_name = {f["filename"]: f for f in job["files"]}
    assert by_name[good[0][0]]["status"] == by_name[good[1][0]]["status"] == "imported"
    for name in ("bad/truncated.dcm", "bad/readme.txt", "bad/fake.dcm"):
        assert by_name[name]["status"] == "failed" and by_name[name]["reason"]
    assert "副檔名" in by_name["bad/readme.txt"]["reason"]
    assert "截斷" in by_name["bad/truncated.dcm"]["reason"] or "不完整" in by_name["bad/truncated.dcm"]["reason"]
    # 工作查詢可重看逐檔錯誤
    again = client.get(f"/api/projects/{p1.id}/imaging/jobs/{job['id']}", headers=h).json()
    assert again["counts"]["failed"] == 3 and len(again["files"]) == 5


def test_source_path_kept(client, session, orthanc, project, member):
    from app.imaging.models import ImagingInstance
    p1 = project()
    h = member("ra01", p1)
    upload(client, h, p1.id, study_files(1)[:1])
    inst = session.scalar(select(ImagingInstance))
    assert inst.source_path == "study_0001/series_001/IM0001.dcm"
    assert inst.sop_instance_uid == sop_uid(1, 1)


def test_orthanc_rejection_is_per_file(client, orthanc, project, member, monkeypatch):
    from app.imaging.orthanc import OrthancError
    p1 = project()
    h = member("ra01", p1)
    real = orthanc.store

    def flaky(data):
        if data == make_dicom(1, 2):
            raise OrthancError("影像節點拒收")
        return real(data)
    monkeypatch.setattr(orthanc, "store", flaky)
    job = upload(client, h, p1.id, study_files(1)).json()
    assert job["counts"] == {"imported": 2, "duplicate": 0, "failed": 1}


def test_import_requires_labeling(client, orthanc, project, member):
    p1 = project()
    h = member("vw01", p1, permissions=("project", "prediction"))
    r = upload(client, h, p1.id, study_files(1))
    assert r.status_code == 403 and r.json()["detail"]["permission"] == "labeling"
    assert orthanc.instances == {}


def test_outsider_cannot_list(client, orthanc, project, add_user):
    p1 = project()
    _, h = add_user("user01")
    assert client.get(f"/api/projects/{p1.id}/imaging/studies", headers=h).status_code == 403


def test_imports_are_project_scoped(client, orthanc, project, member):
    p1, p2 = project("P1"), project("P2")
    h1 = member("ra01", p1)
    h2 = member("ra02", p2)
    upload(client, h1, p1.id, study_files(1))
    assert client.get(f"/api/projects/{p2.id}/imaging/studies", headers=h2).json() == []
    # 同一影像匯入另一個專案不算重複（去重範圍是專案）
    assert upload(client, h2, p2.id, study_files(1)).json()["counts"]["imported"] == SLICES


def test_study_detail_and_404(client, orthanc, project, member):
    p1 = project()
    h = member("ra01", p1)
    upload(client, h, p1.id, study_files(2))
    detail = client.get(f"/api/projects/{p1.id}/imaging/studies/{study_uid(2)}", headers=h).json()
    assert detail["accession_number"] == "ACC0002" and detail["series"][0]["modality"] == "MR"
    assert client.get(f"/api/projects/{p1.id}/imaging/studies/{study_uid(3)}", headers=h).status_code == 404


def test_no_orthanc_configured_is_503(client, project, member):
    p1 = project()
    h = member("ra01", p1)
    assert upload(client, h, p1.id, study_files(1)).status_code == 503


def test_jobs_listed(client, orthanc, project, member):
    p1 = project()
    h = member("ra01", p1)
    upload(client, h, p1.id, study_files(1))
    jobs = client.get(f"/api/projects/{p1.id}/imaging/jobs", headers=h).json()
    assert len(jobs) == 1 and jobs[0]["kind"] == "dicom" and jobs[0]["created_by"] == "ra01"
