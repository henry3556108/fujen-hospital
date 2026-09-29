"""TC-D01-06：上傳檔案掃毒。EICAR 測試字串在執行時組出來，不存成檔案。"""
import socket
import struct
import threading

import pytest
from sqlalchemy import select

from app.models import AuditLog
from app.scanning import (ClamdScanner, FakeScanner, MalwareDetected, NoScanner, ScannerUnavailable,
                          ScanningObjectStore, eicar, scanner_from_env)
from app.storage import LocalObjectStore
from imaging_support import make_dicom, make_nifti, member, orthanc, project, upload  # noqa: F401
from tabular_helpers import member as tabular_member, schema_text, synth, upload as upload_csv  # noqa: F401


def test_eicar_string_is_the_standard_68_bytes():
    assert len(eicar()) == 68 and eicar().startswith(b"X5O!P%@AP") and eicar().endswith(b"$H+H*")


def test_tc_d01_06_fake_scanner_blocks_eicar_and_passes_clean():
    scanner = FakeScanner()
    assert scanner.scan("a.txt", b"hello").clean
    result = scanner.scan("b.txt", b"prefix" + eicar())
    assert not result.clean and result.signature == "Eicar-Signature"


def test_scanner_from_env():
    assert isinstance(scanner_from_env({}), NoScanner)
    scanner = scanner_from_env({"CLAMAV_HOST": "clamav", "CLAMAV_PORT": "3311"})
    assert isinstance(scanner, ClamdScanner) and (scanner.host, scanner.port) == ("clamav", 3311)


class FakeClamd:
    """照 clamd 的 INSTREAM 協定收資料，依內容回覆。"""

    def __init__(self, reply=None):
        self.reply, self.received = reply, []
        self.server = socket.create_server(("127.0.0.1", 0))
        self.port = self.server.getsockname()[1]
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self):
        while True:
            try:
                conn, _ = self.server.accept()
            except OSError:
                return
            with conn:
                command = conn.recv(10)
                assert command == b"zINSTREAM\0"
                body = b""
                while True:
                    size = struct.unpack("!I", self._exact(conn, 4))[0]
                    if size == 0:
                        break
                    body += self._exact(conn, size)
                self.received.append(body)
                if self.reply is not None:
                    conn.sendall(self.reply)
                elif eicar() in body:
                    conn.sendall(b"stream: Eicar-Signature FOUND\0")
                else:
                    conn.sendall(b"stream: OK\0")

    @staticmethod
    def _exact(conn, n):
        data = b""
        while len(data) < n:
            data += conn.recv(n - len(data))
        return data

    def close(self):
        self.server.close()


def test_tc_d01_06_clamd_protocol_clean_and_found():
    clamd = FakeClamd()
    scanner = ClamdScanner("127.0.0.1", clamd.port, timeout=5)
    big = b"x" * (3 * (1 << 20) + 17)      # 跨多個分段
    assert scanner.scan("big.bin", big).clean
    found = scanner.scan("e.txt", eicar())
    assert not found.clean and found.signature == "Eicar-Signature"
    assert clamd.received == [big, eicar()]
    clamd.close()


def test_tc_d01_06_clamd_error_reply_and_refused_connection_fail_closed():
    clamd = FakeClamd(reply=b"INSTREAM size limit exceeded. ERROR\0")
    with pytest.raises(ScannerUnavailable, match="size limit"):
        ClamdScanner("127.0.0.1", clamd.port, timeout=5).scan("a", b"x")
    clamd.close()
    probe = socket.socket()
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
    probe.close()                          # 沒有人在聽的連接埠
    with pytest.raises(ScannerUnavailable, match="無法連線"):
        ClamdScanner("127.0.0.1", port, timeout=1).scan("a", b"x")


def test_tc_d01_06_store_wrapper_blocks_before_writing(tmp_path):
    inner = LocalObjectStore(tmp_path)
    store = ScanningObjectStore(inner, lambda: FakeScanner())
    store.put("ok/a.bin", b"fine")
    with pytest.raises(MalwareDetected):
        store.put("bad/e.bin", eicar())
    assert store.list("") == ["ok/a.bin"] and store.get("ok/a.bin") == b"fine"
    with pytest.raises(ScannerUnavailable):
        ScanningObjectStore(inner, lambda: FakeScanner(offline=True)).put("x/y", b"fine")
    assert inner.list("") == ["ok/a.bin"]


