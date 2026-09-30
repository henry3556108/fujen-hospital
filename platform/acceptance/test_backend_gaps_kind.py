"""後端缺口第 2 項：刪專案時取消叢集中排隊／執行中的工作（kind 叢集 ai-platform）。

在 platform/api 下執行：uv run pytest ../acceptance/test_backend_gaps_kind.py -m kind
只刪自己建立的工作（不清整個命名空間：叢集可能有其他人在用）。
"""
import time

import pytest

from kind_harness import NAMESPACE, build_platform, kube_or_skip, wait_for

pytestmark = pytest.mark.kind


def _exists(kube, name: str) -> bool:
    from kubernetes.client.exceptions import ApiException
    try:
        job = kube.batch.read_namespaced_job(name, NAMESPACE)
    except ApiException as exc:
        if exc.status == 404:
            return False
        raise
    return job.metadata.deletion_timestamp is None


def test_project_delete_cancels_cluster_jobs(tmp_path):
    kube = kube_or_skip()
    platform = build_platform(tmp_path / "platform.db", kube)
    admin = platform.as_("admin01")
    created = platform.client.post("/api/admin/projects", headers=admin,
                                   json={"name": f"gaps-jobs-{time.time_ns()}", "gpu_group": "gpu-exclusive"})
    assert created.status_code == 201, created.text
    pid = created.json()["id"]
    names = []
    try:
        for kind in ("training", "data-cleaning"):
            job = platform.client.post(f"/api/projects/{pid}/jobs", headers=admin,
                                       json={"kind": kind, "duration_seconds": 600})
            assert job.status_code == 201, job.text
            names.append(job.json()["k8s_name"])
        wait_for(lambda: all(_exists(kube, n) for n in names), timeout=30, message="工作沒有建立")
        wait_for(lambda: kube.core.list_namespaced_pod(NAMESPACE, label_selector=f"job-name={names[1]}").items,
                 timeout=120, message="CPU 工作沒有開始執行")

        assert platform.client.delete(f"/api/admin/projects/{pid}", headers=admin).status_code == 204

        wait_for(lambda: not any(_exists(kube, n) for n in names), timeout=60, message="叢集中的工作沒有被取消")
        wait_for(lambda: not any(kube.core.list_namespaced_pod(NAMESPACE, label_selector=f"job-name={n}").items
                                 for n in names), timeout=120, message="工作的 Pod 沒有停止")
        from sqlalchemy import select

        from app.project_cleanup import StorageCleanupTask
        with platform.app.state.sessionmaker() as s:
            # 這個程序內的平台沒有物件儲存，只看叢集工作的清理
            assert s.scalars(select(StorageCleanupTask).where(StorageCleanupTask.kind == "cluster_job")).all() == []
    finally:
        for name in names:
            try:
                kube.batch.delete_namespaced_job(name, NAMESPACE, propagation_policy="Background")
            except Exception:  # noqa: BLE001 — 已經不在
                pass
