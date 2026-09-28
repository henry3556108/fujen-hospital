import io
import json
import time

import httpx
import pytest

from importer.cli import main

GATEWAY = "http://gw.test"
KEYCLOAK = "http://kc.test"


class Recorder:
    """假 Gateway＋Keycloak：記錄每個請求，回應可依路徑設定。"""

    def __init__(self):
        self.requests: list[httpx.Request] = []
        self.uploads: list[tuple[str, list[str]]] = []
        self.status_for_upload = 201

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path
        if path.endswith("/protocol/openid-connect/token"):
            form = dict(x.split("=", 1) for x in request.content.decode().split("&"))
            if form.get("grant_type") == "password" and form.get("password") == "good":
                return httpx.Response(200, json={"access_token": "AT", "refresh_token": "RT", "expires_in": 300,
                                                 "refresh_expires_in": 1800})
            if form.get("grant_type") == "refresh_token":
                return httpx.Response(200, json={"access_token": "AT2", "refresh_token": "RT2", "expires_in": 300,
                                                 "refresh_expires_in": 1800})
            return httpx.Response(401, json={"error": "invalid_grant"})
        if request.headers.get("authorization", "") not in ("Bearer AT", "Bearer AT2"):
            return httpx.Response(401, json={"detail": "未登入"})
        if path == "/api/me":
            return httpx.Response(200, json={"username": "ra01", "projects": [{"id": 1, "name": "P1-lung-ct"}]})
        if path.startswith("/api/projects/1/imaging/"):
            kind = path.rsplit("/", 1)[1]
            names = _multipart_names(request)
            self.uploads.append((kind, names))
            if self.status_for_upload != 201:
                return httpx.Response(self.status_for_upload, json={"detail": "你沒有 labeling 權限"})
            files = [{"filename": n, "status": "failed" if "bad" in n else "imported",
                      "reason": "DICOM 被截斷" if "bad" in n else ""} for n in names]
            return httpx.Response(201, json={"id": len(self.uploads), "files": files})
        return httpx.Response(404)


def _multipart_names(request):
    body = request.content.decode("latin-1")
    return [part.split('filename="', 1)[1].split('"', 1)[0] for part in body.split("\r\n--")
            if 'filename="' in part]


@pytest.fixture
def env(tmp_path, monkeypatch):
    token_file = tmp_path / "token.json"
    monkeypatch.setenv("IMPORTER_TOKEN_FILE", str(token_file))
    monkeypatch.setenv("GATEWAY_URL", GATEWAY)
    monkeypatch.setenv("KEYCLOAK_URL", KEYCLOAK)
    return token_file


def run(argv, recorder, stdin=""):
    out, err = io.StringIO(), io.StringIO()
    code = main(argv, transport=httpx.MockTransport(recorder), stdout=out, stderr=err, stdin=io.StringIO(stdin))
    return code, out.getvalue(), err.getvalue()


def _folder(tmp_path, names):
    root = tmp_path / "data"
    for n in names:
        p = root / n
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b"x")
    root.mkdir(exist_ok=True)
    return root


def _login(recorder):
    assert run(["login", "--username", "ra01", "--password-stdin"], recorder, stdin="good\n")[0] == 0


def test_tc_b01_01_upload_refused_without_login(env, tmp_path):
    rec = Recorder()
    folder = _folder(tmp_path, ["a/IM1.dcm"])
    code, out, err = run(["upload", "--project", "1", str(folder)], rec)
    assert code == 2
    assert "登入" in err
    assert rec.requests == []   # 一個請求都沒送


def test_tc_b01_01_expired_session_refused(env, tmp_path):
    env.write_text(json.dumps({"access_token": "old", "refresh_token": "old", "expires_at": 0,
                               "refresh_expires_at": 0}))
    rec = Recorder()
    code, _, err = run(["upload", "--project", "1", str(_folder(tmp_path, ["IM1.dcm"]))], rec)
    assert code == 2 and "登入" in err and rec.uploads == []


