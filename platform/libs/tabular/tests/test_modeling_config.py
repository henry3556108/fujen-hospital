"""TC-B04-03: Target / Feature settings round-trip (set 3 times, reload each time, 100% identical)."""

import json

import pytest

from tabular.errors import TabularError
from tabular.modeling_config import TargetFeatureConfig

STEPS = [
    {"id": "impute_mean", "columns": ["bmi"], "params": {}},
    {"id": "onehot", "columns": ["sex", "diagnosis"], "params": {"drop_first": True}},
]


def _is_zh(text):
    return any("一" <= ch <= "鿿" for ch in text)


def test_to_dict_shape_fills_step_defaults():
    cfg = TargetFeatureConfig("outcome", ["age", "bmi"], [{"id": "impute_mean", "columns": ["bmi"]}])
    assert cfg.to_dict() == {
        "version": 1,
        "target": "outcome",
        "features": ["age", "bmi"],
        "steps": [{"id": "impute_mean", "columns": ["bmi"], "params": {}}],
    }


@pytest.mark.parametrize(
    "target,features,steps",
    [
        ("outcome", ["age", "bmi", "sex"], STEPS),
        ("event", ["age", "group"], []),
        ("time", ["age", "cholesterol", "smoker", "diagnosis"], [{"id": "scale_standard", "columns": ["age"]}]),
    ],
)
def test_round_trip_through_json_is_identical(patients_df, target, features, steps):
    cfg = TargetFeatureConfig(target, features, steps)
    cfg.validate_against(patients_df.columns)
    for _ in range(3):  # set -> save -> reload, three times
        payload = json.dumps(cfg.to_dict(), ensure_ascii=False)
        reloaded = TargetFeatureConfig.from_dict(json.loads(payload))
        assert reloaded == cfg
        assert reloaded.to_dict() == cfg.to_dict()
        cfg = reloaded


def test_json_helpers_round_trip():
    cfg = TargetFeatureConfig("outcome", ["age"], STEPS)
    assert TargetFeatureConfig.from_json(cfg.to_json()) == cfg


def test_features_order_preserved():
    cfg = TargetFeatureConfig("y", ["c", "a", "b"])
    assert TargetFeatureConfig.from_dict(cfg.to_dict()).features == ["c", "a", "b"]


@pytest.mark.parametrize(
    "kwargs",
    [
        {"target": "age", "features": ["age", "bmi"]},       # target in features
        {"target": "", "features": ["age"]},                 # empty target
        {"target": "outcome", "features": []},               # no features
        {"target": "outcome", "features": ["age", "age"]},   # duplicate features
        {"target": "outcome", "features": ["age"], "steps": [{"id": "nope"}]},
        {"target": "outcome", "features": "age"},            # wrong type
    ],
)
def test_invalid_config_raises_chinese_error(kwargs):
    with pytest.raises(TabularError) as exc:
        TargetFeatureConfig(**kwargs)
    assert _is_zh(exc.value.message)


def test_validate_against_reports_missing_columns(patients_df):
    cfg = TargetFeatureConfig("outcome", ["age", "height"])
    with pytest.raises(TabularError) as exc:
        cfg.validate_against(patients_df.columns)
    assert "height" in exc.value.message
    with pytest.raises(TabularError):
        TargetFeatureConfig("mortality", ["age"]).validate_against(patients_df.columns)


@pytest.mark.parametrize("bad", [None, [], {"target": "y"}, {"target": "y", "features": ["x"], "version": 99}])
def test_from_dict_rejects_malformed(bad):
    with pytest.raises(TabularError):
        TargetFeatureConfig.from_dict(bad)
