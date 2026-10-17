"""M2 流程程式碼：整個流程匯出成專案包（內容、去識別、密碼掃描、附資料限計畫主持人）與地端重做（F-10）。"""
import io
import json
import subprocess
import sys
import zipfile

from app.models import AuditLog
from app.permissions import Role
from conftest_training import ok, run_container, setting_body


def unzip(data: bytes) -> dict[str, bytes]:
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        return {name: archive.read(name) for name in archive.namelist()}


def base(setting, suffix=""):
    return f"/api/projects/{setting['project_id']}/training/settings/{setting['id']}{suffix}"


def make(client, headers, pid, kind="tabular_classification", **kwargs):
    return ok(client.post(f"/api/projects/{pid}/training/settings", headers=headers,
                          json=setting_body(kind, **kwargs)), 201)


def package(client, headers, setting, include_data=False):
    return client.get(base(setting, "/package"), headers=headers, params={"include_data": include_data})


def test_package_contents(client, pi, project, table, session):
    setting = make(client, pi, project.id, dataset_id=table)
    response = package(client, pi, setting)
    assert response.status_code == 200 and response.headers["content-type"] == "application/zip"
    files = unzip(response.content)
    for stage, names in {"import": ("import.json", "schema.json", "load_data.py"),
                         "labels": ("labels.json", "labels.py"), "preprocess": ("preprocess.json", "preprocess.py"),
                         "train": ("train.json", "train.py"), "deploy": ("deploy.json", "predict.py")}.items():
        for name in (*names, "stage.json"):
            assert f"stages/{stage}/{name}" in files, (stage, name)
        assert json.loads(files[f"stages/{stage}/stage.json"])["stage"] == stage
    for name in ("flow.json", "README.md", "requirements.txt", "run_all.py", "config.json", "lib/runtime.py",
                 "lib/tabularkit.py", "lib/tabular/schema.py", "tools/build_dataset.py"):
        assert name in files, name
    assert not any(n.startswith("dataset/blobs/") for n in files), "沒勾選時不附原始資料"
    flow = json.loads(files["flow.json"])
    assert flow["format_version"] == 1 and flow["locked"] == [] and flow["includes"]["data"] is False
    import hashlib
    assert all(flow["files"][n] == hashlib.sha256(b).hexdigest() for n, b in files.items() if n != "flow.json")
    assert json.loads(files["stages/import/import.json"])["source"] == {"type": "tabular", "dataset_id": table}
    assert "run_all.py --data dataset --out out" in files["README.md"].decode()
    for name in files:
        if name.endswith(".py"):
            compile(files[name], name, "exec")
    entry = session.query(AuditLog).filter_by(action="flow.package_export").one()
    assert entry.category == "training" and entry.detail["includes"]["data"] is False


def test_image_package_is_deidentified_and_cannot_include_data(client, pi, project, session, synth):
    setting = make(client, pi, project.id, kind="image_classification", synth=synth)
    files = unzip(package(client, pi, setting).content)
    text = b"\n".join(files.values()).decode("utf-8", "replace")
    for uid in setting["config"]["source"]["label_source"]["values"]:
        assert uid not in text, "研究 UID 不能出現在專案包內"
    labels = json.loads(files["stages/labels/labels.json"])
    assert list(labels["label_source"]["values"])[0] == "key-0001"
    response = package(client, pi, setting, include_data=True)
    assert response.status_code == 409 and "影像專案包不能附原始資料" in response.json()["detail"]


def test_include_data_is_limited_to_the_pi_and_audited(client, pi, member, project, table, session):
    setting = make(client, pi, project.id, dataset_id=table)
    coder = member("ca01", Role.CODER_ASSISTANT)
    response = package(client, coder, setting, include_data=True)
    assert response.status_code == 400 and "限計畫主持人" in response.json()["detail"]
    assert package(client, coder, setting).status_code == 200
    response = package(client, pi, setting, include_data=True)
    assert response.status_code == 200
    files = unzip(response.content)
    manifest = json.loads(files["dataset/manifest.json"])
    csv = files["dataset/blobs/" + manifest["items"][0]["files"]["csv"]["blob"]].decode()
    header = csv.splitlines()[0].split(",")
    assert set(header) == {"age", "bmi", "glucose", "sbp", "diagnosis"}, "只含用到的欄位，病歷號不輸出"
    assert "patient_id" not in csv and "study_accession" not in csv
    entry = session.query(AuditLog).filter_by(action="flow.package_export").order_by(AuditLog.id.desc()).first()
    assert entry.category == "data_exchange" and entry.detail["includes"]["data"] is True


def test_secret_in_code_aborts_the_export(client, pi, project, table, monkeypatch):
    setting = make(client, pi, project.id, dataset_id=table)
    view = ok(client.get(base(setting, "/stages/labels"), headers=pi))["files"]
    code = view["labels.py"] + '\nDB = "postgres://ai:s3cr3t-value-123@db"\n'
    ok(client.put(base(setting, "/stages/labels"), headers=pi, json={"files": {**view, "labels.py": code}}))
    monkeypatch.setenv("POSTGRES_PASSWORD", "s3cr3t-value-123")
    response = package(client, pi, setting)
    assert response.status_code == 409 and "stages/labels/labels.py 第" in response.json()["detail"]


def test_f10_package_reruns_locally_with_the_same_metrics(client, pi, project, table, backend, tmp_path):
    setting = make(client, pi, project.id, dataset_id=table)
    view = ok(client.get(base(setting, "/stages/preprocess"), headers=pi))["files"]
    code = view["preprocess.py"].replace("def fit_transform(", "# 自己改過\ndef fit_transform(")
    ok(client.put(base(setting, "/stages/preprocess"), headers=pi, json={"files": {**view, "preprocess.py": code}}))
    run = ok(client.post(base(setting, "/runs"), headers=pi, json={}), 201)
    assert run["executor"] == "source"
    done = run_container(client, backend, pi, run, tmp_path / "run")
    assert done["status"] == "succeeded", done["message"]

    files = unzip(package(client, pi, setting, include_data=True).content)
    root = tmp_path / "package"
    for name, body in files.items():
        (root / name).parent.mkdir(parents=True, exist_ok=True)
        (root / name).write_bytes(body)
    assert (root / "stages/preprocess/preprocess.py").read_text(encoding="utf-8") == code
    result = subprocess.run([sys.executable, "run_all.py", "--data", "dataset", "--out", "out"], cwd=root,
                            capture_output=True, text=True, timeout=600)
    assert result.returncode == 0, result.stdout[-2000:] + result.stderr[-2000:]
    local = json.loads((root / "out/metrics.json").read_text(encoding="utf-8"))
    assert local["test"] == done["metrics"]["test"] and local["rows"] == done["metrics"]["rows"], \
        "同一份資料、設定、亂數種子：結構式指標與平台相同"
    for name in ("model.pkl", "preprocess.pkl", "splits.json", "model_card.json"):
        assert (root / "out" / name).is_file(), name
