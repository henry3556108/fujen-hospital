from types import SimpleNamespace as NS

import pytest
from kubernetes.client import (V1Job, V1JobCondition, V1JobSpec, V1JobStatus, V1Node, V1NodeCondition,
                               V1NodeStatus, V1ObjectMeta, V1Pod, V1PodSpec, V1PodStatus, V1Container,
                               V1ResourceRequirements, V1PodTemplateSpec)
from kubernetes.client.exceptions import ApiException

from app.scheduling.backend import JobSpec, backend_from_env
from app.scheduling.kube import KubernetesJobBackend, build_job_manifest, job_state, node_info
from app.scheduling.states import JobStatus

LABELS = {"platform/project-id": "1", "platform/job-id": "9", "platform/training-id": "9", "platform/user": "ra01"}


def gpu_spec(**kw):
    base = dict(name="job-9-abc", queue="gpu-exclusive", pool="gpu-exclusive", gpus=1, duration_seconds=5,
                labels=LABELS, memory_mb=16)
    return JobSpec(**(base | kw))


def test_manifest_is_kueue_managed_and_labelled():
    m = build_job_manifest(gpu_spec(), namespace="platform-jobs", image="busybox:1.36")
    assert m["metadata"]["labels"]["kueue.x-k8s.io/queue-name"] == "gpu-exclusive"
    for key, value in LABELS.items():
        assert m["metadata"]["labels"][key] == value
        assert m["spec"]["template"]["metadata"]["labels"][key] == value
    assert m["spec"]["suspend"] is True and m["spec"]["backoffLimit"] == 0
    pod = m["spec"]["template"]["spec"]
    assert pod["nodeSelector"] == {"platform/pool": "gpu-exclusive"}
    assert pod["restartPolicy"] == "Never"
    res = pod["containers"][0]["resources"]
    assert res["limits"]["nvidia.com/gpu"] == "1" and res["requests"]["nvidia.com/gpu"] == "1"
    assert {"key": "nvidia.com/gpu", "operator": "Exists", "effect": "NoSchedule"} in pod["tolerations"]
    assert "activeDeadlineSeconds" not in m["spec"]


def test_manifest_fake_workload_allocates_memory_sleeps_and_can_fail():
    ok = build_job_manifest(gpu_spec(memory_mb=32, duration_seconds=7), namespace="n", image="busybox")
    script = ok["spec"]["template"]["spec"]["containers"][0]["command"][-1]
    assert "count=32" in script and "sleep 7" in script and script.endswith("exit 0")
    bad = build_job_manifest(gpu_spec(fail=True), namespace="n", image="busybox")
    assert bad["spec"]["template"]["spec"]["containers"][0]["command"][-1].endswith("exit 1")


def test_manifest_cpu_job_has_no_gpu_and_timeout_sets_deadline():
    m = build_job_manifest(gpu_spec(gpus=0, queue="cpu-data", pool="cpu-data", timeout_seconds=60),
                           namespace="n", image="busybox")
    pod = m["spec"]["template"]["spec"]
    assert "nvidia.com/gpu" not in pod["containers"][0]["resources"]["limits"]
    assert pod["nodeSelector"] == {"platform/pool": "cpu-data"}
    assert m["spec"]["activeDeadlineSeconds"] == 60


def job(*, suspend=False, active=0, ready=0, conditions=()):
    return V1Job(spec=V1JobSpec(template=V1PodTemplateSpec(), suspend=suspend),
                 status=V1JobStatus(active=active, ready=ready,
                                    conditions=[V1JobCondition(type=t, status="True", reason=r, message=m)
                                                for t, r, m in conditions]))


@pytest.mark.parametrize("obj,expected", [
    (job(suspend=True), JobStatus.QUEUED),
    (job(active=1, ready=0), JobStatus.QUEUED),
    (job(active=1, ready=1), JobStatus.RUNNING),
    (job(conditions=[("Complete", None, None)]), JobStatus.SUCCEEDED),
    (job(conditions=[("Failed", "BackoffLimitExceeded", "x")]), JobStatus.FAILED),
])
def test_job_state_mapping(obj, expected):
    assert job_state(obj)[0] == expected


