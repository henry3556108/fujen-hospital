"""TC-B05-05 匯出原始碼再跑：匯出 3 次、修改 1 個參數後在平台執行、執行環境沒有平台憑證。"""
import io
import json
import os
import zipfile
from pathlib import Path

import pytest

from app.models import AuditLog
from app.permissions import Role
from app.training import bundle
from app.training import config as cfg
from conftest_training import fetch_bundle, finish, ok, run_container, setting_body, start

TEMPLATES = Path(__file__).resolve().parents[3] / "training" / "trainer" / "templates"


def url(run, suffix=""):
    return f"/api/projects/{run['project_id']}/training/runs/{run['id']}{suffix}"


def unzip(data: bytes) -> dict[str, bytes]:
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        return {name: archive.read(name) for name in archive.namelist()}


def rezip(files: dict[str, bytes], prefix: str = "") -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, body in files.items():
            archive.writestr(prefix + name, body)
    return buffer.getvalue()


def submit_source(client, headers, run, data):
    return client.post(url(run, "/source-runs"), headers=headers,
                       files={"file": ("source.zip", data, "application/zip")})


@pytest.fixture
def trained(client, pi, project, backend, table, tmp_path):
    run = start(client, pi, project.id, setting_body("tabular_classification", dataset_id=table),
                executor="template")
    done = run_container(client, backend, pi, run, tmp_path / "original")
    assert done["status"] == "succeeded", done["message"]
    return done


@pytest.mark.parametrize("kind", cfg.KINDS)
def test_tc_b05_05_export_three_times(kind, client, pi, project, backend, images, volumes, table, tmp_path,
                                      session):
    """匯出 3 次失敗 0；三次內容相同；內容就是平台執行的範本與這次訓練的設定。"""
    run = finish(client, backend, pi, start(client, pi, project.id, setting_body(
        kind, synth=images, dataset_id=table)), tmp_path)
    exports = []
    for _ in range(3):
        response = client.get(url(run, "/source"), headers=pi)
        assert response.status_code == 200 and response.headers["content-type"] == "application/zip"
        exports.append(response.content)
    assert exports[0] == exports[1] == exports[2]
    files = unzip(exports[0])
    helper = "imagekit.py" if kind in cfg.IMAGE_KINDS else "tabularkit.py"
    assert {"train.py", "runtime.py", helper, "config.json", "requirements.txt", "README.md"} <= set(files)
    assert files["train.py"] == (TEMPLATES / f"{kind}.py").read_bytes()
    assert files["runtime.py"] == (TEMPLATES / "runtime.py").read_bytes()
    config = json.loads(files["config.json"])
    assert config == {k: v for k, v in run["config"].items() if k != "executor"}
    assert ("tabular/fitted.py" in files) == (kind in cfg.TABULAR_KINDS)
    compile(files["train.py"], "train.py", "exec")
    audits = [a for a in session.query(AuditLog).filter_by(action="training.export_source")]
    assert len(audits) == 3 and audits[0].category == "training"


def test_tc_b05_05_modify_one_parameter_and_run_on_platform(client, pi, project, backend, trained, tmp_path,
                                                           session):
    """改 1 個參數（樹的數量 20 → 5）後在平台執行：用同一份凍結資料，真的訓練出模型。"""
    files = unzip(client.get(url(trained, "/source"), headers=pi).content)
    config = json.loads(files["config.json"])
    assert config["hyperparameters"]["n_estimators"] == 20
    config["hyperparameters"]["n_estimators"] = 5
    files["config.json"] = json.dumps(config).encode()

    response = submit_source(client, pi, trained, rezip(files))
    assert response.status_code == 201, response.text
    child = response.json()
    assert child["executor"] == "source" and child["custom_source"] and child["parent_run_id"] == trained["id"]
    assert child["dataset_version_id"] == trained["dataset_version_id"]
    assert child["config"]["hyperparameters"]["n_estimators"] == 5
    assert child["config"]["tabular"] == trained["config"]["tabular"]

    root = fetch_bundle(client, backend, child, tmp_path / "peek")
    assert (root / "source" / "train.py").read_bytes() == files["train.py"]
    assert (root / "source" / "tabular" / "fitted.py").is_file()
    assert not (root / "source" / "config.json").exists(), "設定只有一份：資料包根目錄的 config.json"

    done = run_container(client, backend, pi, child, tmp_path / "child")
    assert done["status"] == "succeeded", done["message"]
    assert done["model_id"] and done["model_id"] != trained["model_id"]
    assert done["artifacts"]["model.pkl"]["sha256"] != trained["artifacts"]["model.pkl"]["sha256"]
    assert done["metrics"]["rows"] == trained["metrics"]["rows"], "同一份資料、同一個切分"
    actions = [a.action for a in session.query(AuditLog).filter_by(category="training")]
    assert "training.run_source" in actions
    # 再匯出這次訓練的原始碼，拿到的是使用者上傳的版本
    assert unzip(client.get(url(done, "/source"), headers=pi).content)["train.py"] == files["train.py"]


