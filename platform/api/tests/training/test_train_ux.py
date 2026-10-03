"""建模端使用性（2026-10-03 B 組）：K 折設定、超參數白話說明、圖表資料與可列印報表。"""
import json

import pytest

from app.models import AuditLog
from app.permissions import Role
from app.training import config as cfg
from app.training.models import TrainingSetting
from conftest_training import ok, run_container, setting_body, simulate_job, start


def base(pid):
    return f"/api/projects/{pid}/training"


def kfold_body(dataset_id, folds=5, kind="tabular_classification"):
    body = setting_body(kind, dataset_id=dataset_id)
    body["config"] |= {"split": {"train": 0.8, "validation": 0.0, "test": 0.2},
                       "validation": {"method": "kfold", "folds": folds}}
    return body


# ---------------------------------------------------------------- 設定

def test_validation_defaults_to_holdout_and_kfold_is_kept():
    holdout = cfg.normalise(setting_body("tabular_regression", dataset_id=1)["config"])
    assert holdout["validation"] == {"method": "holdout"}
    kfold = cfg.normalise(kfold_body(1, folds=3)["config"])
    assert kfold["validation"] == {"method": "kfold", "folds": 3}
    assert cfg.normalise(kfold) == kfold, "正規化兩次結果相同"
    default_k = cfg.normalise(setting_body("tabular_regression", dataset_id=1)["config"] | {
        "validation": {"method": "kfold"}})
    assert default_k["validation"] == {"method": "kfold", "folds": 5}


@pytest.mark.parametrize("validation,message", [
    ({"method": "loo"}, "驗證方式"),
    ({"method": "kfold", "folds": 1}, "折數"),
    ({"method": "kfold", "folds": 11}, "折數"),
    ({"method": "kfold", "folds": 2.5}, "整數"),
    ({"method": "kfold", "folds": 5, "repeats": 2}, "不支援的驗證方式設定"),
    ({"method": "holdout", "folds": 5}, "固定比例切分不需要"),
    ("kfold", "格式錯誤"),
])
def test_invalid_validation_is_rejected_in_chinese(client, pi, project, table, validation, message):
    body = setting_body("tabular_classification", dataset_id=table)
    body["config"]["validation"] = validation
    response = client.post(f"{base(project.id)}/settings", headers=pi, json=body)
    assert response.status_code == 422 and message in response.json()["detail"], response.text


def test_image_training_rejects_validation(client, pi, project):
    body = setting_body("image_segmentation")
    body["config"]["validation"] = {"method": "kfold", "folds": 5}
    response = client.post(f"{base(project.id)}/settings", headers=pi, json=body)
    assert response.status_code == 422 and "影像訓練目前只支援固定比例切分" in response.json()["detail"]
    assert "validation" not in cfg.normalise(setting_body("image_segmentation")["config"])


def test_old_setting_without_validation_still_loads_and_runs(client, pi, project, backend, table, session, tmp_path):
    """升級前存的設定（資料庫裡沒有 validation）照樣讀得到、送得出，交給 Job 的設定不多欄位。"""
    old = cfg.normalise(setting_body("tabular_classification", dataset_id=table)["config"])
    old.pop("validation")
    row = TrainingSetting(project_id=project.id, name="舊設定", kind=old["kind"], config=old, created_by="pi01",
                          updated_by="pi01")
    session.add(row)
    session.commit()
    loaded = ok(client.get(f"{base(project.id)}/settings/{row.id}", headers=pi))
    assert loaded["config"] == old
    run = ok(client.post(f"{base(project.id)}/settings/{row.id}/runs", headers=pi, json={"executor": "template"}),
             201)
    assert "validation" not in run["config"]
    done = run_container(client, backend, pi, run, tmp_path)
    assert done["status"] == "succeeded" and "cv" not in done["metrics"]
    assert done["metrics"]["rows"] == {"train": 60, "validation": 20, "test": 20}


def test_catalogue_explains_every_hyperparameter_and_offers_kfold(client, pi, project):
    out = ok(client.get(f"{base(project.id)}/catalogue", headers=pi))
    params = [p for k in out["kinds"] for p in k.get("hyperparameters", [])]
    params += [p for k in out["kinds"] for a in k.get("algorithms", []) for p in a["hyperparameters"]]
    params += out["augmentation"]
    assert params and all(p["help"] and isinstance(p["advanced"], bool) for p in params), params
    common = {p["name"] for p in params if not p["advanced"]}
    assert {"epochs", "n_estimators"} <= common and "C" not in common
    tabular = {k["kind"]: k for k in out["kinds"]}
    methods = tabular["tabular_classification"]["validation_methods"]
    assert [m["method"] for m in methods] == ["holdout", "kfold"]
    assert methods[1]["folds"] == {"minimum": 2, "maximum": 10, "default": 5}
    assert all(m["name"] and m["help"] for m in methods)
    assert "validation_methods" not in tabular["image_classification"]


