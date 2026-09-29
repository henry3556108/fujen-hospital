"""CSV 自動分類標註的上傳檔也要掃毒（TC-D01-06）。"""
from sqlalchemy import select

from app.labeling.models import Annotation
from app.models import AuditLog
from app.scanning import FakeScanner, eicar


def _post(client, lab, data):
    return client.post(f"{lab.base}/classification-csv", headers=lab.doctor,
                       files={"file": ("diagnosis.csv", data, "text/csv")}, data={"key": "patient_id"})


def test_tc_d01_06_labeling_csv_blocked_with_audit(app, client, session, lab):
    app.state.scanner = FakeScanner()
    r = _post(client, lab, b"patient_id,diagnosis\nPAT0001,nodule\n" + eicar())
    assert r.status_code == 422 and r.json()["detail"]["code"] == "malware_detected"
    assert session.scalars(select(Annotation)).all() == []
    row = session.scalar(select(AuditLog).where(AuditLog.action == "malware_blocked"))
    assert (row.category, row.result, row.target) == ("dataset", "rejected", "diagnosis.csv")


def test_tc_d01_06_labeling_csv_scanner_offline_is_503(app, client, session, lab):
    app.state.scanner = FakeScanner(offline=True)
    r = _post(client, lab, b"patient_id,diagnosis\nPAT0001,nodule\n")
    assert r.status_code == 503
    assert session.scalars(select(Annotation)).all() == []
