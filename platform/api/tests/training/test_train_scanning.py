"""上傳推論、修改後的原始碼、線上推論的影像都要掃毒（TC-D01-06）。"""
import io
import zipfile

import pytest
from sqlalchemy import select

from app.models import AuditLog
from app.permissions import Role
from app.scanning import FakeScanner, eicar
from conftest_training import finish, ok, setting_body, start


@pytest.fixture
def models(client, pi, project, backend, inference, images, table, tmp_path):
    tab = finish(client, backend, pi, start(client, pi, project.id,
                                            setting_body("tabular_classification", dataset_id=table)), tmp_path / "t")
    img = finish(client, backend, pi, start(client, pi, project.id,
                                            setting_body("image_classification", synth=images)), tmp_path / "i")
    return tab, img


def blocked_audits(session):
    return session.scalars(select(AuditLog).where(AuditLog.action == "malware_blocked")).all()


def test_tc_d01_06_infected_csv_is_rejected_before_inference(app, client, pi, project, models, inference, session):
    app.state.scanner = FakeScanner()
    tab, _ = models
    response = client.post(f"/api/projects/{project.id}/models/{tab['model_id']}/inference/upload", headers=pi,
                           files=[("files", ("x.csv", b"age,bmi\n" + eicar(), "text/csv"))])
    assert response.status_code == 422 and response.json()["detail"]["code"] == "malware_detected"
    assert ("predict_tabular", tab["model_id"]) not in inference.calls
    assert ok(client.get(f"/api/projects/{project.id}/models/{tab['model_id']}/inference", headers=pi)) == []
    assert [a.target for a in blocked_audits(session)] == ["x.csv"]


def test_tc_d01_06_infected_image_fails_alone(app, client, pi, project, models, images, session):
    app.state.scanner = FakeScanner()
    _, img = models
    good = sorted((images / "dicom").rglob("*.dcm"))[:2]
    files = [("files", (p.name, p.read_bytes())) for p in good] + [("files", ("bad.dcm", eicar()))]
    out = ok(client.post(f"/api/projects/{project.id}/models/{img['model_id']}/inference/upload", headers=pi,
                         files=files), 201)
    assert out["count"] == 2 and [r["name"] for r in out["result"]["results"]] == [p.name for p in good]
    assert out["result"]["blocked"] == [{"name": "bad.dcm", "reason": "掃毒攔截：Eicar-Signature"}]
    assert out["input"]["blocked"][0]["name"] == "bad.dcm"
    only_bad = client.post(f"/api/projects/{project.id}/models/{img['model_id']}/inference/upload", headers=pi,
                           files=[("files", ("bad.dcm", eicar()))])
    assert only_bad.status_code == 422 and only_bad.json()["detail"]["code"] == "all_files_blocked"


def test_tc_d01_06_scanner_offline_rejects_uploads(app, client, pi, project, models):
    app.state.scanner = FakeScanner(offline=True)
    tab, _ = models
    response = client.post(f"/api/projects/{project.id}/models/{tab['model_id']}/inference/upload", headers=pi,
                           files=[("files", ("x.csv", b"age\n1\n", "text/csv"))])
    assert response.status_code == 503 and "掃毒服務" in response.json()["detail"]


def test_tc_d01_06_infected_source_zip_is_rejected(app, client, pi, project, models, session):
    app.state.scanner = FakeScanner()
    tab, _ = models
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("train.py", b"print(1)\n")
        archive.writestr("notes.txt", eicar())
    before = len(ok(client.get(f"/api/projects/{project.id}/training/runs", headers=pi)))
    response = client.post(f"/api/projects/{project.id}/training/runs/{tab['id']}/source-runs", headers=pi,
                           files={"file": ("source.zip", buffer.getvalue(), "application/zip")})
    assert response.status_code == 422 and response.json()["detail"]["code"] == "malware_detected"
    assert len(ok(client.get(f"/api/projects/{project.id}/training/runs", headers=pi))) == before


def test_tc_d01_06_online_images_are_scanned_after_the_access_check(app, client, pi, member, project, models,
                                                                    images, session):
    app.state.scanner = FakeScanner()
    _, img = models
    md, vw = member("md01", Role.MEDICAL_DOCTOR), member("vw01", Role.VIEWER)
    endpoint = ok(client.post(f"/api/projects/{project.id}/deployments", headers=pi,
                              json={"model_id": img["model_id"], "name": "scan-me", "allowed_users": ["md01"]}),
                  201)["endpoint"]
    good = sorted((images / "dicom").rglob("*.dcm"))[0]
    files = [("files", (good.name, good.read_bytes())), ("files", ("bad.dcm", eicar()))]
    assert client.post(endpoint, headers=vw, files=files).status_code == 403
    out = ok(client.post(endpoint, headers=md, files=files))
    assert len(out["results"]) == 1 and out["blocked"][0]["name"] == "bad.dcm"
