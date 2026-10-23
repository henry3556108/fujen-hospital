"""M2 流程程式碼（錄製巨集）第一階段：標註、前處理、訓練三個環節的檢視、匯出、編輯後套用、上傳、
不符合框架的拒絕（列出全部錯誤）、鎖定與改回、送出訓練、稽核。"""
import io
import json
import zipfile
from pathlib import Path

import pytest

from app.models import AuditLog
from app.permissions import Role
from app.training import stages
from app.training.models import StageOverride
from conftest_training import ok, run_container, setting_body

TEMPLATES = Path(__file__).resolve().parents[3] / "training" / "trainer" / "templates"


def base(pid, sid, suffix=""):
    return f"/api/projects/{pid}/training/settings/{sid}{suffix}"


def unzip(data: bytes) -> dict[str, bytes]:
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        return {name: archive.read(name) for name in archive.namelist()}


def rezip(files: dict[str, bytes]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, body in files.items():
            archive.writestr(name, body)
    return buffer.getvalue()


def make_setting(client, headers, pid, kind="tabular_classification", **kwargs):
    return ok(client.post(f"/api/projects/{pid}/training/settings", headers=headers,
                          json=setting_body(kind, **kwargs)), 201)


def view(client, headers, setting, stage):
    return ok(client.get(base(setting["project_id"], setting["id"], f"/stages/{stage}"), headers=headers))


def apply(client, headers, setting, stage, files):
    return client.put(base(setting["project_id"], setting["id"], f"/stages/{stage}"), headers=headers,
                      json={"files": files})


def upload(client, headers, setting, stage, data):
    return client.post(base(setting["project_id"], setting["id"], f"/stages/{stage}/upload"), headers=headers,
                       files={"file": (f"{stage}.zip", data, "application/zip")})


def current(client, headers, setting):
    return ok(client.get(base(setting["project_id"], setting["id"]), headers=headers))


def audits(session, action, result=None):
    rows = session.query(AuditLog).filter_by(action=action)
    if result:
        rows = rows.filter_by(result=result)
    return rows.order_by(AuditLog.id).all()


@pytest.fixture
def tab(client, pi, project, table):
    return make_setting(client, pi, project.id, dataset_id=table)


# ---------------------------------------------------------------- 檢視與匯出

def test_overview_lists_the_stages_controlled_by_the_ui(client, pi, tab):
    out = ok(client.get(base(tab["project_id"], tab["id"], "/stages"), headers=pi))
    assert [s["stage"] for s in out["stages"]] == ["import", "labels", "preprocess", "train", "deploy"]
    assert [s["name"] for s in out["stages"]] == ["資料匯入", "標註", "資料清理與前處理", "訓練", "模型匯出與部署"]
    assert [s["code"] for s in out["stages"]] == [False, True, True, True, False]
    assert all(s["locked"] is None for s in out["stages"]) and out["locked"] == [] and out["can_code"]
    assert out["stages"][2]["entrypoints"] == {"fit_transform": ["train", "config"]}
    assert out["stages"][0]["files"] == ["import.json", "schema.json"] and out["stages"][4]["files"] == ["deploy.json"]


def test_view_code_shows_the_stage_config_and_the_platform_program(client, pi, tab):
    labels = view(client, pi, tab, "labels")
    assert json.loads(labels["files"]["labels.json"]) == {"target": "diagnosis",
                                                         "features": ["age", "bmi", "glucose", "sbp"]}
    assert "def build_labels(frame" in labels["files"]["labels.py"]
    pre = json.loads(view(client, pi, tab, "preprocess")["files"]["preprocess.json"])
    assert [s["id"] for s in pre["steps"]] == ["impute_mean", "scale_standard"] and pre["missing"] is None
    train = view(client, pi, tab, "train")
    assert json.loads(train["files"]["train.json"]) == {
        "algorithm": "random_forest", "seed": 42, "split": {"test": 0.2, "train": 0.6, "validation": 0.2},
        "validation": {"method": "holdout"},
        "hyperparameters": {"max_depth": None, "min_samples_leaf": 1, "n_estimators": 20}} | {
        "hyperparameters": json.loads(train["files"]["train.json"])["hyperparameters"]}
    assert train["files"]["train.py"] == (TEMPLATES / "tabular_classification.py").read_text(encoding="utf-8")


@pytest.mark.parametrize("stage", stages.STAGES)
def test_f02_each_stage_exports_config_program_and_descriptor(stage, client, pi, tab, session):
    response = client.get(base(tab["project_id"], tab["id"], f"/stages/{stage}/export"), headers=pi)
    assert response.status_code == 200 and response.headers["content-type"] == "application/zip"
    files = unzip(response.content)
    assert set(files) == {"stage.json", f"{stage}.json", f"{stage}.py", "README.md"}
    meta = json.loads(files["stage.json"])
    assert meta["format_version"] == 1 and meta["stage"] == stage and meta["kind"] == "tabular_classification"
    assert meta["setting"] == {"id": tab["id"], "name": tab["name"]} and meta["exported_by"] == "pi01"
    import hashlib
    assert meta["files"] == {n: hashlib.sha256(files[n]).hexdigest() for n in (f"{stage}.json", f"{stage}.py")}
    compile(files[f"{stage}.py"], f"{stage}.py", "exec")
    entry = audits(session, "flow.stage_export")[-1]
    assert entry.category == "training" and entry.target == f"training_setting:{tab['id']}"
    assert entry.detail["stage"] == stage and entry.detail["sha256"] == hashlib.sha256(response.content).hexdigest()


# ---------------------------------------------------------------- 匯入一致（F-05）與鎖定

@pytest.mark.parametrize("stage", stages.STAGES)
def test_f05_reimport_unchanged_keeps_the_setting_and_locks_the_stage(stage, client, pi, tab, session):
    before = current(client, pi, tab)["config"]
    data = client.get(base(tab["project_id"], tab["id"], f"/stages/{stage}/export"), headers=pi).content
    out = ok(upload(client, pi, tab, stage, data))
    assert out["setting"]["config"] == before, "匯出後不修改直接匯入，設定差異 0 欄"
    locked = next(s for s in out["stages"] if s["stage"] == stage)["locked"]
    assert locked["code_changed"] is False and locked["imported_by"] == "pi01"
    assert set(locked["files"]) == {f"{stage}.json", f"{stage}.py"}
    row = session.query(StageOverride).one()
    assert row.config_before == stages.stage_config(before, stage)
    entry = audits(session, "flow.stage_import")[-1]
    assert entry.result == "success" and entry.detail["via"] == "upload" and entry.detail["code_changed"] is False
    assert {"project_id", "stage", "sha256", "files", "config_before_sha256"} <= set(entry.detail)


@pytest.mark.parametrize("kind", ["image_classification", "image_detection", "image_segmentation",
                                  "tabular_regression"])
def test_f05_other_kinds_round_trip(kind, client, pi, project, table):
    setting = make_setting(client, pi, project.id, kind=kind, dataset_id=table)
    before = setting["config"]
    for stage in stages.STAGES:
        data = client.get(base(project.id, setting["id"], f"/stages/{stage}/export"), headers=pi).content
        assert ok(upload(client, pi, setting, stage, data))["setting"]["config"] == before, stage
    assert len(ok(client.get(base(project.id, setting["id"], "/stages"), headers=pi))["locked"]) == 3


def test_editor_apply_changes_value_and_code_then_locks(client, pi, tab, session):
    train = view(client, pi, tab, "train")["files"]
    config = json.loads(train["train.json"])
    config["hyperparameters"]["n_estimators"] = 7
    code = train["train.py"].replace("def train(", "# 我的修改\ndef train(")
    out = ok(apply(client, pi, tab, "train", {"train.json": json.dumps(config), "train.py": code}))
    assert out["setting"]["config"]["hyperparameters"]["n_estimators"] == 7
    assert out["locked"] == ["train"]
    assert out["can_code"] is True, "套用後的回應也要帶 can_code，網頁才不會把 PI 當成沒有 Coding"
    assert view(client, pi, tab, "train")["files"]["train.py"] == code
    assert session.query(StageOverride).one().code_changed is True
    assert audits(session, "flow.stage_import")[-1].detail["via"] == "editor"


def test_line_ending_and_trailing_space_do_not_count_as_code_change(client, pi, tab, session):
    files = view(client, pi, tab, "labels")["files"]
    code = files["labels.py"].replace("\n", "   \r\n") + "\n\n"
    ok(apply(client, pi, tab, "labels", {"labels.json": files["labels.json"], "labels.py": code}))
    assert session.query(StageOverride).one().code_changed is False


def test_f07_locked_stage_cannot_be_changed_from_the_form(client, pi, tab):
    ok(apply(client, pi, tab, "preprocess", view(client, pi, tab, "preprocess")["files"]))
    listed = ok(client.get(f"/api/projects/{tab['project_id']}/training/settings", headers=pi))
    assert [s["locked_stages"] for s in listed] == [["preprocess"]], "訓練設定清單標示「匯入控制」"
    body = {"name": tab["name"], "config": current(client, pi, tab)["config"]}
    assert client.put(base(tab["project_id"], tab["id"]), headers=pi, json=body).status_code == 200, \
        "同樣的值存檔可以"
    changed = json.loads(json.dumps(body))
    changed["config"]["tabular"]["steps"] = []
    response = client.put(base(tab["project_id"], tab["id"]), headers=pi, json=changed)
    assert response.status_code == 409 and "資料清理與前處理" in response.json()["detail"]
    other = json.loads(json.dumps(body))
    other["config"]["seed"] = 5          # 訓練環節沒有鎖定
    assert ok(client.put(base(tab["project_id"], tab["id"]), headers=pi, json=other))["config"]["seed"] == 5


def test_f08_unlock_restores_the_setting_and_deletes_the_file(client, pi, tab, session, store):
    before = current(client, pi, tab)["config"]
    files = view(client, pi, tab, "labels")["files"]
    ok(apply(client, pi, tab, "labels", {**files, "labels.json": json.dumps(
        {"target": "diagnosis", "features": ["age", "bmi"]})}))
    ok(apply(client, pi, tab, "labels", {**files, "labels.json": json.dumps(
        {"target": "diagnosis", "features": ["age"]})}))
    row = session.query(StageOverride).one()
    assert row.config_before == {"target": "diagnosis", "features": ["age", "bmi", "glucose", "sbp"]}, \
        "再次匯入保留第一次匯入前的設定"
    key, sha = row.files_key, row.sha256
    assert store.exists(key)
    out = ok(client.delete(base(tab["project_id"], tab["id"], "/stages/labels"), headers=pi))
    assert out["setting"]["config"] == before and out["locked"] == []
    assert not store.exists(key)
    session.expire_all()
    assert session.query(StageOverride).count() == 0
    entry = audits(session, "flow.stage_unlock")[-1]
    assert entry.detail["stage"] == "labels" and entry.detail["deleted_sha256"] == sha
    assert client.delete(base(tab["project_id"], tab["id"], "/stages/labels"), headers=pi).status_code == 409


# ---------------------------------------------------------------- 不符合框架（F-06）

def stage_zip(client, headers, setting, stage, **changes):
    files = unzip(client.get(base(setting["project_id"], setting["id"], f"/stages/{stage}/export"),
                             headers=headers).content)
    return {**files, **{k: (v.encode() if isinstance(v, str) else v) for k, v in changes.items()}}


@pytest.mark.parametrize("case,expected", [
    ("wrong_stage", "這個檔案是「訓練」環節，請到「訓練」匯入"),
    ("missing_entrypoint", "labels.py 缺少函式 build_labels(frame, config)"),
    ("out_of_range", "labels.json："),
    ("unsupported_package", "labels.py 第 1 行 import 了平台沒有的套件「xgboost」"),
    ("syntax_error", "labels.py 第 2 行語法錯誤"),
])
def test_f06_files_that_do_not_fit_the_framework_are_rejected(case, expected, client, pi, tab, session):
    if case == "wrong_stage":
        data = rezip(stage_zip(client, pi, tab, "train"))
    elif case == "missing_entrypoint":
        data = rezip(stage_zip(client, pi, tab, "labels", **{"labels.py": "def labels(frame, config):\n    return frame\n"}))
    elif case == "out_of_range":
        data = rezip(stage_zip(client, pi, tab, "labels", **{"labels.json": '{"target": "diagnosis", "features": []}'}))
    elif case == "unsupported_package":
        data = rezip(stage_zip(client, pi, tab, "labels", **{"labels.py": "import xgboost\n\ndef build_labels(frame, config):\n    return frame\n"}))
    else:
        data = rezip(stage_zip(client, pi, tab, "labels", **{"labels.py": "def build_labels(frame, config):\nreturn frame\n"}))
    response = upload(client, pi, tab, "labels", data)
    assert response.status_code == 422, response.text
    detail = response.json()["detail"]
    assert detail["code"] == "stage_invalid" and any(expected in e for e in detail["errors"]), detail
    assert session.query(StageOverride).count() == 0
    failure = audits(session, "flow.stage_import", "failure")[-1]
    assert failure.detail["stage"] == "labels" and failure.detail["errors"] == detail["errors"]


def test_all_errors_are_listed_at_once(client, pi, tab):
    train = view(client, pi, tab, "train")["files"]
    config = {"split": {"train": 0.9, "validation": 0.5, "test": 0.1}, "seed": -1, "algorithm": "random_forest",
              "validation": {"method": "kfold", "folds": 50}, "hyperparameters": {"n_estimators": 0},
              "steps": [], "colour": "red"}
    code = "import requests\nimport torch\n\ndef train(config, data_dir):\n    pass\n"
    response = apply(client, pi, tab, "train", {"train.json": json.dumps(config), "train.py": code})
    errors = response.json()["detail"]["errors"]
    joined = "\n".join(errors)
    for part in ("「steps」屬於「資料清理與前處理」環節", "不支援的設定「colour」", "比例總和必須等於 1", "亂數種子",
                 "交叉驗證折數", "樹的數量", "「requests」", "「torch」", "train 的參數必須是 (config, data_dir, out_dir)",
                 "runtime.main(train)"):
        assert part in joined, (part, errors)
    assert len(errors) >= 10 and train  # 一次列出，使用者改一次就能再匯入


def test_tabular_merge_check_uses_the_dataset(client, pi, tab):
    files = view(client, pi, tab, "preprocess")["files"]
    steps = [{"id": "select_columns", "columns": ["age", "bmi", "glucose", "diagnosis"]}]
    response = apply(client, pi, tab, "preprocess", {**files, "preprocess.json": json.dumps({"steps": steps})})
    assert response.status_code == 422
    assert "與其他環節合併後" in response.json()["detail"]["errors"][0] and "sbp" in response.json()["detail"]["errors"][0]


def test_other_stage_flagged_after_unlock_and_submit_blocked(client, pi, tab, backend):
    labels = view(client, pi, tab, "labels")["files"]
    ok(apply(client, pi, tab, "labels", {**labels, "labels.json": json.dumps(
        {"target": "diagnosis", "features": ["age", "bmi", "glucose"]})}))
    pre = view(client, pi, tab, "preprocess")["files"]
    ok(apply(client, pi, tab, "preprocess", {**pre, "preprocess.json": json.dumps(
        {"steps": [{"id": "select_columns", "columns": ["age", "bmi", "glucose", "diagnosis"]}]})}))
    out = ok(client.delete(base(tab["project_id"], tab["id"], "/stages/labels"), headers=pi))
    assert out["problem"] and "sbp" in out["problem"]
    assert next(s for s in out["stages"] if s["stage"] == "preprocess")["problem"]
    response = client.post(base(tab["project_id"], tab["id"], "/runs"), headers=pi, json={"executor": "fake"})
    assert response.status_code == 409 and "需要處理" in response.json()["detail"]


def test_malware_in_pasted_code_is_blocked(app, client, pi, tab, session):
    from app.scanning import FakeScanner, eicar

    app.state.scanner = FakeScanner()
    files = view(client, pi, tab, "labels")["files"]
    response = apply(client, pi, tab, "labels", {**files, "labels.py": files["labels.py"] + "# " + eicar().decode()})
    assert response.status_code == 422 and response.json()["detail"]["code"] == "malware_detected"
    assert session.query(StageOverride).count() == 0


def test_image_rules(client, pi, project):
    setting = make_setting(client, pi, project.id, kind="image_classification")
    labels = view(client, pi, setting, "labels")["files"]
    assert json.loads(labels["labels.json"])["label_source"]["provider"] == "inline"
    response = apply(client, pi, setting, "labels", {**labels, "labels.json": json.dumps(
        {"labels": ["CT"], "label_source": {"provider": "annotations"}})})
    assert "影像分類至少需要 2 種 Label" in "\n".join(response.json()["detail"]["errors"])
    pre = view(client, pi, setting, "preprocess")["files"]
    code = pre["preprocess.py"].replace("return imagekit.prepare_image(image, size)",
                                        "return imagekit.prepare_image(image, size) * 2")
    response = apply(client, pi, setting, "preprocess", {**pre, "preprocess.py": code})
    assert any("prepare_image 不能修改" in e for e in response.json()["detail"]["errors"])
    custom = pre["preprocess.py"].replace("return imagekit.augment_samples(", "return list(samples) or imagekit.augment_samples(")
    ok(apply(client, pi, setting, "preprocess", {**pre, "preprocess.py": custom}))
    config = json.loads(pre["preprocess.json"])
    config["augmentation"]["rotation_range"] = 400
    response = apply(client, pi, setting, "preprocess", {**pre, "preprocess.json": json.dumps(config)})
    assert any("旋轉角度範圍" in e for e in response.json()["detail"]["errors"])


def test_format_version_and_kind_mismatch(client, pi, project, tab):
    files = stage_zip(client, pi, tab, "labels")
    meta = json.loads(files["stage.json"])
    response = upload(client, pi, tab, "labels", rezip({**files, "stage.json": json.dumps(meta | {"format_version": 2})}))
    assert "不支援的格式版本 2（平台支援 1），請用新版的平台匯入" in response.json()["detail"]["errors"][0]
    response = upload(client, pi, tab, "labels", rezip({k: v for k, v in files.items() if k != "stage.json"}))
    assert "缺少 stage.json" in response.json()["detail"]["errors"][0]
    other = make_setting(client, pi, project.id, kind="tabular_regression", name="迴歸", dataset_id=tab["config"]["source"]["dataset_id"])
    response = upload(client, pi, other, "labels", rezip(files))
    assert "檔案的訓練種類是「結構式分類」，這份訓練設定是「結構式迴歸」" in response.json()["detail"]["errors"][0]


# ---------------------------------------------------------------- 權限

def test_permissions(client, pi, member, tab):
    assistant, coder = member("ra01", Role.RESEARCH_ASSISTANT), member("ca01", Role.CODER_ASSISTANT)
    files = view(client, pi, tab, "labels")["files"]
    assert client.get(base(tab["project_id"], tab["id"], "/stages"), headers=assistant).status_code == 200
    assert not ok(client.get(base(tab["project_id"], tab["id"], "/stages"), headers=assistant))["can_code"]
    for path in ("/stages/labels", "/stages/labels/export", "/package"):
        assert client.get(base(tab["project_id"], tab["id"], path), headers=assistant).status_code == 403, path
    assert apply(client, assistant, tab, "labels", files).status_code == 403
    ok(apply(client, coder, tab, "labels", files))
    assert client.delete(base(tab["project_id"], tab["id"], "/stages/labels"), headers=assistant).status_code == 200


def test_delete_setting_removes_imported_files(client, pi, tab, session, store):
    ok(apply(client, pi, tab, "labels", view(client, pi, tab, "labels")["files"]))
    key = session.query(StageOverride).one().files_key
    assert client.delete(base(tab["project_id"], tab["id"]), headers=pi).status_code == 204
    assert not store.exists(key)


# ---------------------------------------------------------------- 送出訓練（F-03）

LABELS_CODE = '''import pandas


def build_labels(frame: pandas.DataFrame, config: dict) -> pandas.DataFrame:
    frame = frame[frame["age"] >= 20]
    frame["high_glucose"] = (frame["glucose"].fillna(0) >= 110).astype(int)
    return frame
'''

PREPROCESS_CODE = '''import pandas
from tabular.fitted import fit_pipeline


def fit_transform(train: pandas.DataFrame, config: dict):
    fitted, out = fit_pipeline(train, config.get("steps") or [])
    return fitted, out
'''


def test_f03_modified_stages_run_on_the_platform(client, pi, tab, backend, tmp_path, session):
    pid, sid = tab["project_id"], tab["id"]
    labels = view(client, pi, tab, "labels")["files"]
    ok(apply(client, pi, tab, "labels", {"labels.json": json.dumps(
        {"target": "high_glucose", "features": ["age", "bmi", "sbp"]}), "labels.py": LABELS_CODE}))
    ok(apply(client, pi, tab, "preprocess", {**view(client, pi, tab, "preprocess")["files"],
                                             "preprocess.py": PREPROCESS_CODE}))
    train = json.loads(view(client, pi, tab, "train")["files"]["train.json"])
    train["hyperparameters"]["n_estimators"] = 9
    ok(apply(client, pi, tab, "train", {"train.json": json.dumps(train),
                                        "train.py": view(client, pi, tab, "train")["files"]["train.py"]}))
    assert labels
    run = ok(client.post(base(pid, sid, "/runs"), headers=pi, json={"executor": "template"}), 201)
    assert run["executor"] == "source" and run["custom_source"]
    assert run["imported_stages"] == ["labels", "preprocess", "train"]
    assert run["config"]["tabular"]["target"] == "high_glucose"
    assert run["config"]["hyperparameters"]["n_estimators"] == 9, "訓練紀錄的設定與匯入檔差異 0 欄"
    submit = audits(session, "training.submit")[-1]
    assert set(submit.detail["stages"]) == {"labels", "preprocess", "train"}
    done = run_container(client, backend, pi, run, tmp_path / "run")
    assert done["status"] == "succeeded", done["message"]
    model = ok(client.get(f"/api/projects/{pid}/models/{done['model_id']}", headers=pi))
    assert model["card"]["target"] == "high_glucose" and model["card"]["deployable"] is True
    assert done["metrics"]["data"]["total"] < 100 * 1 + 1


def test_only_parameter_changes_use_the_platform_template(client, pi, tab, backend, tmp_path):
    train = view(client, pi, tab, "train")["files"]
    config = json.loads(train["train.json"])
    config["seed"] = 3
    ok(apply(client, pi, tab, "train", {**train, "train.json": json.dumps(config)}))
    run = ok(client.post(base(tab["project_id"], tab["id"], "/runs"), headers=pi, json={"executor": "template"}), 201)
    assert run["executor"] == "template" and not run["custom_source"] and run["imported_stages"] == ["train"]
    assert run["seed"] == 3
    assert run_container(client, backend, pi, run, tmp_path / "run")["status"] == "succeeded"


def test_labels_code_that_breaks_the_rules_fails_the_run(client, pi, tab, backend, tmp_path):
    code = LABELS_CODE.replace('frame["high_glucose"] =', 'frame["age"] = 1\n    frame["high_glucose"] =')
    ok(apply(client, pi, tab, "labels", {"labels.json": json.dumps(
        {"target": "high_glucose", "features": ["age", "bmi", "sbp"]}), "labels.py": code}))
    run = ok(client.post(base(tab["project_id"], tab["id"], "/runs"), headers=pi, json={}), 201)
    done = run_container(client, backend, pi, run, tmp_path / "run")
    assert done["status"] == "failed" and "labels.py 改動了特徵欄位「age」" in done["message"]


CUSTOM_PREPROCESS = '''import pandas


class Scale:
    def __init__(self, columns):
        self.columns = columns

    def transform(self, frame):
        out = frame.copy()
        for c in self.columns:
            out[c] = out[c] / 100.0
        return out


def fit_transform(train: pandas.DataFrame, config: dict):
    scaler = Scale(["age", "bmi"])
    return scaler, scaler.transform(train)
'''


def test_custom_preprocess_model_cannot_be_deployed(client, pi, tab, backend, tmp_path, inference):
    ok(apply(client, pi, tab, "preprocess", {**view(client, pi, tab, "preprocess")["files"],
                                             "preprocess.py": CUSTOM_PREPROCESS}))
    run = ok(client.post(base(tab["project_id"], tab["id"], "/runs"), headers=pi, json={}), 201)
    done = run_container(client, backend, pi, run, tmp_path / "run")
    assert done["status"] == "succeeded", done["message"]
    pid = tab["project_id"]
    model = ok(client.get(f"/api/projects/{pid}/models/{done['model_id']}", headers=pi))
    assert model["card"]["custom_preprocess"] is True and model["card"]["deployable"] is False
    assert "preprocess.Scale" in model["card"]["deploy_blocked"]
    response = client.post(f"/api/projects/{pid}/deployments", headers=pi, json={"model_id": model["id"]})
    assert response.status_code == 409 and "不能在平台推論或部署" in response.json()["detail"]
    response = client.post(f"/api/projects/{pid}/models/{model['id']}/inference/upload", headers=pi,
                           files=[("files", ("x.csv", b"age,bmi\n50,20\n", "text/csv"))])
    assert response.status_code == 409
    response = client.post(f"/api/projects/{pid}/models/{model['id']}/inference/batch", headers=pi, json={})
    assert response.status_code == 409
    download = client.get(f"/api/projects/{pid}/models/{model['id']}/download", headers=pi)
    assert download.status_code == 200, "可以下載在平台外使用"


def test_imported_code_runs_have_a_time_limit(client, pi, tab, backend):
    from conftest_training import job_env

    ok(apply(client, pi, tab, "preprocess", {**view(client, pi, tab, "preprocess")["files"],
                                             "preprocess.py": PREPROCESS_CODE}))
    run = ok(client.post(base(tab["project_id"], tab["id"], "/runs"), headers=pi, json={}), 201)
    assert job_env(backend, run)["JOB_TIMEOUT_SECONDS"] == str(6 * 3600)
    plain = make_setting(client, pi, tab["project_id"], name="plain", dataset_id=tab["config"]["source"]["dataset_id"])
    run = ok(client.post(base(tab["project_id"], plain["id"], "/runs"), headers=pi, json={}), 201)
    assert "JOB_TIMEOUT_SECONDS" not in job_env(backend, run), "平台範本的訓練不變"
