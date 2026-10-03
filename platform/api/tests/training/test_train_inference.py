"""模型與推論：TC-B06-01～06。上傳與線上推論的推論後端用記憶體假實作；批次推論以 trainer.batch 進入點模擬 Job
（非同步行為另見 test_train_batch.py）。推論服務本身另在 platform/training 測試。"""
import csv
import hashlib
import io
import json

import pytest

from app.models import AuditLog
from app.permissions import Role
from app.training import config as cfg
from conftest_training import batch, finish, ok, run_batch, setting_body, start


def models(pid):
    return f"/api/projects/{pid}/models"


@pytest.fixture
def tabular_model(client, pi, project, backend, inference, table, tmp_path):
    run = finish(client, backend, pi, start(client, pi, project.id,
                                            setting_body("tabular_classification", dataset_id=table)), tmp_path)
    return ok(client.get(f"{models(project.id)}/{run['model_id']}", headers=pi))


@pytest.fixture
def image_model(client, pi, project, backend, inference, images, tmp_path):
    run = finish(client, backend, pi, start(client, pi, project.id,
                                            setting_body("image_classification", synth=images)), tmp_path)
    return ok(client.get(f"{models(project.id)}/{run['model_id']}", headers=pi))


def rows_of(data: bytes) -> list[dict]:
    return list(csv.DictReader(io.StringIO(data.decode())))


def test_tc_b06_01_batch_inference_on_test_split(client, pi, project, backend, tabular_model, session, tmp_path):
    """批次推論 20 筆以上：測試切分 20 筆，全部成功，自動新增預測欄。"""
    queued = batch(client, pi, project.id, tabular_model["id"], "test")
    assert queued["status"] == "queued" and queued["count"] == 20
    out = run_batch(client, backend, pi, queued, tmp_path / "test")
    assert out["status"] == "succeeded" and out["count"] == 20 and out["mode"] == "batch"
    result = out["result"]
    assert result["prediction_column"] == "prediction" and result["columns"][-3:] == ["prediction", "prediction_probability", "prediction_note"]
    # 送進模型的輸入不含答案（見 test_train_batch 的 input.csv）；結果把實際值放回原位置，方便對照預測對不對
    assert result["columns"].index("diagnosis") < result["columns"].index("prediction")
    assert all(r[-2] != "" or r[-1] for r in result["rows"])
    everything = run_batch(client, backend, pi, batch(client, pi, project.id, tabular_model["id"], "all"),
                           tmp_path / "all")
    assert everything["count"] == 100
    audit = session.query(AuditLog).filter_by(category="inference", action="inference.batch").all()
    assert len(audit) == 2 and audit[0].detail["count"] == 20


def test_tc_b06_02_upload_inference_ten_times(client, pi, project, tabular_model, image_model, synth):
    tab_csv = (synth / "tabular" / "cohort_02.csv").read_bytes()
    dicoms = sorted((synth / "dicom").rglob("*.dcm"))
    for i in range(10):
        if i % 2 == 0:
            out = ok(client.post(f"{models(project.id)}/{tabular_model['id']}/inference/upload", headers=pi,
                                 files=[("files", ("cohort_02.csv", tab_csv, "text/csv"))]), 201)
            assert out["count"] == 100
        else:
            out = ok(client.post(f"{models(project.id)}/{image_model['id']}/inference/upload", headers=pi,
                                 files=[("files", (p.name, p.read_bytes())) for p in dicoms[i:i + 3]]), 201)
            assert out["count"] == 3 and {r["label"] for r in out["result"]["results"]} <= {"CT", "MR"}
        assert out["status"] == "succeeded" and out["mode"] == "upload"