def test_app_without_clamav_uses_no_scanner_and_wraps_store(app):
    assert isinstance(app.state.scanner, NoScanner)
    assert isinstance(app.state.store, ScanningObjectStore)


def test_tc_d01_06_imaging_files_infected_file_fails_alone(app, client, store, orthanc, project, member):
    app.state.scanner = FakeScanner()
    p = project()
    h = member("ra01", p)
    job = upload(client, h, p.id, [("nifti/case_001_image.nii.gz", make_nifti()),
                                   ("nifti/case_002_image.nii.gz", eicar())], kind="files").json()
    assert job["counts"] == {"imported": 1, "duplicate": 0, "failed": 1}
    failed = [f for f in job["files"] if f["status"] == "failed"]
    assert failed == [{**failed[0], "filename": "nifti/case_002_image.nii.gz", "reason": "掃毒攔截：Eicar-Signature"}]
    assert [k for k in store.list("") if "case_002" in k] == []


def test_tc_d01_06_dicom_upload_is_scanned_too(app, client, orthanc, project, member):
    app.state.scanner = FakeScanner()
    p = project()
    h = member("ra01", p)
    job = upload(client, h, p.id, [("s1/1.dcm", make_dicom(1, 1)), ("s1/2.dcm", make_dicom(1, 2) + eicar())]).json()
    assert job["counts"] == {"imported": 1, "duplicate": 0, "failed": 1}
    assert [f["reason"] for f in job["files"] if f["status"] == "failed"] == ["掃毒攔截：Eicar-Signature"]


def test_tc_d01_06_imaging_scanner_offline_rejects_every_file(app, client, store, orthanc, project, member):
    app.state.scanner = FakeScanner(offline=True)
    p = project()
    h = member("ra01", p)
    job = upload(client, h, p.id, [("nifti/case_001_image.nii.gz", make_nifti())], kind="files").json()
    assert job["counts"] == {"imported": 0, "duplicate": 0, "failed": 1}
    assert job["files"][0]["reason"].startswith("未能掃毒，已拒絕")
    assert store.list("") == []


def test_tc_d01_06_tabular_upload_blocked_with_audit(app, client, store, session, tabular_member, synth, schema_text):
    app.state.scanner = FakeScanner()
    pid, headers = tabular_member("pi01")
    infected = (synth / "cohort_01.csv").read_bytes() + b"\n" + eicar()
    response = upload_csv(client, pid, headers, infected, schema_text, name="bad")
    assert response.status_code == 422
    assert response.json()["detail"] == {"code": "malware_detected", "signature": "Eicar-Signature",
                                         "message": "檔案未通過掃毒，已拒絕上傳"}
    assert store.list("") == []
    assert client.get(f"/api/projects/{pid}/tabular/datasets", headers=headers).json() == []
    row = session.scalar(select(AuditLog).where(AuditLog.action == "malware_blocked"))
    assert (row.actor, row.category, row.result, row.detail["signature"]) == ("pi01", "dataset", "rejected", "Eicar-Signature")


def test_tc_d01_06_tabular_clean_upload_still_works(app, client, tabular_member, synth, schema_text):
    scanner = app.state.scanner = FakeScanner()
    pid, headers = tabular_member("pi01")
    response = upload_csv(client, pid, headers, (synth / "cohort_01.csv").read_bytes(), schema_text, name="ok")
    assert response.status_code == 201
    assert "data.csv" in scanner.scanned


def test_tc_d01_06_tabular_scanner_offline_is_503(app, client, store, tabular_member, synth, schema_text):
    app.state.scanner = FakeScanner(offline=True)
    pid, headers = tabular_member("pi01")
    response = upload_csv(client, pid, headers, (synth / "cohort_01.csv").read_bytes(), schema_text, name="x")
    assert response.status_code == 503 and "已拒絕上傳" in response.json()["detail"]
    assert store.list("") == []