# ---------------------------------------------------------------- 圖表與報表

def test_kfold_run_records_cv_and_charts(client, pi, project, backend, table, tmp_path):
    run = start(client, pi, project.id, kfold_body(table), executor="template")
    assert run["config"]["validation"] == {"method": "kfold", "folds": 5}
    done = run_container(client, backend, pi, run, tmp_path)
    assert done["status"] == "succeeded", done["message"]
    cv = done["metrics"]["cv"]
    assert cv["folds"] == 5 and set(cv["accuracy"]) == {"mean", "std", "values"}
    assert "charts.json" in done["artifacts"]
    out = ok(client.get(f"{base(project.id)}/runs/{run['id']}/charts", headers=pi))
    assert out["run_id"] == run["id"] and out["kind"] == "tabular_classification"
    charts = out["charts"]
    assert charts["subset"] == "test" and charts["confusion_matrix"]["labels"] == ["0", "1"]
    assert charts["roc"]["points"][-1] == [1.0, 1.0]
    assert charts["feature_importance"]["items"]
    model = ok(client.get(f"/api/projects/{project.id}/models/{done['model_id']}", headers=pi))
    assert "confusion_matrix" not in json.dumps(model["card"]), "模型卡只有指標，沒有圖表資料"


def test_runs_without_chart_data_return_null(client, pi, project, backend, table, tmp_path):
    run = start(client, pi, project.id, setting_body("tabular_regression", dataset_id=table))   # fake-trainer
    simulate_job(client, backend, run, tmp_path)
    backend.advance(60)
    assert ok(client.get(f"{base(project.id)}/runs/{run['id']}", headers=pi))["status"] == "succeeded"
    assert ok(client.get(f"{base(project.id)}/runs/{run['id']}/charts", headers=pi))["charts"] is None


def test_charts_and_report_permissions(client, pi, member, project, backend, table, add_user):
    run = start(client, pi, project.id, setting_body("tabular_regression", dataset_id=table))
    viewer, outsider = member("vw01", Role.VIEWER), add_user("user01")[1]
    for path in ("charts", "report"):
        url = f"{base(project.id)}/runs/{run['id']}/{path}"
        assert client.get(url).status_code == 401
        for headers in (viewer, outsider):
            assert client.get(url, headers=headers).status_code == 403
        missing = client.get(f"{base(project.id)}/runs/9999/{path}", headers=pi)
        assert missing.status_code == 404 and "找不到訓練" in missing.json()["detail"]
    pending = client.get(f"{base(project.id)}/runs/{run['id']}/report", headers=pi)
    assert pending.status_code == 409 and "尚未完成" in pending.json()["detail"]


def test_printable_report_explains_metrics_and_draws_charts(client, pi, project, backend, table, tmp_path, session):
    run = start(client, pi, project.id, kfold_body(table, folds=4), executor="template")
    done = run_container(client, backend, pi, run, tmp_path)
    response = client.get(f"{base(project.id)}/runs/{run['id']}/report", headers=pi)
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/html")
    assert f'filename="training-run-{run["id"]}-report.html"' in response.headers["content-disposition"]
    html = response.text
    for text in ("訓練報表", "結構式分類", "隨機森林", "K 折交叉驗證（K = 4）", "準確率", "AUC",
                 "0.5 等於亂猜", "混淆矩陣", "ROC 曲線", "特徵重要性", "diagnosis", done["artifacts"]["model.pkl"]["sha256"],
                 "@media print"):
        assert text in html, text
    assert html.count("<svg") >= 2 and "<script" not in html
    audit = session.query(AuditLog).filter_by(action="training.report").one()
    assert audit.category == "training" and audit.target == f"training_run:{run['id']}"


def test_regression_report_has_scatter_and_residuals(client, pi, project, backend, table, tmp_path):
    run = start(client, pi, project.id, setting_body("tabular_regression", dataset_id=table), executor="template")
    run_container(client, backend, pi, run, tmp_path)
    html = client.get(f"{base(project.id)}/runs/{run['id']}/report", headers=pi).text
    for text in ("R²", "RMSE", "預測值與實際值", "殘差分布", "固定比例切分"):
        assert text in html, text


def test_report_escapes_user_text(client, pi, project, backend, table, tmp_path):
    body = setting_body("tabular_regression", dataset_id=table, name="<img src=x onerror=alert(1)>")
    run = start(client, pi, project.id, body)
    simulate_job(client, backend, run, tmp_path)
    backend.advance(60)
    html = client.get(f"{base(project.id)}/runs/{run['id']}/report", headers=pi).text
    assert "<img src=x" not in html and "&lt;img src=x" in html
    assert "這次訓練沒有圖表資料" in html