def test_tc_b06_03_history_and_download(client, pi, project, backend, tabular_model, tmp_path):
    ids = []
    for n, subset in enumerate(("test", "validation", "train", "all", "test") + ("test",) * 5):
        record = batch(client, pi, project.id, tabular_model["id"], subset)
        assert run_batch(client, backend, pi, record, tmp_path / str(n))["status"] == "succeeded"
        ids.append(record["id"])
    history = ok(client.get(f"{models(project.id)}/{tabular_model['id']}/inference", headers=pi))
    assert [h["id"] for h in history] == sorted(ids, reverse=True), "10 筆全在，最新的在前"
    assert all(h["has_result"] and h["user"] == "pi01" for h in history)
    for record_id in ids[:5]:
        response = client.get(f"/api/projects/{project.id}/inference/{record_id}/download", headers=pi)
        assert response.status_code == 200 and response.headers["content-type"].startswith("text/csv")
        assert f"inference-{record_id}.csv" in response.headers["content-disposition"]
        view = ok(client.get(f"/api/projects/{project.id}/inference/{record_id}", headers=pi))
        assert len(rows_of(response.content)) == view["count"] == len(view["result"]["rows"])


def test_tc_b06_04_tabular_adds_prediction_column_for_every_row(client, pi, project, tabular_model, synth):
    """結構式 20 筆自動新增預測欄，缺漏 0：原始欄位不變，每一列都有預測或說明。"""
    source = rows_of((synth / "tabular" / "cohort_03.csv").read_bytes())[:20]
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=list(source[0]))
    writer.writeheader()
    writer.writerows(source)
    out = ok(client.post(f"{models(project.id)}/{tabular_model['id']}/inference/upload", headers=pi,
                         files=[("files", ("twenty.csv", buffer.getvalue().encode(), "text/csv"))]), 201)
    result = rows_of(client.get(f"/api/projects/{project.id}/inference/{out['id']}/download", headers=pi).content)
    assert len(result) == 20
    for before, after in zip(source, result):
        assert {k: after[k] for k in before} == before
        assert after["prediction"] != "" or after["prediction_note"] == "特徵含缺值，無法預測"
    assert sum(1 for r in result if r["prediction"] != "") >= 18


def test_tc_b06_04_nine_images_each_show_a_result(client, pi, project, image_model, images):
    files = sorted((images / "dicom").rglob("*.dcm"))[:9]
    out = ok(client.post(f"{models(project.id)}/{image_model['id']}/inference/upload", headers=pi,
                         files=[("files", (f"{p.parent.parent.name}-{p.name}", p.read_bytes())) for p in files]), 201)
    results = out["result"]["results"]
    assert len(results) == 9 and len({r["name"] for r in results}) == 9
    for r in results:
        assert r["label"] in ("CT", "MR") and set(r["scores"]) == {"CT", "MR"} and r["preview"]


def test_tc_b06_05_download_model_three_times(client, pi, project, tabular_model, session):
    hashes = set()
    for _ in range(3):
        response = client.get(f"{models(project.id)}/{tabular_model['id']}/download", headers=pi)
        assert response.status_code == 200
        assert tabular_model["filename"] in response.headers["content-disposition"]
        hashes.add(hashlib.sha256(response.content).hexdigest())
        assert response.headers["x-content-sha256"] == tabular_model["sha256"]
    assert hashes == {tabular_model["sha256"]}
    assert len(session.query(AuditLog).filter_by(action="model.download").all()) == 3


