"""訓練用前處理：在訓練資料上擬合、套用到其他資料（避免資料洩漏）。"""
import pickle

import numpy as np
import pandas as pd
import pytest
from pandas.testing import assert_frame_equal

from tabular.errors import TabularError
from tabular.fitted import STEP_MODES, TRAIN_ONLY, fit_pipeline
from tabular.preprocess import REGISTRY, apply_pipeline
from test_preprocess import CASES, make_frame


def test_every_registered_step_has_a_mode():
    assert set(STEP_MODES) == set(REGISTRY)
    assert set(STEP_MODES.values()) == {"stateless", "fitted", "train_only"}
    assert {k for k, v in STEP_MODES.items() if v == "train_only"} == set(TRAIN_ONLY)


@pytest.mark.parametrize("step_id", sorted(CASES))
def test_fit_on_training_frame_equals_stateless_pipeline(step_id):
    """在訓練資料上，擬合版與原本的無狀態版結果完全相同（66 種方法）。"""
    columns, params, _ = CASES[step_id]
    steps = [{"id": step_id, "columns": columns, "params": params}]
    train = make_frame()
    fitted, out = fit_pipeline(train, steps)
    assert_frame_equal(out, apply_pipeline(train, steps))
    assert_frame_equal(train, make_frame())  # 不改動輸入


@pytest.mark.parametrize("step_id", sorted(k for k, v in STEP_MODES.items() if v != "train_only"))
def test_transform_keeps_every_row(step_id):
    columns, params, _ = CASES[step_id]
    fitted, _ = fit_pipeline(make_frame(), [{"id": step_id, "columns": columns, "params": params}])
    other = make_frame().iloc[:5].reset_index(drop=True)
    assert len(fitted.transform(other)) == 5


def test_statistics_come_from_training_data_only():
    train = pd.DataFrame({"x": [1.0, 2.0, 3.0, np.nan], "g": ["a", "b", "a", "a"]})
    test = pd.DataFrame({"x": [100.0, np.nan], "g": ["b", "z"]})
    steps = [{"id": "impute_mean", "columns": ["x"]}, {"id": "scale_standard", "columns": ["x"]},
             {"id": "onehot", "columns": ["g"]}]
    fitted, train_out = fit_pipeline(train, steps)
    out = fitted.transform(test)

    filled = train.x.fillna(2.0)
    mean, std = filled.mean(), filled.std(ddof=0)
    assert np.allclose(out.x, [(100 - mean) / std, (2.0 - mean) / std])  # 缺值補的是訓練集平均 2.0
    assert list(out.columns) == list(train_out.columns) == ["x", "g_a", "g_b"]
    assert out[["g_a", "g_b"]].values.tolist() == [[0, 1], [0, 0]]       # 沒看過的類別 z → 全 0
    # 無狀態版會用測試資料自己的統計量，結果不同：這就是要避免的洩漏
    assert not np.allclose(apply_pipeline(test, steps[:2]).x, out.x)


def test_outlier_bounds_from_training_and_rows_not_removed_on_transform():
    train = pd.DataFrame({"x": [1.0, 2, 3, 4, 5, 6, 7, 8, 9, 1000]})
    steps = [{"id": "iqr_remove", "columns": ["x"]}, {"id": "iqr_clip", "columns": ["x"]}]
    fitted, train_out = fit_pipeline(train, steps)
    assert len(train_out) == 9                     # 訓練時刪掉離群列
    out = fitted.transform(pd.DataFrame({"x": [5.0, 5000.0]}))
    assert len(out) == 2 and out.x[0] == 5.0       # 套用時不刪列
    assert out.x[1] < 20                           # 以訓練資料的界線截斷


def test_target_column_may_be_absent_at_inference():
    train = pd.DataFrame({"age": [30.0, 40, 50, 60], "sex": ["F", "M", "F", "M"], "y": ["no", "yes", "no", "yes"]})
    steps = [{"id": "scale_minmax", "columns": ["age", ]}, {"id": "binary_map", "columns": ["y"],
                                                          "params": {"positive": "yes"}},
             {"id": "onehot", "columns": ["sex"]}]
    fitted, train_out = fit_pipeline(train, steps)
    assert train_out.y.tolist() == [0, 1, 0, 1]
    out = fitted.transform(train.drop(columns=["y"]), optional=["y"])
    assert list(out.columns) == ["age", "sex_F", "sex_M"]
    with pytest.raises(TabularError) as err:
        fitted.transform(train.drop(columns=["age"]), optional=["y"])
    assert err.value.code == "column_not_found"


def test_joint_step_reports_missing_column_in_chinese():
    train = pd.DataFrame({"a": [1.0, 2, 3, 4], "b": [2.0, 1, 4, 3], "y": [0, 1, 0, 1]})
    fitted, _ = fit_pipeline(train, [{"id": "pca", "columns": ["a", "y"], "params": {"n_components": 1}}])
    with pytest.raises(TabularError) as err:
        fitted.transform(train.drop(columns=["y"]), optional=["y"])
    assert "主成分分析" in str(err.value)


def test_fitted_pipeline_survives_pickle():
    train = make_frame()
    steps = [{"id": "impute_median", "columns": ["num"]}, {"id": "kbins_quantile", "columns": ["pos"]},
             {"id": "onehot", "columns": ["cat"]}, {"id": "pca", "columns": ["neg", "frac"],
                                                    "params": {"n_components": 1}}]
    fitted, _ = fit_pipeline(train, steps)
    clone = pickle.loads(pickle.dumps(fitted))
    assert_frame_equal(clone.transform(train), fitted.transform(train))
    assert clone.output_columns == fitted.output_columns
