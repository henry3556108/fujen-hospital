"""B-05 自動訓練與模型匯出、B-06 模型部署與推論服務：經 Gateway，訓練真的在 kind 叢集內以 platform-trainer 映像執行。

堆疊：docker compose -f compose.yaml -f compose.kind.yaml -f compose.training.yaml，並已執行
deploy/kind/load-trainer-image.sh 與 seed。訓練在 P1（綁定 gpu-exclusive）。
"""
import csv
import hashlib
import io
import json
import subprocess
import time
import zipfile
from pathlib import Path

import pytest

from training_support import (ROOT, SPLIT, audit, gateway, headers, last_audit_id, ok, p1_id, require_training,
                              submit, synth, wait, wait_all)
from labeling_support import ensure_images

AUGMENT = {"rotation_range": 10, "width_shift_range": 0.1, "height_shift_range": 0.1, "shear_range": 5,
           "zoom_range": 0.1, "horizontal_flip": True, "vertical_flip": True}
IMAGE_HYPER = {"epochs": 2, "batch_size": 8}


@pytest.fixture(scope="module")
def env(tmp_path_factory):
    out = tmp_path_factory.mktemp("synth")
    with gateway() as c:
        pid = p1_id(c)
        require_training(c, pid)
        studies = ensure_images(c, pid, synth(out, "dicom"))
        pi = headers("pi01")
        files = sorted(synth(out, "makesense").glob("makesense_*.json")) + sorted(synth(out, "nifti").glob("*.nii.gz"))
        ok(c.post(f"/api/projects/{pid}/imaging/files", headers=pi,
                  files=[("files", (p.name, p.read_bytes())) for p in files], timeout=120), 201)
        tab = synth(out, "tabular")
        dataset = ok(c.post(f"/api/projects/{pid}/tabular/datasets", headers=pi,
                            data={"schema": (tab / "schema.json").read_text(), "name": f"b05-{time.time_ns()}"},
                            files={"file": ("cohort_01.csv", (tab / "cohort_01.csv").read_bytes(), "text/csv")}),
                     201)["dataset"]["id"]
        yield {"c": c, "pid": pid, "studies": studies, "dataset": dataset, "synth": out}


def configs(env) -> dict[str, dict]:
    manifest = json.loads((env["synth"] / "dicom" / "manifest.json").read_text())
    visible = {s["study_instance_uid"] for s in env["studies"]}
    modality = {s["study_instance_uid"]: s["modality"] for s in manifest["studies"] if s["study_instance_uid"] in visible}
    source = lambda provider, **kw: {"type": "dicom", "studies": "all", "label_source": {"provider": provider, **kw}}  # noqa: E731
    tabular = {"type": "tabular", "dataset_id": env["dataset"]}
    return {
        "image_classification": {"kind": "image_classification", "source": source("inline", by="study", values=modality),
                                 "image": {"resize": [32, 32], "labels": ["CT", "MR"]}, "augmentation": AUGMENT,
                                 "hyperparameters": IMAGE_HYPER, "split": SPLIT, "seed": 11},
        "image_segmentation": {"kind": "image_segmentation", "source": {"type": "files", "format": "nifti", "cases": "all"},
                               "image": {"resize": [32, 32], "labels": ["class_1", "class_2"]}, "augmentation": AUGMENT,
                               "hyperparameters": IMAGE_HYPER, "split": SPLIT, "seed": 11},
        "image_detection": {"kind": "image_detection", "source": source("makesense"),
                            "image": {"resize": [32, 32], "labels": ["nodule", "organ"]}, "augmentation": AUGMENT,
                            "hyperparameters": IMAGE_HYPER, "split": SPLIT, "seed": 11},
        "tabular_classification": {"kind": "tabular_classification", "source": tabular, "split": SPLIT, "seed": 11,
                                   "tabular": {"target": "diagnosis", "features": ["age", "bmi", "glucose", "sbp"],
                                               "steps": [{"id": "impute_mean", "columns": ["glucose"]},
                                                         {"id": "scale_standard", "columns": ["age", "bmi"]}],
                                               "algorithm": "random_forest"}, "hyperparameters": {"n_estimators": 20}},
        "tabular_regression": {"kind": "tabular_regression", "source": tabular, "split": SPLIT, "seed": 11,
                               "tabular": {"target": "sbp", "features": ["age", "bmi", "glucose"],
                                           "steps": [{"id": "impute_median", "columns": ["glucose"]}],
                                           "algorithm": "linear_regression"}},
    }