def test_deadline_failure_message():
    state, message = job_state(job(conditions=[("Failed", "DeadlineExceeded", "x")]))
    assert state == JobStatus.FAILED and "時限" in message


def node(name, pool, *, gpus=None, physical=None, ready="True", real=False):
    labels = {"platform/pool": pool} if pool else {}
    if physical is not None:
        labels["platform/gpu-physical"] = str(physical)
    if real:
        labels["platform/gpu-source"] = "device-plugin"
    cap = {"cpu": "6"} | ({"nvidia.com/gpu": str(gpus)} if gpus is not None else {})
    return V1Node(metadata=V1ObjectMeta(name=name, labels=labels),
                  status=V1NodeStatus(capacity=cap, allocatable=cap,
                                      conditions=[V1NodeCondition(type="Ready", status=ready)]))


def test_node_info():
    info = node_info(node("w4", "gpu-shared", gpus=4, physical=1))
    assert (info.name, info.pool, info.ready, info.gpu_capacity, info.gpu_physical) == ("w4", "gpu-shared", True, 4, 1)
    plain = node_info(node("cp", None, ready="False"))
    assert (plain.pool, plain.ready, plain.gpu_capacity, plain.gpu_physical) == (None, False, 0, 0)
    assert not info.real_gpu and node_info(node("w4", "gpu-shared", gpus=4, physical=1, real=True)).real_gpu


def pod(name, node_name, started, *, gpus=1, labels=None):
    return V1Pod(metadata=V1ObjectMeta(name=f"{name}-pod", labels={"job-name": name} | (labels or {})),
                 spec=V1PodSpec(node_name=node_name, containers=[V1Container(
                     name="job", resources=V1ResourceRequirements(limits={"nvidia.com/gpu": str(gpus)} if gpus else {}))]),
                 status=V1PodStatus(phase="Running", start_time=started))


class FakeCore:
    def __init__(self, nodes=(), pods=()):
        self._nodes, self._pods, self.patched = list(nodes), list(pods), []

    def list_node(self, **kw):
        return NS(items=self._nodes)

    def list_namespaced_pod(self, namespace, label_selector=None, field_selector=None, **kw):
        items = self._pods
        if label_selector and label_selector.startswith("job-name="):
            items = [p for p in items if p.metadata.labels.get("job-name") == label_selector.split("=", 1)[1]]
        return NS(items=items)

    def patch_node_status(self, name, body):
        self.patched.append((name, body))

    def patch_namespaced_config_map(self, name, namespace, body):
        self.patched.append((f"configmap/{namespace}/{name}", body))


class FakeApps:
    def __init__(self):
        self.patched = []

    def patch_namespaced_daemon_set(self, name, namespace, body):
        self.patched.append((f"{namespace}/{name}", body))


class FakeBatch:
    def __init__(self):
        self.created, self.deleted, self.jobs = [], [], {}

    def create_namespaced_job(self, namespace, body):
        self.created.append(body)

    def read_namespaced_job(self, name, namespace):
        if name not in self.jobs:
            raise ApiException(status=404)
        return self.jobs[name]

    def delete_namespaced_job(self, name, namespace, propagation_policy=None):
        if name not in self.jobs:
            raise ApiException(status=404)
        self.deleted.append(name)


class FakeCustom:
    def __init__(self):
        self.cq = {"spec": {"resourceGroups": [{"coveredResources": ["cpu", "memory", "nvidia.com/gpu"],
                                                "flavors": [{"name": "gpu-shared", "resources": [
                                                    {"name": "cpu", "nominalQuota": "2"},
                                                    {"name": "nvidia.com/gpu", "nominalQuota": "4"}]}]}]}}
        self.patches = []

    def get_cluster_custom_object(self, group, version, plural, name):
        return self.cq

    def patch_cluster_custom_object(self, group, version, plural, name, body):
        self.patches.append((name, body))


