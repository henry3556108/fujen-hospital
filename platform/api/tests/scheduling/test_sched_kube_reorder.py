"""Kubernetes 後端的調整順序與暫存：以新名稱重建仍在等待的 Job（Kueue 依建立時間放行）。"""
from datetime import datetime, timedelta, timezone

import pytest
from kubernetes.client import (V1Container, V1Job, V1JobCondition, V1JobSpec, V1JobStatus, V1LabelSelector,
                               V1ObjectMeta, V1PodSpec, V1PodTemplateSpec)
from kubernetes.client.exceptions import ApiException
from sqlalchemy import select

from app.models import AuditLog
from app.scheduling.backend import NotWaiting, PartialReorder
from app.scheduling.kube import (GENERATED_LABELS, QUEUE_LABEL, SAME_QUEUE_GAP_SECONDS, KubernetesJobBackend,
                                 portable_manifest)
from app.scheduling.models import Job

T0 = datetime(2026, 10, 12, tzinfo=timezone.utc)


class ClusterBatch:
    """像 API server 一樣：建立時補上 uid、resourceVersion、建立時間、selector 與自動產生的標籤；
    刪除檢查 resourceVersion 前置條件。"""

    def __init__(self):
        self.jobs: dict[str, V1Job] = {}
        self.created: list[dict] = []
        self.deleted: list[tuple[str, dict | None]] = []
        self.seq = 0
        self.fail_create_on: set[str] = set()
        self.before_delete = None      # 測試用：刪除前模擬 Kueue 放行

    def _next(self) -> int:
        self.seq += 1
        return self.seq

    def create_namespaced_job(self, namespace, body):
        name = body["metadata"]["name"]
        if name in self.fail_create_on:
            raise ApiException(status=500, reason="boom")
        assert "selector" not in body["spec"], "重建的 Job 不可帶舊的 selector"
        for labels in (body["metadata"].get("labels") or {}, body["spec"]["template"]["metadata"].get("labels") or {}):
            assert not set(labels) & GENERATED_LABELS
        self.created.append(body)
        uid = f"uid-{self._next()}"
        generated = {"batch.kubernetes.io/controller-uid": uid, "controller-uid": uid,
                     "batch.kubernetes.io/job-name": name, "job-name": name}
        container = body["spec"]["template"]["spec"]["containers"][0]
        self.jobs[name] = V1Job(
            api_version="batch/v1", kind="Job",
            metadata=V1ObjectMeta(name=name, namespace=namespace, uid=uid, resource_version=str(self._next()),
                                  creation_timestamp=T0 + timedelta(seconds=self.seq),
                                  labels=dict(body["metadata"].get("labels") or {})),
            spec=V1JobSpec(suspend=body["spec"]["suspend"], backoff_limit=0, manual_selector=False,
                           selector=V1LabelSelector(match_labels={"batch.kubernetes.io/controller-uid": uid}),
                           template=V1PodTemplateSpec(
                               metadata=V1ObjectMeta(labels=dict(body["spec"]["template"]["metadata"]["labels"])
                                                     | generated),
                               spec=V1PodSpec(restart_policy="Never", containers=[V1Container(
                                   name=container["name"], image=container["image"],
                                   command=container["command"])]))),
            status=V1JobStatus(conditions=[V1JobCondition(type="Suspended", status="True")]))

    def read_namespaced_job(self, name, namespace):
        if name not in self.jobs:
            raise ApiException(status=404)
        return self.jobs[name]

    def delete_namespaced_job(self, name, namespace, body=None, propagation_policy=None):
        if self.before_delete:
            self.before_delete(name)
        if name not in self.jobs:
            raise ApiException(status=404)
        expected = ((body or {}).get("preconditions") or {}).get("resourceVersion")
        if expected and expected != self.jobs[name].metadata.resource_version:
            raise ApiException(status=409, reason="Conflict")
        self.deleted.append((name, body))
        del self.jobs[name]

    def list_namespaced_job(self, namespace, label_selector=None):
        key, _, value = (label_selector or "").partition("=")
        items = [j for j in self.jobs.values() if not key or (j.metadata.labels or {}).get(key) == value]
        return type("L", (), {"items": items})()

    # --- 測試控制 ---
    def admit(self, name):
        job = self.jobs[name]
        job.spec.suspend = False
        job.metadata.resource_version = str(self._next())


class NoPods:
    def list_namespaced_pod(self, namespace, label_selector=None, field_selector=None, **kw):
        return type("L", (), {"items": []})()


