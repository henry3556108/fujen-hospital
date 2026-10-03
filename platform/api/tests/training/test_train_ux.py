"""建模端使用性（2026-10-03 B 組）：K 折設定、超參數白話說明、圖表資料與可列印報表。"""
import csv
import io
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


def test_original_column_next_to_its_onehot_step_names_the_generated_columns(client, pi, project, backend, table):
    """使用性測試第二輪：sex 已 One-Hot 成 sex_F、sex_M，又勾了 sex 時，訊息說出產生的欄位。"""
    body = setting_body("tabular_classification", dataset_id=table)
    body["config"]["tabular"] |= {"features": ["age", "sex", "sex_F", "sex_M"],
                                  "steps": [{"id": "onehot", "columns": ["sex"]}]}
    setting = ok(client.post(f"{base(project.id)}/settings", headers=pi, json=body), 201)
    response = client.post(f"{base(project.id)}/settings/{setting['id']}/runs", headers=pi, json={"executor": "fake"})
    assert response.status_code == 422, response.text
    assert "「sex」已轉成 sex_F、sex_M（One-Hot）" in response.json()["detail"]


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
    assert result["columns"][-4:] == ["prediction_positive_probability", "prediction", "prediction_probability",
                                      "prediction_note"], "最後三欄不變；陽性類別的機率放在 prediction 前面"
    assert result["positive_label"] == "1"
    first, second = result["rows"]
    assert 0.5 <= float(first[-2]) <= 1, "prediction_probability 仍是預測類別的機率"
    positive = float(first[-4])
    assert positive == (float(first[-2]) if first[-3] == "1" else round(1 - float(first[-2]), 4))
    assert first[-1] == f"diagnosis＝1 的機率 {positive:.0%}"
    assert second[-3] == "" and second[-4] == "" and second[-1] == "特徵含缺值，無法預測"


def test_positive_probability_is_derived_from_the_predicted_class():
    """二元分類：陽性類別（類別排序後的第二個）的機率＝預測為陽性時 p，否則 1 − p；說明欄寫陽性的機率。"""
    from app.training.service import _tabular_result

    answer = {"predictions": [0, 1, None, 1], "probabilities": [0.94, 0.83, None, 0.6],
              "notes": [None, None, "特徵含缺值，無法預測", "glucose 缺值，已用訓練資料的中位數 100 補上"]}
    data, extra = _tabular_result(["id"], [["a"], ["b"], ["c"], ["d"]], answer, target="diagnosis", positive="1")
    rows = list(csv.reader(io.StringIO(data.decode())))
    assert rows[0] == ["id", "prediction_positive_probability", "prediction", "prediction_probability",
                       "prediction_note"]
    assert rows[1] == ["a", "0.06", "0", "0.94", "diagnosis＝1 的機率 6%"]
    assert rows[2] == ["b", "0.83", "1", "0.83", "diagnosis＝1 的機率 83%"]
    assert rows[3] == ["c", "", "", "", "特徵含缺值，無法預測"]
    assert rows[4] == ["d", "0.6", "1", "0.6", "diagnosis＝1 的機率 60%（glucose 缺值，已用訓練資料的中位數 100 補上）"]
    assert extra == {"prediction_column": "prediction", "unpredicted": 1, "positive_label": "1"}


def test_multiclass_keeps_the_predicted_class_probability_without_positive_column():
    from app.training.service import _tabular_result

    answer = {"predictions": ["b"], "probabilities": [0.7], "notes": [None]}
    data, extra = _tabular_result(["id"], [["a"]], answer, target="grade", positive=None)
    rows = list(csv.reader(io.StringIO(data.decode())))
    assert rows == [["id", "prediction", "prediction_probability", "prediction_note"], ["a", "b", "0.7", "預測為「b」的機率 70%"]]
    assert "positive_label" not in extra


def test_online_prediction_returns_the_positive_class_probability(client, pi, member, project, backend, table,
                                                                   tmp_path, inference):
    run = start(client, pi, project.id, setting_body("tabular_classification", dataset_id=table))
    simulate_job(client, backend, run, tmp_path)
    backend.advance(60)
    done = ok(client.get(f"{base(project.id)}/runs/{run['id']}", headers=pi))
    allowed = member("md01", Role.MEDICAL_DOCTOR)
    created = ok(client.post(f"/api/projects/{project.id}/deployments", headers=pi,
                             json={"model_id": done["model_id"], "allowed_users": ["md01"]}), 201)
    rows = [{"age": 60, "bmi": 25, "glucose": 100, "sbp": 130}, {"age": 40, "bmi": 22, "glucose": 90, "sbp": 120}]
    out = ok(client.post(created["endpoint"], headers=allowed, json={"rows": rows}))
    assert out["positive_label"] == "1" and len(out["positive_probabilities"]) == 2
    for label, p, positive in zip(out["predictions"], out["probabilities"], out["positive_probabilities"]):
        assert positive == (p if label == "1" else round(1 - p, 4))