def test_tc_b05_05_modified_code_runs_and_sees_no_credentials(client, pi, project, backend, trained, tmp_path,
                                                             monkeypatch):
    """修改程式本身：訓練前把看得到的環境變數寫進紀錄。平台帳密與工作 token 都不在裡面。"""
    secrets = {"DATABASE_URL": "postgresql+psycopg://platform:platform-dev@postgres:5432/platform",
               "KEYCLOAK_CLIENT_SECRET": "api-secret-dev", "S3_SECRET_KEY": "minio-dev-secret",
               "S3_ACCESS_KEY": "minio-dev", "ORTHANC_PASSWORD": "orthanc-api-dev",
               "INFERENCE_ADMIN_TOKEN": "inference-admin-dev", "KUBECONFIG": "/etc/platform/kubeconfig.kind"}
    for key, value in secrets.items():          # 模擬最壞情況：執行 runner 的程序自己帶著平台帳密
        monkeypatch.setenv(key, value)
    files = unzip(client.get(url(trained, "/source"), headers=pi).content)
    probe = (b"import os, json\n"
             b"print('ENVIRONMENT=' + json.dumps(dict(os.environ), sort_keys=True))\n")
    files["train.py"] = probe + files["train.py"]
    child = ok(submit_source(client, pi, trained, rezip(files, prefix="my-training/")), 201)
    done = run_container(client, backend, pi, child, tmp_path / "child")
    assert done["status"] == "succeeded", done["message"]

    log = ok(client.get(url(done, "/log"), headers=pi))["log"]
    line = next(l for l in log.splitlines() if l.startswith("ENVIRONMENT="))
    seen = json.loads(line.removeprefix("ENVIRONMENT="))
    assert not set(seen) & (set(secrets) | {"JOB_IO_TOKEN", "JOB_IO_URL"})
    for value in secrets.values():
        assert value not in line
    assert set(seen) <= {"PATH", "HOME", "LANG", "LC_ALL", "PYTHONDONTWRITEBYTECODE", "PYTHONUNBUFFERED",
                         "PYTHONIOENCODING", "MPLCONFIGDIR", "TRAIN_THREADS", "TF_CPP_MIN_LOG_LEVEL",
                         "LC_CTYPE", "CUDA_VISIBLE_DEVICES", "LD_LIBRARY_PATH", "NVIDIA_VISIBLE_DEVICES",
                         "PYTHONHASHSEED"}
    assert os.environ["S3_SECRET_KEY"] == "minio-dev-secret", "runner 所在的程序確實帶著帳密"


def test_modified_code_that_fails_reports_the_error(client, pi, project, backend, trained, tmp_path):
    files = unzip(client.get(url(trained, "/source"), headers=pi).content)
    files["train.py"] = b"raise SystemExit('learning rate must be positive')\n"
    child = ok(submit_source(client, pi, trained, rezip(files)), 201)
    done = run_container(client, backend, pi, child, tmp_path / "child")
    assert done["status"] == "failed" and done["model_id"] is None
    assert "learning rate must be positive" in done["message"]
    assert "learning rate must be positive" in ok(client.get(url(done, "/log"), headers=pi))["log"]