def make_backend(core=None, batch=None, custom=None, clock=None, sleeps=None, apps=None):
    t = clock or [0.0]
    return KubernetesJobBackend(core=core or FakeCore(), batch=batch or FakeBatch(), custom=custom or FakeCustom(),
                                apps=apps or FakeApps(),
                                namespace="platform-jobs", image="busybox:1.36",
                                clock=lambda: t[0], sleep=(sleeps.append if sleeps is not None else lambda s: None))


def test_allocations_assign_gpu_index_and_slots_from_labels():
    from datetime import datetime, timedelta
    t0 = datetime(2026, 9, 28)
    nodes = [node("w3", "gpu-exclusive", gpus=2, physical=2), node("w4", "gpu-shared", gpus=4, physical=1)]
    pods = [pod("b", "w3", t0 + timedelta(seconds=5), labels=LABELS | {"platform/job-id": "2"}),
            pod("a", "w3", t0, labels=LABELS | {"platform/job-id": "1"}),
            pod("c", "w4", t0, labels=LABELS | {"platform/job-id": "3"}),
            pod("d", "w4", t0 + timedelta(seconds=1), labels=LABELS | {"platform/job-id": "4"}),
            pod("cpu", "w1", t0, gpus=0, labels=LABELS)]
    rows = make_backend(core=FakeCore(nodes, pods)).allocations()
    got = sorted((r.node, r.gpu_index, r.slot, r.job_name, r.labels["platform/job-id"]) for r in rows)
    assert got == [("w3", 0, 0, "a", "1"), ("w3", 1, 0, "b", "2"), ("w4", 0, 0, "c", "3"), ("w4", 0, 1, "d", "4")]


def test_submit_creates_job_and_spaces_same_queue_submissions():
    batch, sleeps, clock = FakeBatch(), [], [100.0]
    b = make_backend(batch=batch, clock=clock, sleeps=sleeps)
    b.submit(gpu_spec(name="j1"))
    clock[0] = 100.3
    b.submit(gpu_spec(name="j2"))
    b.submit(gpu_spec(name="s1", queue="gpu-shared", pool="gpu-shared"))
    assert [c["metadata"]["name"] for c in batch.created] == ["j1", "j2", "s1"]
    assert len(sleeps) == 1 and sleeps[0] == pytest.approx(0.75, abs=0.01)


def test_get_maps_state_and_node_and_missing_is_none():
    batch = FakeBatch()
    batch.jobs["j1"] = job(active=1, ready=1)
    core = FakeCore(pods=[pod("j1", "w3", None)])
    b = make_backend(core=core, batch=batch)
    got = b.get("j1")
    assert (got.state, got.node) == (JobStatus.RUNNING, "w3")
    assert b.get("nope") is None


def test_cancel_deletes_job_and_ignores_missing():
    batch = FakeBatch()
    batch.jobs["j1"] = job(suspend=True)
    b = make_backend(batch=batch)
    b.cancel("j1")
    b.cancel("gone")
    assert batch.deleted == ["j1"]


def test_configure_shared_patches_node_capacity_and_cluster_queue():
    core = FakeCore(nodes=[node("w4", "gpu-shared", gpus=4, physical=1), node("w3", "gpu-exclusive", gpus=2, physical=2)])
    custom = FakeCustom()
    make_backend(core=core, custom=custom).configure_shared(2)
    assert core.patched == [("w4", {"status": {"capacity": {"nvidia.com/gpu": "2"}}})]
    (name, body), = custom.patches
    gpu = body["spec"]["resourceGroups"][0]["flavors"][0]["resources"][1]
    assert name == "gpu-shared" and gpu == {"name": "nvidia.com/gpu", "nominalQuota": "2"}


def test_configure_shared_subtracts_resident_services():
    core = FakeCore(nodes=[node("w4", "gpu-shared", gpus=4, physical=1)])
    custom = FakeCustom()
    b = make_backend(core=core, custom=custom)
    b.shared_reserved = 2                    # 正式環境：Ollama 與 MONAI Label 各占一份
    b.configure_shared(4)
    assert core.patched == [("w4", {"status": {"capacity": {"nvidia.com/gpu": "4"}}})]
    quota = lambda: custom.patches[-1][1]["spec"]["resourceGroups"][0]["flavors"][0]["resources"][1]["nominalQuota"]
    assert quota() == "2"
    b.shared_reserved = 9
    b.configure_shared(4)
    assert quota() == "0"