# ---------------------------------------------------------------- 使用性測試第二輪：缺值處理

def test_missing_choice_is_normalised_and_old_settings_stay_without_it():
    body = setting_body("tabular_classification", dataset_id=1)["config"]
    assert "missing" not in cfg.normalise(body)["tabular"], "舊設定不多欄位"
    filled = cfg.normalise(body | {"tabular": {**body["tabular"], "missing": "impute"}})
    assert filled["tabular"]["missing"] == "impute" and cfg.normalise(filled) == filled
    with pytest.raises(cfg.ConfigError, match="缺值處理"):
        cfg.normalise(body | {"tabular": {**body["tabular"], "missing": "zero"}})


def test_dataset_target_feature_keeps_the_missing_choice(client, pi, project, table):
    url = f"/api/projects/{project.id}/tabular/datasets/{table}/target-feature"
    saved = ok(client.put(url, headers=pi, json={"target": "diagnosis", "features": ["age", "glucose"],
                                                 "missing": "impute"}))
    assert saved["config"]["missing"] == "impute"
    assert ok(client.get(url, headers=pi))["config"]["missing"] == "impute"
    plain = ok(client.put(url, headers=pi, json={"target": "diagnosis", "features": ["age"]}))
    assert "missing" not in plain["config"]


def test_impute_trains_on_every_patient_and_predicts_rows_with_gaps(client, pi, project, backend, table, tmp_path,
                                                                     inference):
    body = setting_body("tabular_classification", dataset_id=table)
    body["config"]["tabular"] |= {"features": ["age", "sex", "glucose"], "steps": [], "missing": "impute"}
    run = start(client, pi, project.id, body, executor="template")
    done = run_container(client, backend, pi, run, tmp_path)
    assert done["status"] == "succeeded", done["message"]
    data = done["metrics"]["data"]
    assert data["missing"] == "impute" and data["missing_columns"]["glucose"] > 0
    assert sum(done["metrics"]["rows"].values()) == data["total"]
    model = ok(client.get(f"/api/projects/{project.id}/models/{done['model_id']}", headers=pi))
    assert model["card"]["missing"] == "impute"
    csv_text = "age,sex,glucose\n60,M,100\n40,F,\n"
    out = ok(client.post(f"/api/projects/{project.id}/models/{done['model_id']}/inference/upload", headers=pi,
                         files=[("files", ("gaps.csv", csv_text.encode(), "text/csv"))]), 201)
    result = ok(client.get(f"/api/projects/{project.id}/inference/{out['id']}", headers=pi))["result"]
    first, second = result["rows"]
    assert second[-3] != "", "有缺值的病人也有預測"
    assert second[-1].startswith("diagnosis＝1 的機率") and "glucose 缺值，已用訓練資料的中位數" in second[-1]
    assert "缺值" not in first[-1]


def test_report_says_how_many_patients_were_used_and_why_some_were_not():
    from app.training.report import data_text

    data = {"missing": "drop", "total": 100, "used": {"train": 57, "validation": 19, "test": 19},
            "left_out": {"train": {"missing_target": 0, "missing_feature": 3},
                         "validation": {"missing_target": 0, "missing_feature": 1},
                         "test": {"missing_target": 0, "missing_feature": 1}},
            "filled": {"train": 0, "validation": 0, "test": 0}, "missing_columns": {"glucose": 5}}
    assert data_text(data) == ("共 100 位病人，訓練 57 位、驗證 19 位、測試 19 位。"
                               "特徵有缺值的 5 位沒有使用（缺值：glucose 5 位）。")
    filled = data | {"missing": "impute", "used": {"train": 60, "validation": 20, "test": 20},
                     "left_out": {k: {"missing_target": 0, "missing_feature": 0} for k in data["used"]},
                     "filled": {"train": 3, "validation": 1, "test": 1}}
    assert "有 5 位的缺值（glucose 5 位）已用訓練資料的中位數或最常見的值補上" in data_text(filled)
