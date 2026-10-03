"""TC-B01-03／04／05：NIfTI、ITK、makesense 匯入與影像↔標註配對。"""
from imaging_support import (make_makesense, make_mha, make_nifti, member, orthanc, project, sop_uid,  # noqa: F401
                             STUDIES, study_files, study_uid, upload)


def _cases(fmt, n=3):
    make, ext = (make_nifti, ".nii.gz") if fmt == "nifti" else (make_mha, ".mha")
    images = [(f"{fmt}/case_{i:03d}_image{ext}", make()) for i in range(1, n + 1)]
    labels = [(f"{fmt}/case_{i:03d}_label{ext}", make()) for i in range(1, n + 1)]
    return images, labels


def _files(client, h, pid):
    return {f["filename"]: f for f in client.get(f"/api/projects/{pid}/imaging/files", headers=h).json()}


def test_tc_b01_03_three_of_each_format_parse(client, store, orthanc, project, member):
    p1 = project()
    h = member("ra01", p1)
    upload(client, h, p1.id, [f for no in (1, 2, 3) for f in study_files(no)])
    ni, nl = _cases("nifti")
    ii, il = _cases("itk")
    ms = [(f"makesense/makesense_{i:03d}.json", make_makesense(i)) for i in (1, 2, 3)]
    job = upload(client, h, p1.id, ni + nl + ii + il + ms, kind="files").json()
    assert job["counts"] == {"imported": 15, "duplicate": 0, "failed": 0}
    files = _files(client, h, p1.id)
    assert {f["format"] for f in files.values()} == {"nifti", "itk", "makesense"}
    key = files["nifti/case_001_image.nii.gz"]
    assert key["meta"]["dims"] == [4, 4, 2]
    assert any(k.endswith("case_001_image.nii.gz") for k in store.list(f"projects/{p1.id}/imaging/files/"))


def test_tc_b01_04_pairing_same_batch_three_times(client, orthanc, project, member):
    for rep in range(3):
        p = project(f"P-same-{rep}")
        h = member(f"ra{rep}", p)
        images, labels = _cases("nifti")
        upload(client, h, p.id, labels + images, kind="files")   # 標註在前也要配對
        files = _files(client, h, p.id)
        for i in (1, 2, 3):
            label = files[f"nifti/case_{i:03d}_label.nii.gz"]
            assert label["pairing"] == "paired"
            assert label["paired_image"] == f"nifti/case_{i:03d}_image.nii.gz"


def test_tc_b01_04_pairing_separate_imports_three_times(client, orthanc, project, member):
    for rep in range(3):
        p = project(f"P-sep-{rep}")
        h = member(f"ra{rep}", p)
        images, labels = _cases("itk")
        upload(client, h, p.id, labels, kind="files")
        assert all(f["pairing"] == "unpaired" for f in _files(client, h, p.id).values())
        upload(client, h, p.id, images, kind="files")
        files = _files(client, h, p.id)
        for i in (1, 2, 3):
            assert files[f"itk/case_{i:03d}_label.mha"]["paired_image"] == f"itk/case_{i:03d}_image.mha"


def test_tc_b01_04_pairing_stays_in_project(client, orthanc, project, member):
    p1, p2 = project("P1"), project("P2")
    h1 = member("ra01", p1)
    h2 = member("ra02", p2)
    images, labels = _cases("nifti", 1)
    upload(client, h2, p2.id, images, kind="files")     # 影像只在 P2
    upload(client, h1, p1.id, labels, kind="files")     # 標註匯到 P1
    assert _files(client, h1, p1.id)["nifti/case_001_label.nii.gz"]["pairing"] == "unpaired"
    upload(client, h1, p1.id, images, kind="files")
    label = _files(client, h1, p1.id)["nifti/case_001_label.nii.gz"]
    assert label["pairing"] == "paired"
    assert label["paired_image"] == "nifti/case_001_image.nii.gz"


def test_tc_b01_04_makesense_pairs_to_dicom_either_order(client, orthanc, project, member):
    p1 = project()
    h = member("ra01", p1)
    upload(client, h, p1.id, [("makesense/makesense_001.json", make_makesense(1))], kind="files")
    label = _files(client, h, p1.id)["makesense/makesense_001.json"]
    assert label["pairing"] == "unpaired" and "找不到" in label["pairing_note"]
    upload(client, h, p1.id, [("dicom/" + n, d) for n, d in study_files(1)])  # 路徑多一層前綴也能配
    label = _files(client, h, p1.id)["makesense/makesense_001.json"]
    assert label["pairing"] == "paired"
    assert label["paired_sop_instance_uids"] == sorted(sop_uid(1, s) for s in (1, 2, 3))
    # 「檔案與配對」顯示配到哪個研究（Accession 與 Study Description），不只是張數
    assert label["paired_studies"] == [{"study_instance_uid": study_uid(1), "accession_number": "ACC0001",
                                        "study_description": STUDIES[1]["study"], "instances": 3}]
    image = _files(client, h, p1.id)
    assert all(f["paired_studies"] == [] for name, f in image.items() if name != "makesense/makesense_001.json")