def test_configure_shared_fake_gpu_nodes_do_not_touch_device_plugin():
    apps = FakeApps()
    core = FakeCore(nodes=[node("w4", "gpu-shared", gpus=4, physical=1)])
    make_backend(core=core, apps=apps).configure_shared(3)
    assert [name for name, _ in core.patched] == ["w4"] and apps.patched == []


def test_configure_shared_real_gpu_updates_device_plugin_config_and_restarts_it():
    import json
    apps, custom = FakeApps(), FakeCustom()
    core = FakeCore(nodes=[node("w4", "gpu-shared", gpus=4, physical=1, real=True),
                           node("w3", "gpu-exclusive", gpus=2, physical=2)])
    make_backend(core=core, custom=custom, apps=apps).configure_shared(2)
    (cm_name, cm_body), (node_name, node_body) = core.patched
    assert cm_name == "configmap/kube-system/nvdp-config"
    config = json.loads(cm_body["data"]["config.yaml"])
    assert config["sharing"]["timeSlicing"]["resources"] == [{"name": "nvidia.com/gpu", "replicas": 2}]
    # plugin 只在啟動時讀設定：改 Pod 範本註記讓 DaemonSet 重啟
    assert apps.patched == [("kube-system/nvidia-device-plugin-daemonset",
                             {"spec": {"template": {"metadata": {"annotations": {"platform/time-slice-replicas": "2"}}}}})]
    # 節點宣告與 Kueue 配額同步改成同一個數字（1 張 × 2 份）
    assert (node_name, node_body) == ("w4", {"status": {"capacity": {"nvidia.com/gpu": "2"}}})
    gpu = custom.patches[-1][1]["spec"]["resourceGroups"][0]["flavors"][0]["resources"][1]
    assert gpu["nominalQuota"] == "2"


def test_configure_shared_device_plugin_names_are_configurable():
    apps, core = FakeApps(), FakeCore(nodes=[node("g1", "gpu-shared", gpus=4, physical=1, real=True)])
    b = make_backend(core=core, apps=apps)
    b.gpu_plugin_config, b.gpu_plugin_daemonset = "gpu-operator/time-slicing", "gpu-operator/nvdp"
    b.configure_shared(4)
    assert core.patched[0][0] == "configmap/gpu-operator/time-slicing" and apps.patched[0][0] == "gpu-operator/nvdp"


def test_backend_from_env(monkeypatch):
    monkeypatch.setenv("JOB_BACKEND", "fake")
    assert type(backend_from_env()).__name__ == "FakeJobBackend"
    monkeypatch.delenv("JOB_BACKEND")
    assert backend_from_env() is None


# ---------- WP5b：真實工作（映像＋指令） ----------

def workload_spec(**kw):
    return gpu_spec(image="platform-trainer:dev", command=("python", "-m", "trainer.runner"), memory_mb=1024,
                    env=(("JOB_IO_TOKEN", "t"), ("JOB_IO_URL", "http://api:8000"), ("RUN_ID", "7")), **kw)


def test_tc_b05_05_workload_manifest_runs_image_and_command_without_credentials():
    m = build_job_manifest(workload_spec(), namespace="platform-jobs", image="busybox:1.36")
    pod = m["spec"]["template"]["spec"]
    container = pod["containers"][0]
    assert container["image"] == "platform-trainer:dev" and container["command"] == ["python", "-m", "trainer.runner"]
    assert container["imagePullPolicy"] == "IfNotPresent"
    # 容器拿到的環境變數只有提交者列舉的三個
    assert {e["name"] for e in container["env"]} == {"JOB_IO_TOKEN", "JOB_IO_URL", "RUN_ID"}
    assert all("valueFrom" not in e for e in container["env"]) and "envFrom" not in container
    # 不掛 ServiceAccount token、不注入叢集服務位址、沒有 Secret／ConfigMap／hostPath 掛載
    assert pod["automountServiceAccountToken"] is False and pod["enableServiceLinks"] is False
    assert "serviceAccountName" not in pod
    assert pod["volumes"] == [{"name": "work", "emptyDir": {}}]
    assert pod["securityContext"]["runAsNonRoot"] is True
    assert container["securityContext"] == {"allowPrivilegeEscalation": False, "capabilities": {"drop": ["ALL"]}}


