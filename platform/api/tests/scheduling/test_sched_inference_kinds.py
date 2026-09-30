"""批次推論的排程工作：影像走專案綁定的 GPU 群組、結構式走 cpu-data；稽核歸 inference；取消可與呼叫端同交易。"""
import pytest

from app.models import AuditLog
from app.scheduling import service
from app.scheduling.backend import Workload
from app.scheduling.models import Job

WORK = Workload(image="platform-trainer:dev", command=("python", "-m", "trainer.batch"), env={"INFERENCE_ID": "1"})


def test_gpu_inference_uses_the_project_gpu_group(session, backend, make_project):
    project = make_project("P-inf", gpu_group="gpu-shared")
    job = service.submit_job(session, backend, project=project, actor="pi01", kind="inference", source_ip=None,
                             workload=WORK)
    spec = backend._jobs[job.k8s_name].spec
    assert (job.queue, job.gpu_group, spec.gpus, spec.pool) == ("gpu-shared", "gpu-shared", 1, "gpu-shared")
    assert spec.timeout_seconds == 3600, "共享池的執行時限同樣適用"
    assert "platform/training-id" not in spec.labels
    entry = session.query(AuditLog).filter_by(action="job.submit").one()
    assert entry.category == "inference" and entry.detail["kind"] == "inference"


def test_cpu_inference_runs_on_cpu_data_without_a_gpu(session, backend, make_project):
    project = make_project("P-cpu", gpu_group=None)
    job = service.submit_job(session, backend, project=project, actor="pi01", kind="inference-cpu", source_ip=None,
                             workload=WORK)
    spec = backend._jobs[job.k8s_name].spec
    assert (job.queue, job.gpu_group, spec.gpus, spec.pool) == ("cpu-data", None, 0, "cpu-data")


def test_gpu_inference_needs_a_gpu_group(session, backend, make_project):
    project = make_project("P-none", gpu_group=None)
    with pytest.raises(service.Conflict, match="尚未綁定 GPU 群組"):
        service.submit_job(session, backend, project=project, actor="pi01", kind="inference", source_ip=None,
                           workload=WORK)


def test_mark_cancelled_leaves_the_commit_to_the_caller(session, backend, make_project):
    project = make_project("P-cancel")
    job = service.submit_job(session, backend, project=project, actor="pi01", kind="inference", source_ip=None,
                             workload=WORK)
    service.mark_cancelled(session, backend, job, actor="pi01", source_ip="10.0.0.1")
    assert job.status == "cancelled" and backend.get(job.k8s_name) is None
    session.rollback()
    assert session.get(Job, job.id).status == "queued", "沒有 commit：呼叫端決定"
    assert not session.query(AuditLog).filter_by(action="job.cancel").all()


def test_cancel_job_still_commits_and_audits_as_training(session, backend, make_project):
    project = make_project("P-train")
    job = service.submit_job(session, backend, project=project, actor="pi01", kind="training", source_ip=None)
    service.cancel_job(session, backend, project_id=project.id, job_id=job.id, actor="pi01", source_ip=None)
    session.rollback()
    assert session.get(Job, job.id).status == "cancelled"
    assert session.query(AuditLog).filter_by(action="job.cancel").one().category == "training"


def test_users_cannot_submit_inference_jobs_directly(client, backend, make_project, member):
    project = make_project("P-api")
    headers = member(project, "ra01")
    for kind in ("inference", "inference-cpu"):
        assert client.post(f"/api/projects/{project.id}/jobs", headers=headers, json={"kind": kind}).status_code == 422