def test_tc_b06_06_online_deployment_authorisation(client, pi, member, admin, project, tabular_model, synth,
                                                   add_user, session):
    """授權帳號經 API 呼叫 10 次成功 100%；未授權 10 次成功 0；有「推論服務」類稽核。"""
    allowed, other = member("md01", Role.MEDICAL_DOCTOR), member("vw01", Role.VIEWER)
    outsider = add_user("user01")[1]
    created = ok(client.post(f"/api/projects/{project.id}/deployments", headers=pi,
                             json={"model_id": tabular_model["id"], "name": "diagnosis-rf",
                                   "allowed_users": ["md01"]}), 201)
    assert created["endpoint"] == "/api/inference/diagnosis-rf/predict"
    rows = rows_of((synth / "tabular" / "cohort_02.csv").read_bytes())[:3]
    for row in rows:
        row.pop("diagnosis")
    for _ in range(10):
        out = ok(client.post(created["endpoint"], headers=allowed, json={"rows": rows}))
        assert len(out["predictions"]) == 3 and out["deployment"] == "diagnosis-rf"
    denied = [client.post(created["endpoint"], headers=h, json={"rows": rows}).status_code
              for h in [other, outsider, pi, admin, {}] * 2]
    assert denied.count(200) == 0 and set(denied) == {401, 403}
    assert client.post("/api/inference/no-such-thing/predict", headers=allowed, json={"rows": rows}).status_code == 403

    audit = session.query(AuditLog).filter_by(category="inference", action="inference.online").all()
    assert sum(a.result == "success" for a in audit) == 10
    assert sum(a.result == "denied" for a in audit) == 9, "4 個有登入的帳號各 2 次，加上不存在的部署 1 次"
    history = ok(client.get(f"{models(project.id)}/{tabular_model['id']}/inference", headers=pi))
    assert sum(h["mode"] == "online" for h in history) == 10

    # 改授權立即生效
    ok(client.put(f"/api/projects/{project.id}/deployments/{created['id']}/access", headers=pi,
                  json={"allowed_users": ["vw01"]}))
    assert client.post(created["endpoint"], headers=allowed, json={"rows": rows}).status_code == 403
    assert client.post(created["endpoint"], headers=other, json={"rows": rows}).status_code == 200
    assert client.delete(f"/api/projects/{project.id}/deployments/{created['id']}", headers=pi).status_code == 204
    assert client.post(created["endpoint"], headers=other, json={"rows": rows}).status_code == 403
    actions = {a.action for a in session.query(AuditLog).filter_by(category="inference")}
    assert {"deployment.create", "deployment.access", "deployment.delete"} <= actions


def test_deployment_validation(client, pi, project, tabular_model):
    base = f"/api/projects/{project.id}/deployments"
    for body, status in [({"name": "Bad Name"}, 422), ({"name": "ok-name", "allowed_users": ["ghost"]}, 422)]:
        assert client.post(base, headers=pi, json={"model_id": tabular_model["id"], **body}).status_code == status
    ok(client.post(base, headers=pi, json={"model_id": tabular_model["id"], "name": "dup"}), 201)
    assert client.post(base, headers=pi, json={"model_id": tabular_model["id"], "name": "dup"}).status_code == 409
    assert client.post(base, headers=pi, json={"model_id": 999, "name": "x1"}).status_code == 404


def test_inference_service_down_or_bad_input_is_recorded(client, pi, project, backend, tabular_model, inference,
                                                         session, synth, tmp_path):
    inference.available = False
    csv_file = [("files", ("c.csv", (synth / "tabular" / "cohort_02.csv").read_bytes(), "text/csv"))]
    response = client.post(f"{models(project.id)}/{tabular_model['id']}/inference/upload", headers=pi, files=csv_file)
    assert response.status_code == 503 and "推論服務" in response.json()["detail"]
    # 批次推論不經過推論服務：服務故障時照常完成
    done = run_batch(client, backend, pi, batch(client, pi, project.id, tabular_model["id"]), tmp_path / "job")
    assert done["status"] == "succeeded"
    inference.available = True
    response = client.post(f"{models(project.id)}/{tabular_model['id']}/inference/upload", headers=pi,
                           files=[("files", ("x.csv", b"foo,bar\n1,2\n", "text/csv"))])
    assert response.status_code == 422 and "缺少特徵欄位" in response.json()["detail"]
    history = ok(client.get(f"{models(project.id)}/{tabular_model['id']}/inference", headers=pi))
    assert [h["status"] for h in history] == ["failed", "succeeded", "failed"] and not history[0]["has_result"]
    assert client.get(f"/api/projects/{project.id}/inference/{history[0]['id']}/download",
                      headers=pi).status_code == 404
    failures = session.query(AuditLog).filter_by(category="inference", result="failure").all()
    assert len(failures) == 2