@pytest.fixture(scope="module")
def trained(env):
    """TC-B05-01：5 種訓練各建立 1 次，在 kind 內跑完。回傳 {種類: (最終狀態, 看到的狀態序列)}。"""
    c, pid = env["c"], env["pid"]
    runs = {kind: submit(c, pid, "pi01", f"B05-01 {kind}", config) for kind, config in configs(env).items()}
    final, seen, most = wait_all(c, list(runs.values()))
    env["most_running"] = most
    return {kind: (f, s) for kind, f, s in zip(runs, final, seen)}


# ---------------------------------------------------------------- B-05

def test_tc_b05_01_five_kinds_created_and_transition(trained, env):
    for kind, (run, seen) in trained.items():
        assert run["status"] == "succeeded", (kind, run["message"])
        assert seen[-1] == "succeeded" and set(seen) <= {"queued", "running", "succeeded"}, (kind, seen)
        assert run["started_at"] and run["finished_at"] and run["model_id"], kind
        assert run["dataset_version"]["item_count"] > 0 and run["tracking_run_id"], kind
    assert all(seen[0] == "queued" for _, seen in trained.values()), "送出後先進佇列"
    assert sum("running" in seen for _, seen in trained.values()) >= 3, "輪詢看得到執行中"
    assert 1 <= env["most_running"] <= 2, f"獨占池 2 張卡，同時最多 2 件執行（看到 {env['most_running']}）"


def test_tc_b05_02_parameters_reload_identically(env):
    c, pid, h = env["c"], env["pid"], headers("pi01")
    config = configs(env)["image_classification"] | {"split": {"train": 0.7, "validation": 0.1, "test": 0.2},
                                                     "seed": 20260929}
    config["image"]["resize"] = [48, 64]
    config["source"]["studies"] = sorted(s["study_instance_uid"] for s in env["studies"])[:4]
    saved = ok(c.post(f"/api/projects/{pid}/training/settings", headers=h,
                      json={"name": f"B05-02 {time.time_ns()}", "config": config}), 201)
    for _ in range(3):
        assert ok(c.get(f"/api/projects/{pid}/training/settings/{saved['id']}", headers=h)) == saved
    got = saved["config"]
    assert (got["image"], got["split"], got["seed"]) == (
        {"resize": [48, 64], "labels": ["CT", "MR"]}, config["split"], 20260929)
    assert got["source"]["studies"] == config["source"]["studies"]
    assert got["augmentation"] == AUGMENT, "TC-B05-03：6 項增強逐項相同"


def test_tc_b05_04_rerun_three_times_same_metrics(trained, env):
    c, pid = env["c"], env["pid"]
    for kind in ("image_classification", "tabular_classification"):
        original = trained[kind][0]
        reruns = [ok(c.post(f"/api/projects/{pid}/training/runs/{original['id']}/rerun", headers=headers("pi01")), 201)
                  for _ in range(3)]
        for run in reruns:
            done, _ = wait(c, run)
            assert done["status"] == "succeeded", done["message"]
            assert (done["dataset_version_id"], done["config"], done["seed"]) == (
                original["dataset_version_id"], original["config"], original["seed"])
            assert done["metrics"] == original["metrics"], f"{kind} 指標差異"
            fmt = "model.h5" if kind.startswith("image_") else "model.pkl"
            assert done["artifacts"][fmt]["sha256"] == original["artifacts"][fmt]["sha256"], f"{kind} 模型不同"


