"""M2 流程程式碼第二階段：資料匯入（import）與部署（deploy）環節的匯出、匯入、鎖定，專案包匯入與資料對應（F-04、F-05、F-11）。"""
import hashlib
import io
import json
import zipfile

import pytest

from app.models import AuditLog, Membership, Project, User
from app.permissions import DEFAULT_ROLE_PERMISSIONS, Role
from app.tabular_api.models import TabularDataset
from app.training.models import Deployment, DeploymentStageOverride, StageOverride, TrainingSetting
from conftest_training import ok, run_container, setting_body


def unzip(data: bytes) -> dict[str, bytes]:
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        return {name: archive.read(name) for name in archive.namelist()}


def rezip(files: dict[str, bytes]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, body in files.items():
            archive.writestr(name, body)
    return buffer.getvalue()


def base(setting, suffix=""):
    return f"/api/projects/{setting['project_id']}/training/settings/{setting['id']}{suffix}"


def make(client, headers, pid, kind="tabular_classification", **kwargs):
    return ok(client.post(f"/api/projects/{pid}/training/settings", headers=headers,
                          json=setting_body(kind, **kwargs)), 201)


def export(client, headers, setting, stage):
    response = client.get(base(setting, f"/stages/{stage}/export"), headers=headers)
    assert response.status_code == 200, response.text
    return unzip(response.content)


def upload(client, headers, setting, stage, files):
    return client.post(base(setting, f"/stages/{stage}/upload"), headers=headers,
                       files={"file": (f"{stage}.zip", rezip(files), "application/zip")})


def current(client, headers, setting):
    return ok(client.get(base(setting), headers=headers))


@pytest.fixture
def tab(client, pi, project, table):
    return make(client, pi, project.id, dataset_id=table)


@pytest.fixture
def other_project(session):
    """另一個專案，pi01 也是計畫主持人（專案包匯入的目標）。"""
    p = Project(name="P2-other", gpu_group="gpu-exclusive")
    session.add(p)
    session.commit()
    user = session.query(User).filter_by(username="pi01").one()
    role = Role.PRINCIPAL_INVESTIGATOR
    session.add(Membership(user_id=user.id, project_id=p.id, role=role.value,
                           permissions=sorted(x.value for x in DEFAULT_ROLE_PERMISSIONS[role])))
    session.commit()
    return p


# ---------------------------------------------------------------- 資料匯入（import）

def test_f04_import_stage_exports_its_config_and_local_program(client, pi, tab, session, store):
    files = export(client, pi, tab, "import")
    assert set(files) == {"stage.json", "import.json", "schema.json", "load_data.py", "README.md"}
    meta = json.loads(files["stage.json"])
    assert meta["stage"] == "import" and meta["kind"] == "tabular_classification"
    body = json.loads(files["import.json"])
    ds = session.get(TabularDataset, tab["config"]["source"]["dataset_id"])
    assert body["source"] == {"type": "tabular", "dataset_id": ds.id}
    assert body["dataset"]["csv_sha256"] == hashlib.sha256(store.get(ds.object_key)).hexdigest()
    assert json.loads(files["schema.json"]) == ds.schema
    compile(files["load_data.py"], "load_data.py", "exec")


def test_f05_import_stage_round_trip_locks_the_dataset_choice(client, pi, tab, project, synth):
    before = current(client, pi, tab)["config"]
    out = ok(upload(client, pi, tab, "import", export(client, pi, tab, "import")))
    assert out["setting"]["config"] == before and out["locked"] == ["import"]
    entry = next(s for s in out["stages"] if s["stage"] == "import")
    assert entry["locked"]["files"].keys() == {"import.json", "schema.json"} and entry["code"] is False
    other = ok(client.post(f"/api/projects/{project.id}/tabular/datasets", headers=pi,
                           data={"schema": (synth / "tabular" / "schema.json").read_text(), "name": "第二份"},
                           files={"file": ("b.csv", (synth / "tabular" / "cohort_01.csv").read_bytes(), "text/csv")}),
               201)["dataset"]["id"]
    changed = json.loads(json.dumps(before))
    changed["source"]["dataset_id"] = other
    response = client.put(base(tab), headers=pi, json={"name": tab["name"], "config": changed})
    assert response.status_code == 409 and "資料匯入" in response.json()["detail"]


def test_import_stage_with_a_new_schema_creates_a_new_dataset(client, pi, tab, session):
    files = export(client, pi, tab, "import")
    schema = json.loads(files["schema.json"])
    column = next(c for c in schema["columns"] if c["name"] == "bmi")
    column["max"] = 30
    out = ok(upload(client, pi, tab, "import", {**files, "schema.json": json.dumps(schema).encode()}))
    old_id = tab["config"]["source"]["dataset_id"]
    new_id = out["setting"]["config"]["source"]["dataset_id"]
    assert new_id != old_id
    new = session.get(TabularDataset, new_id)
    assert new.name.startswith("cohort_01（匯入結構 ") and 0 < new.valid_rows < 100
    assert next(c for c in new.schema["columns"] if c["name"] == "bmi")["max"] == 30
    assert session.get(TabularDataset, old_id).valid_rows == 100, "原資料集不動"
    entry = session.query(AuditLog).filter_by(action="flow.stage_import").order_by(AuditLog.id.desc()).first()
    assert entry.detail["new_dataset_id"] == new_id and entry.detail["from_dataset_id"] == old_id
    out = ok(client.delete(base(tab, "/stages/import"), headers=pi))
    assert out["setting"]["config"]["source"]["dataset_id"] == old_id, "改回介面設定：回到原資料集"


@pytest.mark.parametrize("change,expected", [
    ("all_invalid", "依新的欄位結構，原始檔 100 列都不合格，請檢查 schema.json"),
    ("dataset_id", "「source.dataset_id」不能修改（由平台對應）"),
    ("type", "「source.type」不能修改"),
    ("labels_key", "「label_source」屬於「標註」環節"),
])
def test_import_stage_rejections(change, expected, client, pi, tab, session):
    files = export(client, pi, tab, "import")
    body, schema = json.loads(files["import.json"]), json.loads(files["schema.json"])
    if change == "all_invalid":
        next(c for c in schema["columns"] if c["name"] == "age").update({"min": 500, "max": 600})
    elif change == "dataset_id":
        body["source"]["dataset_id"] += 100
    elif change == "type":
        body["source"]["type"] = "dicom"
    else:
        body["label_source"] = {"provider": "inline"}
    response = upload(client, pi, tab, "import", {**files, "import.json": json.dumps(body).encode(),
                                                  "schema.json": json.dumps(schema).encode()})
    assert response.status_code == 422, response.text
    assert any(expected in e for e in response.json()["detail"]["errors"]), response.json()
    assert session.query(StageOverride).count() == 0 and session.query(TabularDataset).count() == 1


def test_image_import_stage_selects_studies_of_this_project(client, pi, project, images):
    from conftest_training import study_uids

    setting = make(client, pi, project.id, kind="image_classification", synth=images)
    files = export(client, pi, setting, "import")
    assert set(files) == {"stage.json", "import.json", "load_data.py", "README.md"}
    body = json.loads(files["import.json"])
    assert body["source"] == {"type": "dicom", "studies": "all"}
    uids = [s["study_instance_uid"] for s in study_uids(images, range(1, 4)).values()]
    body["source"]["studies"] = uids + ["1.2.3.999"]
    response = upload(client, pi, setting, "import", {**files, "import.json": json.dumps(body).encode()})
    assert "研究不在本專案或不在 Accession 清單內：1.2.3.999" in "\n".join(response.json()["detail"]["errors"])
    body["source"]["studies"] = uids
    out = ok(upload(client, pi, setting, "import", {**files, "import.json": json.dumps(body).encode()}))
    assert out["setting"]["config"]["source"]["studies"] == sorted(uids)
    assert out["setting"]["config"]["source"]["label_source"] == setting["config"]["source"]["label_source"]


def test_import_stage_needs_training_but_not_coding(client, pi, member, tab):
    assistant = member("ra01", Role.RESEARCH_ASSISTANT)
    assert client.get(base(tab, "/stages/import"), headers=assistant).status_code == 200
    ok(upload(client, assistant, tab, "import", export(client, pi, tab, "import")))
    assert client.get(base(tab, "/stages/labels"), headers=assistant).status_code == 403


# ---------------------------------------------------------------- 部署（deploy）

@pytest.fixture
def trained(client, pi, tab, backend, tmp_path, inference):
    run = ok(client.post(base(tab, "/runs"), headers=pi, json={}), 201)
    done = run_container(client, backend, pi, run, tmp_path / "run")
    assert done["status"] == "succeeded", done["message"]
    return done


def deploy_files(client, pi, tab, **deployment):
    files = export(client, pi, tab, "deploy")
    body = json.loads(files["deploy.json"])
    body["deployment"] = {"name": "dm-risk", "title": "糖尿病一年內風險", "allowed_users": ["pi01"]} | deployment
    return files, body


def test_f04_deploy_stage_exports_the_model_by_sha256(client, pi, tab, trained, session):
    files = export(client, pi, tab, "deploy")
    assert set(files) == {"stage.json", "deploy.json", "predict.py", "README.md"}
    body = json.loads(files["deploy.json"])
    model = ok(client.get(f"/api/projects/{tab['project_id']}/models/{trained['model_id']}", headers=pi))
    assert body["model"] == {"run_id": trained["id"], "format": "pkl", "sha256": model["sha256"]}
    assert body["deployment"] is None and body["batch"] == {"subset": "test"}
    assert "http" not in files["deploy.json"].decode(), "不寫平台內部位址"


def test_deploy_stage_creates_a_locked_deployment(client, pi, member, tab, trained, session):
    member("lin")
    files, body = deploy_files(client, pi, tab, allowed_users=["pi01", "lin"])
    out = ok(upload(client, pi, tab, "deploy", {**files, "deploy.json": json.dumps(body).encode()}))
    assert out["locked"] == ["deploy"]
    deployment = session.query(Deployment).filter_by(name="dm-risk").one()
    assert deployment.allowed_users == ["lin", "pi01"] and deployment.model_id == trained["model_id"]
    listed = ok(client.get(f"/api/projects/{tab['project_id']}/deployments", headers=pi))[0]
    assert listed["title"] == "糖尿病一年內風險"
    assert listed["stage_lock"]["setting"] == {"id": tab["id"], "name": tab["name"]}
    response = client.put(f"/api/projects/{tab['project_id']}/deployments/{deployment.id}/access", headers=pi,
                          json={"allowed_users": ["pi01"]})
    assert response.status_code == 409 and "由匯入的 deploy.json 控制" in response.json()["detail"]

    # 再次匯入：更新同名部署的顯示名稱與可呼叫帳號
    body["deployment"] |= {"title": "新的名稱", "allowed_users": ["pi01"]}
    ok(upload(client, pi, tab, "deploy", {**files, "deploy.json": json.dumps(body).encode()}))
    session.expire_all()
    assert session.query(Deployment).filter_by(name="dm-risk").one().allowed_users == ["pi01"]
    assert ok(client.get(f"/api/projects/{tab['project_id']}/deployments", headers=pi))[0]["title"] == "新的名稱"

    # 改回介面設定：解除鎖定，匯入建立的部署保留
    ok(client.delete(base(tab, "/stages/deploy"), headers=pi))
    session.expire_all()
    assert session.query(DeploymentStageOverride).count() == 0
    ok(client.put(f"/api/projects/{tab['project_id']}/deployments/{deployment.id}/access", headers=pi,
                  json={"allowed_users": ["pi01", "lin"]}))


def test_deploy_stage_restores_an_existing_deployment_on_unlock(client, pi, member, tab, trained, session):
    pid = tab["project_id"]
    member("lin")
    created = ok(client.post(f"/api/projects/{pid}/deployments", headers=pi,
                             json={"model_id": trained["model_id"], "name": "dm-risk", "title": "原名稱",
                                   "allowed_users": ["pi01"]}), 201)
    files, body = deploy_files(client, pi, tab, title="匯入的名稱", allowed_users=["lin"])
    ok(upload(client, pi, tab, "deploy", {**files, "deploy.json": json.dumps(body).encode()}))
    assert session.get(Deployment, created["id"]).allowed_users == ["lin"]
    ok(client.delete(base(tab, "/stages/deploy"), headers=pi))
    session.expire_all()
    row = ok(client.get(f"/api/projects/{pid}/deployments", headers=pi))[0]
    assert row["allowed_users"] == ["pi01"] and row["title"] == "原名稱" and row["stage_lock"] is None


@pytest.mark.parametrize("change,expected", [
    ("sha", "本專案沒有 sha256 為 000000000000 的模型，請先匯入或重新訓練"),
    ("member", "以下帳號不是本專案成員：nobody"),
    ("name", "服務名稱（deployment.name）只能用小寫英數字與連字號"),
    ("subset", "batch.subset 必須是 train、validation、test"),
])
def test_deploy_stage_rejections(change, expected, client, pi, tab, trained, session):
    files, body = deploy_files(client, pi, tab)
    if change == "sha":
        body["model"]["sha256"] = "0" * 64
    elif change == "member":
        body["deployment"]["allowed_users"] = ["pi01", "nobody"]
    elif change == "name":
        body["deployment"]["name"] = "DM Risk"
    else:
        body["batch"] = {"subset": "everything"}
    response = upload(client, pi, tab, "deploy", {**files, "deploy.json": json.dumps(body).encode()})
    assert response.status_code == 422 and any(expected in e for e in response.json()["detail"]["errors"]), \
        response.text
    assert session.query(Deployment).count() == 0


def test_deleting_a_locked_deployment_removes_the_lock(client, pi, tab, trained, session, store):
    files, body = deploy_files(client, pi, tab)
    ok(upload(client, pi, tab, "deploy", {**files, "deploy.json": json.dumps(body).encode()}))
    deployment = session.query(Deployment).one()
    key = session.query(StageOverride).filter_by(stage="deploy").one().files_key
    assert client.delete(f"/api/projects/{tab['project_id']}/deployments/{deployment.id}", headers=pi).status_code == 204
    session.expire_all()
    assert session.query(DeploymentStageOverride).count() == 0 and session.query(StageOverride).count() == 0
    assert not store.exists(key)


# ---------------------------------------------------------------- 專案包匯入（F-11）

def package(client, headers, setting, include_data=False):
    response = client.get(base(setting, "/package"), headers=headers, params={"include_data": include_data})
    assert response.status_code == 200, response.text
    return response.content


def package_import(client, headers, pid, data, check=False, **form):
    path = f"/api/projects/{pid}/training/package-import" + ("/check" if check else "")
    return client.post(path, headers=headers, data={k: json.dumps(v) if not isinstance(v, str) else v
                                                     for k, v in form.items()},
                       files={"file": ("flow.zip", data, "application/zip")})


PREPROCESS = '''import pandas
from tabular.fitted import fit_pipeline


def fit_transform(train: pandas.DataFrame, config: dict):
    # 自己改過
    return fit_pipeline(train, config.get("steps") or [])
'''


def test_f11_tabular_package_with_data_runs_in_another_project(client, pi, tab, other_project, backend, tmp_path,
                                                               session):
    view = ok(client.get(base(tab, "/stages/preprocess"), headers=pi))["files"]
    ok(client.put(base(tab, "/stages/preprocess"), headers=pi, json={"files": {**view, "preprocess.py": PREPROCESS}}))
    data = package(client, pi, tab, include_data=True)
    plan = ok(package_import(client, pi, other_project.id, data, check=True))
    assert plan["errors"] == [] and plan["ready"] and plan["mapping"]["mode"] == "package"
    assert plan["name"] == tab["name"] and plan["locked"] == ["preprocess"]
    out = ok(package_import(client, pi, other_project.id, data), 201)
    setting = out["setting"]
    assert setting["project_id"] == other_project.id and out["locked"] == ["preprocess"]
    ds = session.get(TabularDataset, setting["config"]["source"]["dataset_id"])
    assert ds.project_id == other_project.id and ds.name == f"{tab['name']}（專案包資料）" and ds.valid_rows == 100
    exported = {k: v for k, v in current(client, pi, tab)["config"].items() if k != "source"}
    assert {k: v for k, v in setting["config"].items() if k != "source"} == exported, "設定與匯出時差異 0 欄"
    view = ok(client.get(base(setting, "/stages/preprocess"), headers=pi))
    assert view["files"]["preprocess.py"] == PREPROCESS and view["locked"]["code_changed"] is True
    entry = session.query(AuditLog).filter_by(action="flow.package_import", result="success").one()
    assert entry.target == f"training_setting:{setting['id']}" and entry.detail["mapping"]["mode"] == "package"
    run = ok(client.post(base(setting, "/runs"), headers=pi, json={}), 201)
    assert run["executor"] == "source" and run["imported_stages"] == ["preprocess"]
    done = run_container(client, backend, pi, run, tmp_path / "run")
    assert done["status"] == "succeeded", done["message"]
    # 同一個專案再匯入一次：名稱加「（匯入 2）」
    again = ok(package_import(client, pi, other_project.id, data), 201)["setting"]
    assert again["name"] == f"{tab['name']}（匯入 2）"


def test_tabular_package_without_data_maps_by_csv_or_asks(client, pi, tab, project, other_project, synth, session):
    data = package(client, pi, tab)
    plan = ok(package_import(client, pi, project.id, data, check=True))
    assert plan["mapping"]["mode"] == "matched" and plan["mapping"]["dataset_id"] == tab["config"]["source"]["dataset_id"]
    plan = ok(package_import(client, pi, other_project.id, data, check=True))
    assert plan["mapping"]["mode"] == "choose" and not plan["ready"] and plan["mapping"]["candidates"] == []
    response = package_import(client, pi, other_project.id, data)
    assert response.status_code == 409 and "請先選擇要對應的資料" in response.json()["detail"]
    tab_path = synth / "tabular"
    ds = ok(client.post(f"/api/projects/{other_project.id}/tabular/datasets", headers=pi,
                        data={"schema": (tab_path / "schema.json").read_text(), "name": "另一份"},
                        files={"file": ("x.csv", (tab_path / "cohort_01.csv").read_bytes() + b"", "text/csv")}),
            201)["dataset"]["id"]
    out = ok(package_import(client, pi, other_project.id, data, dataset_id=ds), 201)
    assert out["setting"]["config"]["source"]["dataset_id"] == ds and out["mapping"]["mode"] in ("chosen", "matched")


def test_package_rejections(client, pi, tab, other_project, member, session):
    data = package(client, pi, tab, include_data=True)
    files = unzip(data)
    tampered = {**files, "stages/train/train.json": files["stages/train/train.json"].replace(b"20", b"21")}
    response = package_import(client, pi, other_project.id, rezip(tampered))
    assert response.status_code == 422
    assert "stages/train/train.json 的內容與 flow.json 記錄的 sha256 不同" in response.json()["detail"]["errors"][0]
    meta = json.loads(files["flow.json"])
    response = package_import(client, pi, other_project.id, rezip({**files, "flow.json": json.dumps(meta | {"format_version": 2}).encode()}))
    assert "請用 2 版以上的平台匯入" in response.json()["detail"]["errors"][0]
    response = package_import(client, pi, other_project.id, rezip({k: v for k, v in files.items() if k != "flow.json"}))
    assert "這不是平台匯出的專案包" in "\n".join(response.json()["detail"]["errors"])
    bad = {**files, "stages/labels/labels.py": b"import xgboost\n"}
    meta["files"]["stages/labels/labels.py"] = hashlib.sha256(bad["stages/labels/labels.py"]).hexdigest()
    response = package_import(client, pi, other_project.id, rezip({**bad, "flow.json": json.dumps(meta).encode()}))
    errors = "\n".join(response.json()["detail"]["errors"])
    assert "labels.py 第 1 行 import 了平台沒有的套件「xgboost」" in errors and "缺少函式 build_labels" in errors
    assert session.query(TrainingSetting).filter_by(project_id=other_project.id).count() == 0
    failures = session.query(AuditLog).filter_by(action="flow.package_import", result="failure").count()
    assert failures == 4
    assistant = member("ra01", Role.RESEARCH_ASSISTANT)
    assert package_import(client, assistant, tab["project_id"], data).status_code == 403


def test_f11_image_package_maps_to_the_same_data_version(client, pi, project, images, other_project, backend):
    setting = make(client, pi, project.id, kind="image_classification", synth=images)
    run = ok(client.post(base(setting, "/runs"), headers=pi, json={"executor": "fake"}), 201)
    assert run["dataset_version_id"]
    data = package(client, pi, setting)
    files = unzip(data)
    labels = json.loads(files["stages/labels/labels.json"])
    assert set(labels["label_source"]["values"]) == {f"key-{i:04d}" for i in range(1, 21)}, "匯出時已去識別"
    plan = ok(package_import(client, pi, project.id, data, check=True))
    assert plan["mapping"]["mode"] == "version" and plan["ready"]
    out = ok(package_import(client, pi, project.id, data), 201)
    assert out["setting"]["name"] == f"{setting['name']}（匯入 2）"
    assert out["setting"]["config"]["source"] == setting["config"]["source"], "沿用資料版本的資料來源與標註對照"
    rerun = ok(client.post(base(out["setting"], "/runs"), headers=pi, json={"executor": "fake"}), 201)
    assert rerun["dataset_version_id"] == run["dataset_version_id"], "同一份資料版本"

    # 另一個專案沒有這份資料：要選研究；inline 對照表已去識別，要改用其他標註來源
    plan = ok(package_import(client, pi, other_project.id, data, check=True))
    assert plan["mapping"]["mode"] == "choose" and not plan["ready"]
    plan = ok(package_import(client, pi, other_project.id, data, check=True, studies="all"))
    assert any("inline 標註對照表已去識別" in e for e in plan["errors"])
