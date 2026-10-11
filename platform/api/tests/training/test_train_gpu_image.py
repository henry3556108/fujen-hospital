"""Job 映像：Keras 影像工作用 GPU 映像（TRAINING_GPU_IMAGE），結構式與假訓練用 CPU 映像（TRAINING_IMAGE）。"""
import pytest

from app.training import config as cfg
from conftest_training import batch, batch_job, finish, ok, setting_body, start

GPU_IMAGE = "platform-trainer-gpu:dev"


def _spec(backend, run):
    return next(j.spec for j in backend._jobs.values() if dict(j.spec.env).get("RUN_ID") == str(run["id"]))


@pytest.mark.parametrize("kind", cfg.KINDS)
def test_template_training_picks_the_image_by_kind(kind, client, pi, project, backend, images, volumes, table,
                                                   monkeypatch):
    monkeypatch.setenv("TRAINING_GPU_IMAGE", GPU_IMAGE)
    run = start(client, pi, project.id, setting_body(kind, synth=images, dataset_id=table), executor="template")
    spec = _spec(backend, run)
    want = GPU_IMAGE if kind in cfg.IMAGE_KINDS else "platform-trainer:dev"
    assert spec.image == want, "影像訓練用 GPU 映像；結構式用 CPU 映像（scikit-learn 版本與推論服務一致）"
    assert spec.queue == "gpu-exclusive" and spec.gpus == 1, "排程池不變：都在專案綁定的 GPU 群組"


def test_fake_training_keeps_the_cpu_image(client, pi, project, backend, images, monkeypatch):
    monkeypatch.setenv("TRAINING_GPU_IMAGE", GPU_IMAGE)
    run = start(client, pi, project.id, setting_body("image_classification", synth=images), executor="fake")
    assert _spec(backend, run).image == "platform-trainer:dev"


def test_without_a_gpu_image_everything_uses_the_cpu_image(client, pi, project, backend, images, monkeypatch):
    monkeypatch.delenv("TRAINING_GPU_IMAGE", raising=False)
    run = start(client, pi, project.id, setting_body("image_classification", synth=images), executor="template")
    assert _spec(backend, run).image == "platform-trainer:dev"


def test_batch_inference_picks_the_image_by_model(client, pi, project, backend, inference, images, table, tmp_path,
                                                  monkeypatch):
    monkeypatch.setenv("TRAINING_GPU_IMAGE", GPU_IMAGE)
    models = {}
    for kind, body in (("image", setting_body("image_classification", synth=images)),
                       ("tabular", setting_body("tabular_classification", dataset_id=table))):
        run = finish(client, backend, pi, start(client, pi, project.id, body), tmp_path / kind)
        models[kind] = run["model_id"]
    image_job = batch_job(backend, batch(client, pi, project.id, models["image"], "all")).spec
    tabular_job = batch_job(backend, batch(client, pi, project.id, models["tabular"], "all")).spec
    assert (image_job.image, image_job.queue) == (GPU_IMAGE, "gpu-exclusive")
    assert (tabular_job.image, tabular_job.queue) == ("platform-trainer:dev", "cpu-data")
    assert ok(client.get(f"/api/projects/{project.id}/models/{models['image']}", headers=pi))["format"] == "h5"