def test_inference_service_restart_reloads_the_model(client, pi, project, tabular_model, inference, synth):
    csv_file = [("files", ("c.csv", (synth / "tabular" / "cohort_02.csv").read_bytes(), "text/csv"))]
    upload = f"{models(project.id)}/{tabular_model['id']}/inference/upload"
    ok(client.post(upload, headers=pi, files=csv_file), 201)
    inference.models.clear()                      # 推論服務重啟，忘記模型
    ok(client.post(upload, headers=pi, files=csv_file), 201)
    assert [c for c in inference.calls if c[0] == "load"] == [("load", tabular_model["id"])] * 2


def test_permissions_for_models_and_inference(client, pi, member, project, tabular_model, add_user):
    viewer, assistant, outsider = member("vw01", Role.VIEWER), member("ca01", Role.CODER_ASSISTANT), \
        add_user("user01")[1]
    mid = tabular_model["id"]
    # Viewer 有 prediction：可以看模型、推論、看歷史；不能下載模型、不能部署
    assert client.get(f"{models(project.id)}/{mid}", headers=viewer).status_code == 200
    assert client.post(f"{models(project.id)}/{mid}/inference/batch", headers=viewer, json={}).status_code == 202
    assert client.get(f"{models(project.id)}/{mid}/download", headers=viewer).status_code == 403
    assert client.post(f"/api/projects/{project.id}/deployments", headers=viewer,
                       json={"model_id": mid, "name": "v"}).status_code == 403
    assert client.get(f"{models(project.id)}/{mid}/download", headers=assistant).status_code == 200
    for path in (f"{models(project.id)}", f"{models(project.id)}/{mid}/inference"):
        assert client.get(path, headers=outsider).status_code == 403


# ---------------------------------------------------------------- 使用性測試第二輪：分享給同事使用

def test_shared_model_is_found_and_used_by_a_colleague_with_prediction(client, pi, member, project, tabular_model,
                                                                        synth, add_user):
    """分享（部署）時不必填技術名稱：顯示名稱預設模型名稱（可用中文），技術名稱自動產生。
    專案內有 Prediction 權限的 md01 登入後，在推論服務管理的模型清單看得到這個模型（標示誰分享給他），並可預測。"""
    md01 = member("md01", Role.MEDICAL_DOCTOR)
    add_user("user01")
    base = f"/api/projects/{project.id}/deployments"
    shared = ok(client.post(base, headers=pi, json={"model_id": tabular_model["id"], "title": "心臟科確診預測",
                                                    "allowed_users": ["md01", "user01"]}), 201)
    assert shared["name"] == f"model-{tabular_model['id']}" and shared["title"] == "心臟科確診預測"
    assert shared["endpoint"] == f"/api/inference/model-{tabular_model['id']}/predict"
    assert shared["cannot_use_in_platform"] == ["user01"], "不是專案成員的帳號看不到推論服務管理的模型"
    second = ok(client.post(base, headers=pi, json={"model_id": tabular_model["id"], "allowed_users": []}), 201)
    assert second["name"] == f"model-{tabular_model['id']}-2" and second["title"] == tabular_model["name"]
    assert [d["title"] for d in ok(client.get(base, headers=pi))] == ["心臟科確診預測", tabular_model["name"]]

    listed = ok(client.get(models(project.id), headers=md01))
    mine = next(m for m in listed if m["id"] == tabular_model["id"])
    assert mine["shared_with_me"] is True and mine["shared_by"] == "pi01"
    csv_file = [("files", ("c.csv", (synth / "tabular" / "cohort_02.csv").read_bytes(), "text/csv"))]
    out = ok(client.post(f"{models(project.id)}/{tabular_model['id']}/inference/upload", headers=md01,
                         files=csv_file), 201)
    assert out["status"] == "succeeded" and out["user"] == "md01"
    assert ok(client.get(models(project.id), headers=pi))[0]["shared_with_me"] is False


