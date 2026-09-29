"""MLflow REST 用法（以 httpx MockTransport 驗證送出的請求），以及 MLflow 連不上時不影響訓練。"""
import json

import httpx

from app.training.tracking import MlflowTracker, TrackingError, metrics_of, params_of, tracker_from_env
from conftest_training import finish, setting_body, start


def test_mlflow_rest_calls():
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else None
        calls.append((request.method, request.url.path, body))
        path = request.url.path.removeprefix("/api/2.0/mlflow")
        if path == "/experiments/get-by-name":
            return httpx.Response(404, json={"error_code": "RESOURCE_DOES_NOT_EXIST"})
        if path == "/experiments/create":
            return httpx.Response(200, json={"experiment_id": "7"})
        if path == "/runs/create":
            return httpx.Response(200, json={"run": {"info": {"run_id": "abc"}}})
        return httpx.Response(200, json={})

    tracker = MlflowTracker("http://mlflow:5000", transport=httpx.MockTransport(handler))
    params = params_of({"seed": 1, "split": {"train": 0.6}, "hyperparameters": {"epochs": 3}})
    assert params == {"hyperparameters.epochs": "3", "seed": "1", "split.train": "0.6"}
    run_id = tracker.start_run(experiment="project-1", name="run-1", params=params, tags={"platform.run_id": "1"})
    tracker.finish_run(run_id, status="FINISHED", metrics=metrics_of({"test": {"accuracy": 0.9, "note": "x"}}),
                       tags={"platform.status": "succeeded"})
    paths = [c[1].removeprefix("/api/2.0/mlflow") for c in calls]
    assert paths == ["/experiments/get-by-name", "/experiments/create", "/runs/create", "/runs/log-batch",
                     "/runs/log-batch", "/runs/update"]
    assert calls[2][2]["experiment_id"] == "7" and calls[3][2]["params"][0] == {"key": "hyperparameters.epochs",
                                                                               "value": "3"}
    assert calls[4][2]["metrics"][0]["key"] == "test.accuracy" and calls[5][2]["status"] == "FINISHED"
    assert tracker_from_env({}) is None and isinstance(tracker_from_env({"MLFLOW_TRACKING_URI": "http://x"}),
                                                       MlflowTracker)


def test_training_still_runs_when_mlflow_is_down(client, pi, project, backend, table, tmp_path, app):
    class Down:
        def start_run(self, **kw):
            raise TrackingError("無法連線 MLflow：ConnectError")

        def finish_run(self, *a, **kw):
            raise AssertionError("沒有 run id 就不會呼叫")

    app.state.tracker = Down()
    run = start(client, pi, project.id, setting_body("tabular_regression", dataset_id=table))
    assert run["tracking_run_id"] is None and "MLflow" in run["message"]
    assert finish(client, backend, pi, run, tmp_path)["status"] == "succeeded"


def test_tracker_comes_from_the_environment_when_not_set(app, monkeypatch):
    from app.training.service import get_tracker

    monkeypatch.setenv("MLFLOW_TRACKING_URI", "http://mlflow:5000")
    assert isinstance(get_tracker(app.state), MlflowTracker)
    assert get_tracker(app.state) is get_tracker(app.state), "只建立一次"
    app.state.tracker = None                      # 明確設為 None：不記錄
    assert get_tracker(app.state) is None


def test_no_tracking_uri_means_no_tracking(app, monkeypatch):
    from app.training.service import get_tracker

    monkeypatch.delenv("MLFLOW_TRACKING_URI", raising=False)
    assert get_tracker(app.state) is None
