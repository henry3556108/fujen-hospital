"""第三輪使用性改善（docs/usability/2026-10-03-round2.md）：報表的一句結論與網頁同一個規則。"""
from app.training.report import build, verdict

ROUND2 = {
    "rows": {"train": 80, "validation": 0, "test": 20},
    "test": {"accuracy": 0.6, "auc": 0.725, "baseline_accuracy": 0.35},
    "cv": {"method": "kfold", "folds": 5, "rows": 80, "stratified": True,
           "auc": {"mean": 0.837, "std": 0.0485, "values": [0.818, 0.818, 0.817, 0.933, 0.8]},
           "accuracy": {"mean": 0.8, "std": 0.061, "values": [0.813, 0.688, 0.875, 0.813, 0.813]}},
}


def test_verdict_uses_the_kfold_mean_then_test_then_validation():
    assert verdict("tabular_classification", ROUND2) == "良好（AUC 0.84，5 折平均）"
    no_cv = {k: v for k, v in ROUND2.items() if k != "cv"}
    assert verdict("tabular_classification", no_cv) == "尚可（AUC 0.73，測試集）"
    assert verdict("tabular_classification", {"validation": {"auc": 0.95}}) == "優秀（AUC 0.95，驗證集）"
    assert verdict("tabular_regression", {"test": {"r2": 0.55}}) == "尚可（R² 0.55，測試集）"
    assert verdict("tabular_classification", {"test": {"accuracy": 0.42, "baseline_accuracy": 0.4}}) == \
        "沒有比全部猜最常見的類別好（準確率 42%，測試集）"
    assert verdict("tabular_classification", {"test": {"auc": 0.9}}, "fake") == "快速測試，沒有意義（AUC 0.90，測試集）"
    assert verdict("tabular_classification", {}) == ""


def test_report_opens_the_results_with_the_same_sentence():
    run = {"id": 20, "name": "心臟科", "kind": "tabular_classification", "executor": "template", "seed": 42,
           "config": {"kind": "tabular_classification", "split": {"train": 0.8, "validation": 0, "test": 0.2},
                      "validation": {"method": "kfold", "folds": 5},
                      "tabular": {"target": "diagnosis", "features": ["age"], "steps": [], "algorithm": "logistic_regression"}},
           "metrics": ROUND2, "artifacts": {}, "dataset_version_id": 1, "created_by": "pi01"}
    html = build(run=run, charts=None, generated_by="pi01")
    assert "整體表現：良好（AUC 0.84，5 折平均）" in html
    assert html.index("整體表現") < html.index("K 折交叉驗證</h2>")


def test_report_names_steps_in_chinese_and_states_the_missing_value_choice():
    run = {"id": 3, "name": "x", "kind": "tabular_classification", "executor": "template", "seed": 1,
           "config": {"kind": "tabular_classification", "split": {"train": 0.6, "validation": 0.2, "test": 0.2},
                      "tabular": {"target": "diagnosis", "features": ["sex_F", "sex_M"], "missing": "impute",
                                  "steps": [{"id": "onehot", "columns": ["sex"], "params": {}}],
                                  "algorithm": "random_forest"}},
           "metrics": {}, "artifacts": {}, "dataset_version_id": 1, "created_by": "pi01"}
    html = build(run=run, charts=None, generated_by="pi01")
    assert "One-Hot 編碼：sex" in html and "補上缺值後使用" in html


def test_report_names_the_positive_class_used_for_prediction_probabilities():
    """修正缺陷 1：報表說出陽性類別，與預測時顯示的「diagnosis＝1 的機率」一致。"""
    run = {"id": 4, "name": "x", "kind": "tabular_classification", "executor": "template", "seed": 1,
           "config": {"kind": "tabular_classification", "split": {"train": 0.6, "validation": 0.2, "test": 0.2},
                      "tabular": {"target": "diagnosis", "features": ["age"], "steps": [], "algorithm": "random_forest"}},
           "metrics": {"labels": {"majority": "0", "positive": "1"}, "test": {"auc": 0.75}},
           "artifacts": {}, "dataset_version_id": 1, "created_by": "pi01"}
    html = build(run=run, charts=None, generated_by="pi01")
    assert "陽性＝diagnosis 為「1」" in html and "diagnosis＝1 的機率" in html
    multi = {**run, "metrics": {"labels": {"majority": "a"}, "test": {"accuracy": 0.7}}}
    assert "陽性＝" not in build(run=multi, charts=None, generated_by="pi01")