@pytest.mark.parametrize("make,message", [
    (lambda f: b"not a zip", "不是 zip"),
    (lambda f: rezip({k: v for k, v in f.items() if k != "train.py"}), "找不到 train.py"),
    (lambda f: rezip(f | {"train.py": b"def broken(:\n"}), "語法錯誤"),
    (lambda f: rezip(f | {"../escape.py": b"x = 1\n"}), "不合法的路徑"),
    (lambda f: rezip(f | {"payload.so": b"\x7fELF"}), "不允許的檔案類型"),
    (lambda f: rezip(f | {"config.json": b"{not json"}), "不是合法的 JSON"),
    (lambda f: rezip(f | {"config.json": json.dumps(json.loads(f["config.json"]) | {
        "kind": "tabular_regression"}).encode()}), "訓練種類必須維持"),
    (lambda f: rezip(f | {"config.json": json.dumps(json.loads(f["config.json"]) | {
        "seed": -5}).encode()}), "亂數種子"),
    (lambda f: rezip(f | {"big.txt": os.urandom(bundle.MAX_SOURCE_BYTES + 1)}), "超過上限"),
])
def test_invalid_source_uploads_are_rejected(make, message, client, pi, project, backend, trained):
    files = unzip(client.get(url(trained, "/source"), headers=pi).content)
    before = len(ok(client.get(f"/api/projects/{project.id}/training/runs", headers=pi)))
    response = submit_source(client, pi, trained, make(files))
    assert response.status_code == 422 and message in response.json()["detail"], response.text
    assert len(ok(client.get(f"/api/projects/{project.id}/training/runs", headers=pi))) == before


def test_source_needs_coding_permission(client, pi, member, project, backend, trained):
    """Research Assistant 有 training 沒有 coding：可以訓練，不能匯出或執行原始碼。"""
    data = client.get(url(trained, "/source"), headers=pi).content
    assistant, coder, viewer = member("ra01", Role.RESEARCH_ASSISTANT), member("ca01", Role.CODER_ASSISTANT), \
        member("vw01", Role.VIEWER)
    for headers in (assistant, viewer):
        assert client.get(url(trained, "/source"), headers=headers).status_code == 403
        assert submit_source(client, headers, trained, data).status_code == 403
    assert client.get(url(trained, "/source"), headers=coder).status_code == 200
    child = ok(submit_source(client, coder, trained, data), 201)
    # 重跑使用者原始碼的訓練同樣需要 coding
    assert client.post(url(child, "/rerun"), headers=assistant).status_code == 403
    assert client.post(url(child, "/rerun"), headers=coder).status_code == 201
    assert client.post(url(trained, "/rerun"), headers=assistant).status_code == 201


def test_export_of_custom_source_run_includes_this_run_config(client, pi, project, backend, trained):
    """用修改後的程式跑的訓練：匯出的 zip 也有這次的 config.json；上傳檔裡原有的改名為 config.original.json。"""
    files = unzip(client.get(url(trained, "/source"), headers=pi).content)
    config = json.loads(files["config.json"])
    config["hyperparameters"]["n_estimators"] = 7
    files["config.json"] = json.dumps(config).encode()
    child = ok(submit_source(client, pi, trained, rezip(files)), 201)
    exported = unzip(client.get(url(child, "/source"), headers=pi).content)
    expected = {k: v for k, v in child["config"].items() if k != "executor"}
    assert json.loads(exported["config.json"]) == expected
    assert expected["hyperparameters"]["n_estimators"] == 7
    assert exported["config.original.json"] == files["config.json"]
    assert exported["train.py"] == files["train.py"]

    # 上傳檔沒有 config.json、整包放在資料夾內：加在 train.py 同一層，沒有 config.original.json
    del files["config.json"]
    child = ok(submit_source(client, pi, trained, rezip(files, prefix="my-training/")), 201)
    exported = unzip(client.get(url(child, "/source"), headers=pi).content)
    assert json.loads(exported["my-training/config.json"]) == {k: v for k, v in child["config"].items()
                                                                if k != "executor"}
    assert json.loads(exported["my-training/config.json"])["hyperparameters"]["n_estimators"] == 20
    assert not any(name.endswith("config.original.json") for name in exported)