def test_makesense_does_not_pair_with_other_study(client, orthanc, project, member):
    p1 = project()
    h = member("ra01", p1)
    upload(client, h, p1.id, study_files(2))
    upload(client, h, p1.id, [("m1.json", make_makesense(1))], kind="files")
    assert _files(client, h, p1.id)["m1.json"]["paired_sop_instance_uids"] == []


def test_tc_b01_05_bad_files_isolated(client, orthanc, project, member):
    p1 = project()
    h = member("ra01", p1)
    good = [("case_001_image.nii.gz", make_nifti())]
    bad = [("case_002_image.nii.gz", make_nifti()[:30]), ("case_003_image.mha", make_mha()[:-5]),
           ("broken.json", b"{"), ("photo.png", b"\x89PNG")]
    job = upload(client, h, p1.id, good + bad, kind="files").json()
    assert job["status"] == "partial"
    by_name = {f["filename"]: f for f in job["files"]}
    assert by_name["case_001_image.nii.gz"]["status"] == "imported"
    assert all(by_name[n]["status"] == "failed" and by_name[n]["reason"] for n, _ in bad)
    assert list(_files(client, h, p1.id)) == ["case_001_image.nii.gz"]


def test_same_file_twice_is_duplicate_and_changed_content_rejected(client, orthanc, project, member):
    p1 = project()
    h = member("ra01", p1)
    upload(client, h, p1.id, [("a_image.nii.gz", make_nifti())], kind="files")
    assert upload(client, h, p1.id, [("a_image.nii.gz", make_nifti())], kind="files").json()["counts"]["duplicate"] == 1
    other = upload(client, h, p1.id, [("a_image.nii.gz", make_nifti((2, 2, 2)))], kind="files").json()
    assert other["files"][0]["status"] == "failed"


def test_files_import_requires_labeling(client, orthanc, project, member):
    p1 = project()
    h = member("ca01", p1, permissions=("project", "training", "coding"))
    assert upload(client, h, p1.id, [("a_image.nii.gz", make_nifti())], kind="files").status_code == 403


def test_upload_over_limit_fails_only_that_file(client, store, orthanc, project, member):
    """單檔超過上限只讓該檔失敗（TC-B01-05 的原則），同批其他檔照常匯入；超限的檔案不進物件儲存。"""
    p1 = project()
    h = member("ra01", p1)
    client.app.state.imaging_max_file_bytes = 2000
    big = make_nifti((32, 32, 8), gz=False)             # 約 16 KB
    job = upload(client, h, p1.id, [("nifti/big_image.nii", big), ("nifti/ok_image.nii.gz", make_nifti())],
                 kind="files").json()
    assert job["counts"] == {"imported": 1, "duplicate": 0, "failed": 1}
    failed = next(f for f in job["files"] if f["status"] == "failed")
    assert failed["filename"] == "nifti/big_image.nii" and "超過上限" in failed["reason"]
    assert [k.rsplit("/", 1)[-1] for k in store.list(f"projects/{p1.id}/")] == ["ok_image.nii.gz"]


def test_upload_decompression_limit_applies(client, store, orthanc, project, member):
    p1 = project()
    h = member("ra01", p1)
    client.app.state.imaging_max_decompressed_bytes = 100 * 1024
    job = upload(client, h, p1.id, [("nifti/big_image.nii.gz", make_nifti((64, 64, 64)))], kind="files").json()
    assert job["counts"]["failed"] == 1 and "解壓縮後" in job["files"][0]["reason"]
    assert store.list(f"projects/{p1.id}/") == []


def test_dicom_upload_over_limit_fails_only_that_file(client, orthanc, project, member):
    p1 = project()
    h = member("ra01", p1)
    [(name, data), *rest] = study_files(1)
    client.app.state.imaging_max_file_bytes = len(data)
    job = upload(client, h, p1.id, [("huge.dcm", data + bytes(10)), (name, data)]).json()
    assert job["counts"] == {"imported": 1, "duplicate": 0, "failed": 1}
    assert "超過上限" in job["files"][0]["reason"] and len(orthanc.instances) == 1


def test_limits_default_and_env(monkeypatch):
    from types import SimpleNamespace

    from app.imaging.service import upload_limits

    assert upload_limits(SimpleNamespace()) == (512 * 1024 * 1024, 2048 * 1024 * 1024)
    monkeypatch.setenv("IMAGING_MAX_FILE_MB", "10")
    monkeypatch.setenv("IMAGING_MAX_DECOMPRESSED_MB", "0.5")
    assert upload_limits(SimpleNamespace()) == (10 * 1024 * 1024, 512 * 1024)
    assert upload_limits(SimpleNamespace(imaging_max_file_bytes=7, imaging_max_decompressed_bytes=9)) == (7, 9)