def test_display_name_is_limited_and_explicit_technical_names_still_work(client, pi, project, tabular_model):
    base = f"/api/projects/{project.id}/deployments"
    response = client.post(base, headers=pi, json={"model_id": tabular_model["id"], "title": "x" * 129})
    assert response.status_code == 422 and "顯示名稱" in response.json()["detail"]
    named = ok(client.post(base, headers=pi, json={"model_id": tabular_model["id"], "name": "diagnosis-rf"}), 201)
    assert named["name"] == "diagnosis-rf" and named["title"] == tabular_model["name"]


# ---------------------------------------------------------------- 使用性測試第三輪：顯示名稱用在所有地方

def test_models_carry_the_display_name_and_pick_one_when_shared_several_times(client, pi, member, project,
                                                                              tabular_model, backend, tmp_path):
    """一個模型分享多次（多個顯示名稱）時：優先用分享給目前使用者的最新一次，否則用最新一次；沒分享過為 null。"""
    md01 = member("md01", Role.MEDICAL_DOCTOR)
    base = f"/api/projects/{project.id}/deployments"
    assert ok(client.get(f"{models(project.id)}/{tabular_model['id']}", headers=pi))["title"] is None
    ok(client.post(base, headers=pi, json={"model_id": tabular_model["id"], "title": "心臟科確診預測（測試）",
                                           "allowed_users": ["md01"]}), 201)
    ok(client.post(base, headers=pi, json={"model_id": tabular_model["id"], "title": "給資訊室的版本",
                                           "allowed_users": ["pi01"]}), 201)

    def title(headers):
        listed = next(m for m in ok(client.get(models(project.id), headers=headers)) if m["id"] == tabular_model["id"])
        single = ok(client.get(f"{models(project.id)}/{tabular_model['id']}", headers=headers))
        assert listed["title"] == single["title"]
        return listed["title"]

    assert title(md01) == "心臟科確診預測（測試）", "md01 看到分享給他的名稱"
    assert title(pi) == "給資訊室的版本"
    report = client.get(f"/api/projects/{project.id}/training/runs/{tabular_model['run_id']}/report", headers=pi).text
    assert "訓練報表：給資訊室的版本" in report and f"模型名稱：{tabular_model['name']}" in report


def test_single_try_out_is_recorded_as_such_and_audited_as_an_upload(client, pi, project, tabular_model, session):
    """網頁的「單人試用」以 source=try 送出：紀錄的 input.source 為 try（歷史顯示「單人試用」），mode 與稽核照舊是 upload。"""
    one = "age,bmi,glucose,sbp\n60,25,100,130\n".encode()
    url = f"{models(project.id)}/{tabular_model['id']}/inference/upload"
    out = ok(client.post(url, headers=pi, files=[("files", ("try.csv", one, "text/csv"))], data={"source": "try"}), 201)
    assert out["mode"] == "upload" and out["input"]["source"] == "try" and out["count"] == 1
    plain = ok(client.post(url, headers=pi, files=[("files", ("a.csv", one, "text/csv"))]), 201)
    assert "source" not in plain["input"]
    history = ok(client.get(f"{models(project.id)}/{tabular_model['id']}/inference", headers=pi))
    assert [h["input"].get("source") for h in history[:2]] == [None, "try"]
    bad = client.post(url, headers=pi, files=[("files", ("a.csv", one, "text/csv"))], data={"source": "x"})
    assert bad.status_code == 422 and "source" in bad.json()["detail"]
    audit = session.query(AuditLog).filter_by(category="inference", action="inference.upload").all()
    assert len(audit) == 2 and {a.detail["mode"] for a in audit} == {"upload"}