def make(batch, clock=None, sleeps=None):
    t = clock if clock is not None else [0.0]
    return KubernetesJobBackend(core=NoPods(), batch=batch, custom=None, namespace="platform-jobs",
                                image="busybox:1.36", clock=lambda: t[0],
                                sleep=sleeps.append if sleeps is not None else (lambda s: None))


def seed(batch, *names, queue="gpu-exclusive", job_ids=None):
    for i, name in enumerate(names):
        jid = str((job_ids or {}).get(name, i + 1))
        labels = {"platform/job-id": jid, "platform/project-id": "1", QUEUE_LABEL: queue, "platform/pool": queue}
        batch.create_namespaced_job("platform-jobs", {
            "apiVersion": "batch/v1", "kind": "Job", "metadata": {"name": name, "labels": labels},
            "spec": {"suspend": True, "template": {"metadata": {"labels": {"platform/job-id": jid}},
                                                   "spec": {"containers": [{"name": "job", "image": "busybox",
                                                                            "command": ["sleep", "1"]}]}}}})
    batch.created.clear()


def test_portable_manifest_strips_server_fields_and_generated_labels():
    batch = ClusterBatch()
    seed(batch, "job-1-aaa")
    m = portable_manifest(batch.jobs["job-1-aaa"])
    assert set(m) == {"apiVersion", "kind", "metadata", "spec"}
    assert m["metadata"] == {"labels": {"platform/job-id": "1", "platform/project-id": "1",
                                        QUEUE_LABEL: "gpu-exclusive", "platform/pool": "gpu-exclusive"}}
    assert "selector" not in m["spec"] and "manualSelector" not in m["spec"]
    assert m["spec"]["suspend"] is True and m["spec"]["backoffLimit"] == 0
    assert m["spec"]["template"]["metadata"]["labels"] == {"platform/job-id": "1"}
    assert m["spec"]["template"]["spec"]["containers"][0]["command"] == ["sleep", "1"]


def test_order_lists_waiting_jobs_by_creation_time():
    batch = ClusterBatch()
    seed(batch, "c", "a", "b")
    seed(batch, "other", queue="gpu-shared")
    batch.admit("c")
    done = batch.jobs["b"]
    done.status.conditions = [V1JobCondition(type="Failed", status="True")]
    assert make(batch).order("gpu-exclusive") == ["a"]
    assert make(batch).order("gpu-shared") == ["other"]


def test_reorder_deletes_in_current_order_and_recreates_in_new_order_spaced():
    batch, sleeps, clock = ClusterBatch(), [], [100.0]
    seed(batch, "a", "b", "c")
    b = make(batch, clock, sleeps)
    b.reorder([("c", "c2"), ("a", "a2"), ("b", "b2")])
    assert [name for name, _ in batch.deleted] == ["a", "b", "c"]
    assert all(body["preconditions"]["resourceVersion"] and body["propagationPolicy"] == "Background"
               for _, body in batch.deleted)
    assert [m["metadata"]["name"] for m in batch.created] == ["c2", "a2", "b2"]
    assert len(sleeps) == 2 and all(s == pytest.approx(SAME_QUEUE_GAP_SECONDS) for s in sleeps)
    assert b.order("gpu-exclusive") == ["c2", "a2", "b2"]
    # 平台標籤保留（GPU Dashboard、訓練同步看的是 platform/job-id）
    assert batch.jobs["c2"].metadata.labels["platform/job-id"] == "3"
    assert batch.jobs["c2"].spec.template.metadata.labels["platform/job-id"] == "3"
    assert batch.jobs["c2"].spec.template.metadata.labels["job-name"] == "c2"


def test_reorder_stops_when_job_already_admitted_before_start():
    batch = ClusterBatch()
    seed(batch, "a", "b")
    batch.admit("a")
    with pytest.raises(NotWaiting) as info:
        make(batch).reorder([("b", "b2"), ("a", "a2")])
    assert info.value.name == "a" and info.value.moved == {}
    assert batch.deleted == [] and batch.created == []


def test_reorder_admitted_midway_recreates_deleted_ones_and_reports_them():
    batch = ClusterBatch()
    seed(batch, "a", "b", "c")
    # 刪掉 a 之後、刪 b 之前 Kueue 放行了 b（resourceVersion 改變，前置條件不成立）
    batch.before_delete = lambda name: batch.admit("b") if name == "b" and batch.jobs["b"].spec.suspend else None
    with pytest.raises(NotWaiting) as info:
        make(batch).reorder([("c", "c2"), ("b", "b2"), ("a", "a2")])
    assert info.value.name == "b" and info.value.moved == {"a": "a2"}
    assert [name for name, _ in batch.deleted] == ["a"]
    assert [m["metadata"]["name"] for m in batch.created] == ["a2"]
    assert make(batch).order("gpu-exclusive") == ["c", "a2"]


