"""影像分類指標（imagekit.classification_metrics）：二分類的敏感度、特異度、AUC、ROC；多分類的各類別召回率。"""
import numpy as np
import pytest

import imagekit


def _probs(positive_scores):
    s = np.asarray(positive_scores, dtype="float64")
    return np.stack([1 - s, s], axis=1)


def test_binary_metrics_match_hand_count():
    truth = np.array([0, 0, 0, 1, 1, 1, 1])
    probs = _probs([0.1, 0.6, 0.3, 0.8, 0.4, 0.9, 0.7])
    out = imagekit.classification_metrics(truth, probs, ["正常", "異常"])
    assert out["accuracy"] == pytest.approx(5 / 7)
    assert out["sensitivity"] == pytest.approx(3 / 4)     # 0.4 判為陰性
    assert out["specificity"] == pytest.approx(2 / 3)     # 0.6 判為陽性
    # AUC＝陽性分數大於陰性分數的配對比例：12 對中 11 對（0.4 < 0.6）
    assert out["auc"] == pytest.approx(11 / 12)
    roc = out["roc"]
    assert roc["positive"] == "異常"
    assert roc["fpr"][0] == 0 and roc["tpr"][0] == 0 and roc["fpr"][-1] == 1 and roc["tpr"][-1] == 1
    assert len(roc["fpr"]) == len(roc["tpr"])
    assert "recall_per_class" not in out


def test_binary_auc_matches_sklearn_and_roc_is_downsampled():
    sklearn = pytest.importorskip("sklearn.metrics")
    rng = np.random.RandomState(3)
    truth = rng.randint(0, 2, 1000)
    scores = np.clip(truth * 0.3 + rng.rand(1000) * 0.7, 0, 1).round(3)
    out = imagekit.classification_metrics(truth, _probs(scores), ["a", "b"])
    assert out["auc"] == pytest.approx(sklearn.roc_auc_score(truth, scores))
    assert len(out["roc"]["fpr"]) <= imagekit.MAX_ROC_POINTS
    assert np.all(np.diff(out["roc"]["fpr"]) >= 0) and np.all(np.diff(out["roc"]["tpr"]) >= 0)


def test_binary_single_class_has_no_auc():
    out = imagekit.classification_metrics(np.array([1, 1]), _probs([0.8, 0.3]), ["a", "b"])
    assert out["sensitivity"] == 0.5 and "specificity" not in out and "auc" not in out and "roc" not in out


def test_multiclass_recall_per_class():
    truth = np.array([0, 0, 1, 1, 2])
    probs = np.eye(3)[[0, 1, 1, 1, 0]]
    out = imagekit.classification_metrics(truth, probs, ["CT", "MR", "CR"])
    assert out["accuracy"] == pytest.approx(3 / 5)
    assert out["recall_per_class"] == {"CT": 0.5, "MR": 1.0, "CR": 0.0}
    assert "auc" not in out and "sensitivity" not in out
    missing = imagekit.classification_metrics(np.array([0, 1]), np.eye(3)[[0, 1]], ["CT", "MR", "CR"])
    assert missing["recall_per_class"]["CR"] is None


def test_classification_charts_same_shape_as_tabular():
    truth = np.array([0, 0, 1, 1])
    probs = _probs([0.2, 0.7, 0.9, 0.4])
    metrics = imagekit.classification_metrics(truth, probs, ["a", "b"])
    charts = imagekit.classification_charts("image_classification", "test", truth, probs, ["a", "b"], metrics)
    assert charts["confusion_matrix"] == {"labels": ["a", "b"], "matrix": [[1, 1], [1, 1]]}
    assert charts["roc"]["positive"] == "b" and charts["roc"]["auc"] == pytest.approx(0.75)
    assert charts["roc"]["points"][0] == [0, 0] and charts["rows"] == 4 and charts["subset"] == "test"