def test_login_wrong_password_fails(env):
    code, _, err = run(["login", "--username", "ra01", "--password-stdin"], Recorder(), stdin="bad\n")
    assert code != 0 and "登入失敗" in err and not env.exists()


def test_login_saves_private_token_file(env):
    _login(Recorder())
    assert json.loads(env.read_text())["access_token"] == "AT"
    assert oct(env.stat().st_mode & 0o777) == "0o600"


def test_upload_through_gateway_with_table(env, tmp_path):
    rec = Recorder()
    _login(rec)
    folder = _folder(tmp_path, ["s1/IM1.dcm", "s1/IM2", "nifti/c_image.nii.gz", "m.json", "notes.txt",
                                "manifest.json", ".DS_Store"])
    code, out, err = run(["upload", "--project", "P1-lung-ct", "--exclude", "manifest.json", str(folder)], rec)
    assert code == 1   # notes.txt 失敗 → 非零
    assert rec.uploads[0] == ("dicom", ["s1/IM1.dcm", "s1/IM2"])
    assert rec.uploads[1] == ("files", ["m.json", "nifti/c_image.nii.gz"])
    assert all(r.url.host == "gw.test" for r in rec.requests if "openid-connect" not in r.url.path)
    assert "notes.txt" in out and "不支援的副檔名" in out
    assert "匯入 4" in out and "失敗 1" in out
    assert "manifest.json" not in out and ".DS_Store" not in out


def test_all_ok_exit_zero(env, tmp_path):
    rec = Recorder()
    _login(rec)
    code, out, _ = run(["upload", "--project", "1", str(_folder(tmp_path, ["IM1.dcm", "IM2.dcm"]))], rec)
    assert code == 0 and "失敗 0" in out


def test_server_file_failure_nonzero_with_reason(env, tmp_path):
    rec = Recorder()
    _login(rec)
    code, out, _ = run(["upload", "--project", "1", str(_folder(tmp_path, ["IM1.dcm", "bad.dcm"]))], rec)
    assert code == 1 and "bad.dcm" in out and "截斷" in out


def test_batches_respect_size(env, tmp_path):
    rec = Recorder()
    _login(rec)
    run(["upload", "--project", "1", "--batch-size", "2", str(_folder(tmp_path, [f"IM{i}.dcm" for i in range(5)]))], rec)
    assert [len(names) for _, names in rec.uploads] == [2, 2, 1]


def test_empty_folder_nonzero(env, tmp_path):
    rec = Recorder()
    _login(rec)
    code, _, err = run(["upload", "--project", "1", str(_folder(tmp_path, []))], rec)
    assert code == 1 and "沒有" in err and rec.uploads == []


def test_permission_denied_marks_batch_failed(env, tmp_path):
    rec = Recorder()
    rec.status_for_upload = 403
    _login(rec)
    code, out, _ = run(["upload", "--project", "1", str(_folder(tmp_path, ["IM1.dcm"]))], rec)
    assert code == 1 and "labeling" in out


def test_unknown_project(env, tmp_path):
    rec = Recorder()
    _login(rec)
    code, _, err = run(["upload", "--project", "P9", str(_folder(tmp_path, ["IM1.dcm"]))], rec)
    assert code == 2 and "P9" in err and rec.uploads == []


def test_expired_access_token_is_refreshed(env, tmp_path):
    env.write_text(json.dumps({"access_token": "old", "refresh_token": "RT", "expires_at": 0,
                               "refresh_expires_at": time.time() + 600}))
    rec = Recorder()
    code, _, _ = run(["upload", "--project", "1", str(_folder(tmp_path, ["IM1.dcm"]))], rec)
    assert code == 0 and json.loads(env.read_text())["access_token"] == "AT2"


def test_logout_removes_token(env):
    _login(Recorder())
    assert run(["logout"], Recorder())[0] == 0 and not env.exists()