def test_reorder_create_failure_reports_unplaced_manifests():
    batch = ClusterBatch()
    seed(batch, "a", "b")
    batch.fail_create_on = {"a2"}
    with pytest.raises(PartialReorder) as info:
        make(batch).reorder([("b", "b2"), ("a", "a2")])
    assert info.value.moved == {"b": "b2"}
    assert list(info.value.unplaced) == ["a"]
    assert info.value.unplaced["a"]["metadata"]["labels"]["platform/job-id"] == "1"


def test_hold_and_restore_recreate_job_under_new_name():
    batch = ClusterBatch()
    seed(batch, "a", "b")
    b = make(batch)
    manifest = b.hold("a")
    assert "a" not in batch.jobs and "uid" not in manifest["metadata"]
    b.restore(manifest, "a2")
    assert b.order("gpu-exclusive") == ["b", "a2"]
    assert batch.jobs["a2"].spec.suspend is True
    batch.admit("b")
    with pytest.raises(NotWaiting):
        b.hold("b")
    with pytest.raises(NotWaiting):
        b.hold("missing")


# ---------- 透過平台 API（Kubernetes 後端） ----------

@pytest.fixture
def kube_platform(app, admin, make_project, member):
    batch = ClusterBatch()
    app.state.job_backend = make(batch)
    project = make_project("P1-lung-ct", "gpu-exclusive")
    return batch, project, member(project, "ra01")


def test_api_reorder_updates_k8s_names_and_409_when_admitted_midway(client, session, admin, kube_platform):
    batch, project, ra = kube_platform
    jobs = [client.post(f"/api/projects/{project.id}/jobs", headers=ra, json={"kind": "training"}).json()
            for _ in range(3)]
    a, b, c = (j["id"] for j in jobs)
    ok = client.put("/api/admin/queues/gpu-exclusive/order", headers=admin, json={"job_ids": [b, a, c]})
    assert ok.status_code == 200, ok.text
    session.expire_all()
    names = {j.id: j.k8s_name for j in session.scalars(select(Job))}
    assert names[b] != jobs[1]["k8s_name"] and names[b].startswith(f"job-{b}-")
    assert make(batch).order("gpu-exclusive") == [names[b], names[a], names[c]]
    overview = client.get("/api/admin/queues", headers=admin).json()[0]
    assert [j["id"] for j in overview["waiting"]] == [b, a, c]

    # 第二次調整途中，排頭被放行：已移動的回報、資料庫的名稱跟著更新
    head = names[b]
    batch.before_delete = lambda name: batch.admit(head) if name == head and batch.jobs[head].spec.suspend else None
    # 目前順序 b、a、c，新順序 c、a、b：全部要動，依目前順序先刪 b，此時 b 剛被放行
    conflict = client.put("/api/admin/queues/gpu-exclusive/order", headers=admin, json={"job_ids": [c, a, b]})
    assert conflict.status_code == 409 and f"工作 {b}" in conflict.json()["detail"]
    assert "順序沒有變更" in conflict.json()["detail"]
    logs = session.scalars(select(AuditLog).where(AuditLog.action == "queue.reorder")).all()
    assert [log.result for log in logs] == ["success", "conflict"]


def test_api_reorder_partial_failure_holds_unplaced_jobs(client, session, admin, kube_platform):
    batch, project, ra = kube_platform
    jobs = [client.post(f"/api/projects/{project.id}/jobs", headers=ra, json={"kind": "training"}).json()
            for _ in range(2)]
    a, b = (j["id"] for j in jobs)
    original = batch.create_namespaced_job

    def flaky(namespace, body):
        if body["metadata"]["name"].startswith(f"job-{a}-") and body["metadata"]["name"] != jobs[0]["k8s_name"]:
            raise ApiException(status=500, reason="boom")
        return original(namespace, body)

    batch.create_namespaced_job = flaky
    response = client.put("/api/admin/queues/gpu-exclusive/order", headers=admin, json={"job_ids": [b, a]})
    assert response.status_code == 503 and "暫存" in response.json()["detail"]
    held = client.get(f"/api/projects/{project.id}/jobs/{a}", headers=ra).json()
    assert held["status"] == "held"
    batch.create_namespaced_job = original
    resumed = client.post(f"/api/projects/{project.id}/jobs/{a}/resume", headers=ra)
    assert resumed.status_code == 200 and resumed.json()["status"] == "queued"
    session.expire_all()
    names = {j.id: j.k8s_name for j in session.scalars(select(Job))}
    assert make(batch).order("gpu-exclusive") == [names[b], names[a]]