def test_tc_b05_05_export_source_three_times_modify_and_run(trained, env):
    c, pid, h = env["c"], env["pid"], headers("pi01")
    original = trained["tabular_classification"][0]
    exports = [c.get(f"/api/projects/{pid}/training/runs/{original['id']}/source", headers=h) for _ in range(3)]
    assert [e.status_code for e in exports] == [200, 200, 200]
    assert len({hashlib.sha256(e.content).hexdigest() for e in exports}) == 1
    files = {n: zipfile.ZipFile(io.BytesIO(exports[0].content)).read(n)
             for n in zipfile.ZipFile(io.BytesIO(exports[0].content)).namelist()}
    config = json.loads(files["config.json"])
    config["hyperparameters"]["n_estimators"] = 5                     # 修改 1 個參數
    probe = (b"import os, json, pathlib\n"
             b"print('ENVIRONMENT=' + json.dumps(sorted(os.environ)))\n"
             b"print('SA_TOKEN=' + str(pathlib.Path('/var/run/secrets/kubernetes.io/serviceaccount/token').exists()))\n")
    files |= {"config.json": json.dumps(config).encode(), "train.py": probe + files["train.py"]}
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, body in files.items():
            archive.writestr(name, body)
    child = ok(c.post(f"/api/projects/{pid}/training/runs/{original['id']}/source-runs", headers=h,
                      files={"file": ("source.zip", buffer.getvalue(), "application/zip")}), 201)
    done, _ = wait(c, child)
    assert done["status"] == "succeeded", done["message"]
    assert done["config"]["hyperparameters"]["n_estimators"] == 5 and done["model_id"]
    log = ok(c.get(f"/api/projects/{pid}/training/runs/{done['id']}/log", headers=h))["log"]
    seen = json.loads(next(line for line in log.splitlines() if line.startswith("ENVIRONMENT=")).split("=", 1)[1])
    forbidden = {"JOB_IO_TOKEN", "JOB_IO_URL", "DATABASE_URL", "KEYCLOAK_CLIENT_SECRET", "S3_SECRET_KEY",
                 "S3_ACCESS_KEY", "ORTHANC_PASSWORD", "INFERENCE_ADMIN_TOKEN", "KUBERNETES_SERVICE_HOST"}
    assert not set(seen) & forbidden, set(seen) & forbidden
    assert "SA_TOKEN=False" in log, "Job 容器沒有掛 ServiceAccount token"


def test_tc_b05_06_four_models_load_outside_platform(trained, env, tmp_path):
    c, pid, h = env["c"], env["pid"], headers("pi01")
    paths = []
    for kind in ("tabular_classification", "tabular_regression", "image_classification", "image_detection"):
        model = ok(c.get(f"/api/projects/{pid}/models/{trained[kind][0]['model_id']}", headers=h))
        data = c.get(f"/api/projects/{pid}/models/{model['id']}/download", headers=h).content
        assert hashlib.sha256(data).hexdigest() == model["sha256"]
        paths.append(tmp_path / model["filename"])
        paths[-1].write_bytes(data)
    assert [p.suffix for p in paths] == [".pkl", ".pkl", ".h5", ".h5"]
    # 平台外：training 專案的環境（只用到 scikit-learn、pandas、keras），腳本檢查沒有 import 平台程式
    result = subprocess.run(["uv", "run", "-q", "--extra", "keras", "--project", str(ROOT / "training"), "python",
                             str(ROOT / "training" / "scripts" / "load_exported_models.py"), *map(str, paths)],
                            capture_output=True, text=True, cwd=tmp_path, timeout=600)
    lines = [json.loads(line) for line in result.stdout.splitlines() if line.startswith("{")]
    assert result.returncode == 0, result.stdout + result.stderr[-2000:]
    assert [l["ok"] for l in lines[:4]] == [True] * 4 and lines[-1] == {"platform_modules_imported": []}