# ---------------------------------------------------------------- 使用性測試回饋：送出前檢查、文字特徵、機率

def test_text_features_train_without_manual_encoding(client, pi, project, backend, table, tmp_path):
    body = setting_body("tabular_classification", dataset_id=table)
    body["config"]["tabular"] |= {"features": ["age", "sex", "smoker", "glucose"],
                                  "steps": [{"id": "impute_mean", "columns": ["glucose"]}]}
    run = start(client, pi, project.id, body, executor="template")
    done = run_container(client, backend, pi, run, tmp_path)
    assert done["status"] == "succeeded", done["message"]
    test = done["metrics"]["test"]
    assert {"sensitivity", "specificity", "baseline_accuracy", "auc"} <= set(test)
    model = ok(client.get(f"/api/projects/{project.id}/models/{done['model_id']}", headers=pi))
    assert model["card"]["encoded_features"] == ["sex", "smoker"]
    assert [i["name"] for i in model["card"]["inputs"]] == ["age", "sex", "smoker", "glucose"]


@pytest.mark.parametrize("change,message", [
    ({"features": ["age", "smoker_current"]}, "前處理後找不到欄位「smoker_current」"),
    ({"features": ["age", "patient_id"]}, "幾乎每一列都不同"),
    ({"target": "sex", "features": ["age"]}, None),
])
def test_submit_checks_the_setting_against_the_dataset(client, pi, project, backend, table, change, message):
    body = setting_body("tabular_classification", dataset_id=table)
    body["config"]["tabular"] |= change | {"steps": []}
    setting = ok(client.post(f"{base(project.id)}/settings", headers=pi, json=body), 201)
    response = client.post(f"{base(project.id)}/settings/{setting['id']}/runs", headers=pi, json={"executor": "fake"})
    if message is None:
        assert response.status_code == 201
        return
    assert response.status_code == 422 and message in response.json()["detail"], response.text
    assert ok(client.get(f"{base(project.id)}/runs", headers=pi)) == [], "沒有送出、沒有排隊"


def test_regression_on_text_target_is_rejected_before_queueing(client, pi, project, backend, table):
    body = setting_body("tabular_regression", dataset_id=table)
    body["config"]["tabular"] |= {"target": "smoker"}
    setting = ok(client.post(f"{base(project.id)}/settings", headers=pi, json=body), 201)
    response = client.post(f"{base(project.id)}/settings/{setting['id']}/runs", headers=pi, json={"executor": "fake"})
    assert response.status_code == 422 and "請改用「結構式分類」" in response.json()["detail"]


def test_failed_run_message_starts_with_the_reason(client, pi, project, backend, table, tmp_path):
    """訓練程式失敗時，訊息第一段是中文原因，堆疊在分隔線後的技術細節。"""
    from trainer.runner import DETAILS

    body = setting_body("tabular_classification", dataset_id=table)
    body["config"] |= {"split": {"train": 0.05, "validation": 0.0, "test": 0.95},
                       "validation": {"method": "kfold", "folds": 10}}
    run = start(client, pi, project.id, body, executor="template")
    done = run_container(client, backend, pi, run, tmp_path)
    assert done["status"] == "failed"
    reason, details = done["message"].split(DETAILS)
    assert "無法做 10 折交叉驗證" in reason and "runtime.py" not in reason and "runtime.py" in details


def test_classification_results_carry_probability(client, pi, project, backend, table, tmp_path, inference):
    run = start(client, pi, project.id, setting_body("tabular_classification", dataset_id=table))
    simulate_job(client, backend, run, tmp_path)
    backend.advance(60)
    done = ok(client.get(f"{base(project.id)}/runs/{run['id']}", headers=pi))
    csv_text = "age,bmi,glucose,sbp\n60,25,100,130\n40,22,,120\n"
    out = ok(client.post(f"/api/projects/{project.id}/models/{done['model_id']}/inference/upload", headers=pi,
                         files=[("files", ("one.csv", csv_text.encode(), "text/csv"))]), 201)
    result = ok(client.get(f"/api/projects/{project.id}/inference/{out['id']}", headers=pi))["result"]
    assert result["columns"][-3:] == ["prediction", "prediction_probability", "prediction_note"]
    first, second = result["rows"]
    assert 0.5 <= float(first[-2]) <= 1 and first[-1].startswith(f"預測為「{first[-3]}」的機率")
    assert second[-3] == "" and second[-1] == "特徵含缺值，無法預測"