def test_workload_manifest_keeps_kueue_queue_labels_gpu_and_deadline():
    m = build_job_manifest(workload_spec(timeout_seconds=90), namespace="platform-jobs", image="busybox:1.36")
    pod = m["spec"]["template"]["spec"]
    assert m["metadata"]["labels"]["kueue.x-k8s.io/queue-name"] == "gpu-exclusive" and m["spec"]["suspend"] is True
    assert m["spec"]["template"]["metadata"]["labels"] == LABELS
    assert pod["nodeSelector"] == {"platform/pool": "gpu-exclusive"}
    assert pod["containers"][0]["resources"]["limits"] == {"memory": "1024Mi", "nvidia.com/gpu": "1"}
    assert {"key": "nvidia.com/gpu", "operator": "Exists", "effect": "NoSchedule"} in pod["tolerations"]
    assert m["spec"]["activeDeadlineSeconds"] == 90 and m["spec"]["backoffLimit"] == 0


def _container_pod(name, *, running_at=None, terminated=None, start_time=None):
    from kubernetes.client import (V1ContainerState, V1ContainerStateRunning, V1ContainerStateTerminated,
                                   V1ContainerStatus)
    state = V1ContainerState(
        running=V1ContainerStateRunning(started_at=running_at) if running_at else None,
        terminated=V1ContainerStateTerminated(exit_code=0, started_at=terminated[0], finished_at=terminated[1])
        if terminated else None)
    p = pod(name, "w3", start_time)
    p.status.container_statuses = [V1ContainerStatus(name="job", image="i", image_id="", ready=True, restart_count=0,
                                                     state=state)]
    return p


def test_tc_c01_05_get_reports_container_start_and_job_completion_times():
    """畫面上的開始／結束時間要是叢集的實際時間，不是平台輪詢到的時間（TC-C01-05 比對佇列順序）。"""
    from datetime import datetime, timezone
    t = lambda s: datetime(2026, 10, 3, 18, 40, s, tzinfo=timezone.utc)  # noqa: E731
    batch = FakeBatch()
    running = job(active=1, ready=1)
    running.status.start_time = t(0)          # Job 物件建立（Kueue 放行前）不是開始時間
    batch.jobs["j1"] = running
    core = FakeCore(pods=[_container_pod("j1", running_at=t(4), start_time=t(1))])
    got = make_backend(core=core, batch=batch).get("j1")
    assert (got.state, got.started_at, got.finished_at) == (JobStatus.RUNNING, t(4), None)

    done = job(conditions=[("Complete", None, None)])
    done.status.completion_time = t(30)
    batch.jobs["j2"] = done
    core = FakeCore(pods=[_container_pod("j2", terminated=(t(5), t(29)), start_time=t(2))])
    got = make_backend(core=core, batch=batch).get("j2")
    assert (got.state, got.started_at, got.finished_at) == (JobStatus.SUCCEEDED, t(5), t(30))


def test_failed_job_finish_time_comes_from_the_failed_condition():
    from datetime import datetime, timezone
    when = datetime(2026, 10, 3, 18, 45, tzinfo=timezone.utc)
    failed = job(conditions=[("Failed", "DeadlineExceeded", "x")])
    failed.status.conditions[0].last_transition_time = when
    batch = FakeBatch()
    batch.jobs["j3"] = failed
    got = make_backend(core=FakeCore(pods=[]), batch=batch).get("j3")
    assert (got.state, got.started_at, got.finished_at) == (JobStatus.FAILED, None, when)