def test_tc_b05_07_dataset_deleted_while_queued(env, tmp_path):
    """獨占池兩張卡先被佔住；排隊中刪除來源資料集，訓練仍以凍結的資料版本完成。"""
    c, pid, h = env["c"], env["pid"], headers("pi01")
    tab = env["synth"] / "tabular"
    dataset = ok(c.post(f"/api/projects/{pid}/tabular/datasets", headers=h,
                        data={"schema": (tab / "schema.json").read_text(), "name": f"b05-07-{time.time_ns()}"},
                        files={"file": ("cohort_02.csv", (tab / "cohort_02.csv").read_bytes(), "text/csv")}),
                 201)["dataset"]["id"]
    config = configs(env)["tabular_regression"] | {"source": {"type": "tabular", "dataset_id": dataset}}
    blockers = [submit(c, pid, "pi01", "B05-07 佔卡", config | {"hyperparameters": {"fake_sleep_seconds": 60}},
                       executor="fake") for _ in range(2)]
    queued = submit(c, pid, "pi01", "B05-07 排隊", config)
    for _ in range(30):
        states = [ok(c.get(f"/api/projects/{pid}/training/runs/{r['id']}", headers=h))["status"] for r in blockers]
        if states == ["running", "running"]:
            break
        time.sleep(2)
    assert ok(c.get(f"/api/projects/{pid}/training/runs/{queued['id']}", headers=h))["status"] == "queued"
    assert c.delete(f"/api/projects/{pid}/tabular/datasets/{dataset}", headers=h).status_code == 204
    done, seen = wait(c, queued)
    assert done["status"] == "succeeded", done["message"]
    assert seen[0] == "queued" and done["metrics"]["rows"]["train"] + done["metrics"]["rows"]["test"] > 0
    for blocker in blockers:
        assert wait(c, blocker)[0]["status"] == "succeeded"
    setting = queued["setting_id"]
    again = c.post(f"/api/projects/{pid}/training/settings/{setting}/runs", headers=h, json={})
    assert again.status_code == 422 and "找不到結構式資料集" in again.json()["detail"]


# ---------------------------------------------------------------- B-06

def model_id(trained, kind):
    return trained[kind][0]["model_id"]


def test_tc_b06_01_batch_inference_twenty_or_more(trained, env):
    c, pid, h = env["c"], env["pid"], headers("pi01")
    out = ok(c.post(f"/api/projects/{pid}/models/{model_id(trained, 'tabular_classification')}/inference/batch",
                    headers=h, json={"subset": "test"}, timeout=120), 201)
    assert out["status"] == "succeeded" and out["count"] >= 20
    image = ok(c.post(f"/api/projects/{pid}/models/{model_id(trained, 'image_classification')}/inference/batch",
                      headers=h, json={"subset": "test"}, timeout=300), 201)
    assert image["count"] >= 20 and all(r["label"] in ("CT", "MR") for r in image["result"]["results"])


def test_tc_b06_02_upload_ten_times(trained, env):
    c, pid, h = env["c"], env["pid"], headers("pi01")
    csv_bytes = (env["synth"] / "tabular" / "cohort_03.csv").read_bytes()
    dicoms = sorted((env["synth"] / "dicom").rglob("*.dcm"))
    results = []
    for i in range(10):
        if i % 2:
            files = [("files", (p.name, p.read_bytes())) for p in dicoms[i * 2:i * 2 + 2]]
            mid = model_id(trained, "image_classification")
        else:
            files = [("files", ("cohort_03.csv", csv_bytes, "text/csv"))]
            mid = model_id(trained, "tabular_regression")
        results.append(c.post(f"/api/projects/{pid}/models/{mid}/inference/upload", headers=h, files=files,
                              timeout=120))
    assert [r.status_code for r in results] == [201] * 10
    assert all(r.json()["status"] == "succeeded" for r in results)


def test_tc_b06_03_history_sampled_and_downloaded(trained, env):
    c, pid, h = env["c"], env["pid"], headers("pi01")
    mid = model_id(trained, "tabular_classification")
    for _ in range(10):
        ok(c.post(f"/api/projects/{pid}/models/{mid}/inference/batch", headers=h, json={"subset": "all"}), 201)
    history = ok(c.get(f"/api/projects/{pid}/models/{mid}/inference", headers=h))
    sample = history[:10]
    assert len(sample) == 10 and all(r["has_result"] and r["status"] == "succeeded" for r in sample)
    for record in sample[:5]:
        response = c.get(f"/api/projects/{pid}/inference/{record['id']}/download", headers=h)
        assert response.status_code == 200
        assert len(list(csv.DictReader(io.StringIO(response.text)))) == record["count"]


def test_tc_b06_04_results_twenty_rows_and_nine_images(trained, env):
    c, pid, h = env["c"], env["pid"], headers("pi01")
    rows = (env["synth"] / "tabular" / "cohort_02.csv").read_text().splitlines()[:21]
    out = ok(c.post(f"/api/projects/{pid}/models/{model_id(trained, 'tabular_classification')}/inference/upload",
                    headers=h, files=[("files", ("twenty.csv", "\n".join(rows).encode(), "text/csv"))]), 201)
    table = list(csv.DictReader(io.StringIO(c.get(f"/api/projects/{pid}/inference/{out['id']}/download",
                                                    headers=h).text)))
    assert len(table) == 20
    assert all(r["prediction"] or r["prediction_note"] == "特徵含缺值，無法預測" for r in table)
    dicoms = sorted((env["synth"] / "dicom").rglob("*.dcm"))[:9]
    image = ok(c.post(f"/api/projects/{pid}/models/{model_id(trained, 'image_detection')}/inference/upload",
                      headers=h, files=[("files", (f"{p.parent.parent.name}-{p.name}", p.read_bytes()))
                                        for p in dicoms], timeout=120), 201)
    results = image["result"]["results"]
    assert len(results) == 9 and all(r["preview"].startswith("data:image/png") and "boxes" in r for r in results)


def test_tc_b06_05_model_download_three_times(trained, env):
    c, pid, h = env["c"], env["pid"], headers("pi01")
    mid = model_id(trained, "image_segmentation")
    model = ok(c.get(f"/api/projects/{pid}/models/{mid}", headers=h))
    digests = [hashlib.sha256(c.get(f"/api/projects/{pid}/models/{mid}/download", headers=h).content).hexdigest()
               for _ in range(3)]
    assert digests == [model["sha256"]] * 3


def test_tc_b06_06_online_deployment_authorised_ten_unauthorised_ten(trained, env):
    c, pid = env["c"], env["pid"]
    mark = last_audit_id()
    name = f"b06-{time.time_ns() % 10**9}"
    deployment = ok(c.post(f"/api/projects/{pid}/deployments", headers=headers("pi01"),
                           json={"model_id": model_id(trained, "tabular_classification"), "name": name,
                                 "allowed_users": ["md01"]}), 201)
    rows = [{"age": 50, "bmi": 24.1, "glucose": 101, "sbp": 128}, {"age": 71, "bmi": 30.2, "glucose": 140, "sbp": 150}]
    md = headers("md01")
    good = [c.post(deployment["endpoint"], headers=md, json={"rows": rows}) for _ in range(10)]
    assert [r.status_code for r in good] == [200] * 10 and all(len(r.json()["predictions"]) == 2 for r in good)
    others = [headers(u) for u in ("vw01", "ra01", "user01", "user02", "pi01")]
    bad = [c.post(deployment["endpoint"], headers=h, json={"rows": rows}) for h in others * 2]
    assert [r.status_code for r in bad] == [403] * 10
    assert c.post(deployment["endpoint"], json={"rows": rows}).status_code == 401
    online = audit("inference", "inference.online", mark)
    assert sum(r["result"] == "success" for r in online) == 10
    assert sum(r["result"] == "denied" for r in online) == 10
    assert audit("inference", "deployment.create", mark)
    assert c.delete(f"/api/projects/{pid}/deployments/{deployment['id']}", headers=headers("pi01")).status_code == 204


def test_inference_service_and_mlflow_are_not_reachable_from_the_host():
    import httpx

    for url in ("http://127.0.0.1:5000", "http://127.0.0.1:8000"):
        with pytest.raises(httpx.HTTPError):
            httpx.get(url, timeout=2)
