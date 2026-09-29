"""Kubernetes 後端：平台送出的每個工作都是一個由 Kueue 管理的 batch/v1 Job。

- Job 以 suspend=true 建立並帶 `kueue.x-k8s.io/queue-name`，由 Kueue 依 ClusterQueue 配額放行。
- Job 與 Pod 都帶平台標籤（project-id、job-id、training-id、user），GPU Dashboard 只讀這些標籤。
- Mac（kind）上的 GPU 是假的：節點以 status patch 宣告 `nvidia.com/gpu`，GPU 編號依開始時間推算；
  甲方環境改由 NVIDIA device plugin／DCGM 提供實際對應。
"""
import os
import threading
import time
from collections import defaultdict
from collections.abc import Callable

from app.scheduling.backend import (LABEL_GPU_PHYSICAL, LABEL_POOL, Allocation, BackendJob, JobSpec, NodeInfo,
                                    slot_position)
from app.scheduling.states import JobStatus

GPU = "nvidia.com/gpu"
QUEUE_LABEL = "kueue.x-k8s.io/queue-name"
KUEUE_GROUP, KUEUE_VERSION = "kueue.x-k8s.io", "v1beta2"
# Kueue 以 Workload 建立時間（秒級）排序；同一秒送出的工作可能被視為平手而亂序，
# 所以同一佇列的相鄰提交至少間隔這麼久，確保 FIFO 與提交順序一致。
SAME_QUEUE_GAP_SECONDS = 1.05


def _workload_pod(spec: JobSpec, tolerations: list, gpu: dict) -> dict:
    """真實工作的 Pod：不掛 ServiceAccount token、不注入叢集服務的環境變數、以非 root 執行。
    容器拿到的只有 spec.env（由提交者列舉），所以不會帶到任何平台憑證。"""
    limits = {"memory": f"{spec.memory_mb}Mi"} | gpu
    requests = {"cpu": spec.cpu_request, "memory": f"{max(spec.memory_mb // 2, 64)}Mi"} | gpu
    return {
        "restartPolicy": "Never",
        "automountServiceAccountToken": False,
        "enableServiceLinks": False,
        "nodeSelector": {LABEL_POOL: spec.pool},
        "tolerations": tolerations,
        "terminationGracePeriodSeconds": 5,
        "securityContext": {"runAsNonRoot": True, "runAsUser": 10001, "runAsGroup": 10001, "fsGroup": 10001},
        "containers": [{
            "name": "job", "image": spec.image, "imagePullPolicy": "IfNotPresent",
            "command": list(spec.command),
            "env": [{"name": k, "value": v} for k, v in spec.env],
            "resources": {"requests": requests, "limits": limits},
            "securityContext": {"allowPrivilegeEscalation": False, "capabilities": {"drop": ["ALL"]}},
            "volumeMounts": [{"name": "work", "mountPath": "/work"}],
        }],
        "volumes": [{"name": "work", "emptyDir": {}}],
    }


def build_job_manifest(spec: JobSpec, *, namespace: str, image: str) -> dict:
    if spec.command:
        gpu = {GPU: str(spec.gpus)} if spec.gpus else {}
        tolerations = [{"key": GPU, "operator": "Exists", "effect": "NoSchedule"}] if spec.gpus else []
        job_spec = {"suspend": True, "backoffLimit": 0, "ttlSecondsAfterFinished": 86400,
                    "template": {"metadata": {"labels": dict(spec.labels)},
                                 "spec": _workload_pod(spec, tolerations, gpu)}}
        if spec.timeout_seconds:
            job_spec["activeDeadlineSeconds"] = spec.timeout_seconds
        return {"apiVersion": "batch/v1", "kind": "Job",
                "metadata": {"name": spec.name, "namespace": namespace,
                             "labels": dict(spec.labels) | {QUEUE_LABEL: spec.queue, LABEL_POOL: spec.pool}},
                "spec": job_spec}
    # 假工作：在記憶體型 emptyDir 寫入 memory_mb 的資料（算進 Pod 記憶體），睡 duration 秒，再以 0 或 1 結束
    script = (f"dd if=/dev/zero of=/scratch/alloc bs=1M count={spec.memory_mb} 2>/dev/null; "
              f"sleep {spec.duration_seconds}; exit {1 if spec.fail else 0}")
    requests = {"cpu": "10m", "memory": f"{spec.memory_mb + 16}Mi"}
    limits = {"memory": f"{spec.memory_mb + 48}Mi"}
    tolerations = []
    if spec.gpus:
        requests[GPU] = limits[GPU] = str(spec.gpus)
        tolerations.append({"key": GPU, "operator": "Exists", "effect": "NoSchedule"})
    job_spec = {
        "suspend": True,
        "backoffLimit": 0,
        "ttlSecondsAfterFinished": 86400,
        "template": {
            "metadata": {"labels": dict(spec.labels)},
            "spec": {
                "restartPolicy": "Never",
                "nodeSelector": {LABEL_POOL: spec.pool},
                "tolerations": tolerations,
                "terminationGracePeriodSeconds": 1,
                "containers": [{
                    "name": "job", "image": image, "command": ["sh", "-c", script],
                    "resources": {"requests": requests, "limits": limits},
                    "volumeMounts": [{"name": "scratch", "mountPath": "/scratch"}],
                }],
                "volumes": [{"name": "scratch",
                             "emptyDir": {"medium": "Memory", "sizeLimit": f"{spec.memory_mb + 8}Mi"}}],
            },
        },
    }
    if spec.timeout_seconds:
        job_spec["activeDeadlineSeconds"] = spec.timeout_seconds
    return {
        "apiVersion": "batch/v1", "kind": "Job",
        "metadata": {"name": spec.name, "namespace": namespace,
                     "labels": dict(spec.labels) | {QUEUE_LABEL: spec.queue, LABEL_POOL: spec.pool}},
        "spec": job_spec,
    }


def job_state(job) -> tuple[JobStatus, str]:
    status = job.status
    for cond in (status.conditions or []) if status else []:
        if cond.status != "True":
            continue
        if cond.type == "Complete":
            return JobStatus.SUCCEEDED, ""
        if cond.type == "Failed":
            if cond.reason == "DeadlineExceeded":
                return JobStatus.FAILED, "超過執行時限"
            return JobStatus.FAILED, f"工作失敗：{cond.reason or ''}".strip("：")
    if job.spec.suspend:
        return JobStatus.QUEUED, ""
    # Kueue 已放行但容器還沒起來（拉映像、排程中）仍算排隊；有 Pod ready 才算執行
    if status and (status.ready or 0) >= 1:
        return JobStatus.RUNNING, ""
    return JobStatus.QUEUED, ""


def _qty(value) -> int:
    try:
        return int(str(value))
    except (TypeError, ValueError):
        return 0


def node_info(node) -> NodeInfo:
    labels = node.metadata.labels or {}
    ready = any(c.type == "Ready" and c.status == "True" for c in (node.status.conditions or []))
    capacity = node.status.capacity or {}
    allocatable = node.status.allocatable or {}
    return NodeInfo(name=node.metadata.name, pool=labels.get(LABEL_POOL), ready=ready,
                    gpu_capacity=_qty(capacity.get(GPU)), gpu_allocatable=_qty(allocatable.get(GPU)),
                    gpu_physical=_qty(labels.get(LABEL_GPU_PHYSICAL)))


def _pod_gpus(pod) -> int:
    return sum(_qty((c.resources.limits or {}).get(GPU)) for c in pod.spec.containers if c.resources)


class KubernetesJobBackend:
    def __init__(self, *, core, batch, custom, namespace: str, image: str,
                 clock: Callable[[], float] = time.monotonic, sleep: Callable[[float], None] = time.sleep):
        self.core, self.batch, self.custom = core, batch, custom
        self.namespace, self.image = namespace, image
        self._clock, self._sleep = clock, sleep
        self._last_submit: dict[str, float] = {}
        self._lock = threading.Lock()

    @classmethod
    def from_env(cls) -> "KubernetesJobBackend":
        from kubernetes import client, config

        try:
            config.load_incluster_config()
        except config.ConfigException:
            config.load_kube_config(context=os.environ.get("KUBE_CONTEXT") or None)
        return cls(core=client.CoreV1Api(), batch=client.BatchV1Api(), custom=client.CustomObjectsApi(),
                   namespace=os.environ.get("JOB_NAMESPACE", "platform-jobs"),
                   image=os.environ.get("JOB_IMAGE", "busybox:1.36"))

    # --- JobBackend ---
    def submit(self, spec: JobSpec) -> None:
        with self._lock:
            last = self._last_submit.get(spec.queue)
            if last is not None:
                wait = SAME_QUEUE_GAP_SECONDS - (self._clock() - last)
                if wait > 0:
                    self._sleep(wait)
            self.batch.create_namespaced_job(self.namespace, build_job_manifest(
                spec, namespace=self.namespace, image=self.image))
            self._last_submit[spec.queue] = self._clock()

    def get(self, name: str) -> BackendJob | None:
        from kubernetes.client.exceptions import ApiException

        try:
            job = self.batch.read_namespaced_job(name, self.namespace)
        except ApiException as exc:
            if exc.status == 404:
                return None
            raise
        state, message = job_state(job)
        pods = self.core.list_namespaced_pod(self.namespace, label_selector=f"job-name={name}").items
        node = next((p.spec.node_name for p in pods if p.spec and p.spec.node_name), None)
        return BackendJob(state=state, node=node, message=message)

    def cancel(self, name: str) -> None:
        from kubernetes.client.exceptions import ApiException

        try:
            self.batch.delete_namespaced_job(name, self.namespace, propagation_policy="Background")
        except ApiException as exc:
            if exc.status != 404:
                raise

    def nodes(self) -> list[NodeInfo]:
        return [node_info(n) for n in self.core.list_node().items]

    def allocations(self) -> list[Allocation]:
        nodes = {n.name: n for n in self.nodes()}
        pods = self.core.list_namespaced_pod(self.namespace, label_selector="platform/job-id",
                                             field_selector="status.phase=Running").items
        by_node = defaultdict(list)
        for p in pods:
            if p.status.phase == "Running" and _pod_gpus(p) and p.spec.node_name in nodes:
                by_node[p.spec.node_name].append(p)
        rows = []
        for node_name, node_pods in by_node.items():
            info = nodes[node_name]
            next_slot = 0
            for p in sorted(node_pods, key=lambda p: (p.status.start_time is None, p.status.start_time or 0,
                                                      p.metadata.name)):
                labels = p.metadata.labels or {}
                for _ in range(_pod_gpus(p)):
                    gpu_index, time_slice = slot_position(next_slot, info.gpu_physical or 1,
                                                          info.gpu_capacity or 1)
                    rows.append(Allocation(node=node_name, gpu_index=gpu_index, slot=time_slice,
                                           job_name=labels.get("job-name", p.metadata.name),
                                           labels={k: v for k, v in labels.items() if k.startswith("platform/")}))
                    next_slot += 1
        return rows

    def configure_shared(self, replicas: int) -> None:
        # 等同甲方的 NVIDIA time-slicing replicas：節點宣告的 GPU 份數與 ClusterQueue 配額一起改
        for n in self.nodes():
            if n.pool == "gpu-shared":
                physical = n.gpu_physical or 1
                self.core.patch_node_status(n.name, {"status": {"capacity": {GPU: str(physical * replicas)}}})
        cq = self.custom.get_cluster_custom_object(KUEUE_GROUP, KUEUE_VERSION, "clusterqueues", "gpu-shared")
        groups = cq["spec"]["resourceGroups"]
        total = sum(max(1, n.gpu_physical) for n in self.nodes() if n.pool == "gpu-shared") * replicas
        for group in groups:
            for flavor in group["flavors"]:
                for resource in flavor["resources"]:
                    if resource["name"] == GPU:
                        resource["nominalQuota"] = str(total)
        self.custom.patch_cluster_custom_object(KUEUE_GROUP, KUEUE_VERSION, "clusterqueues", "gpu-shared",
                                                {"spec": {"resourceGroups": groups}})
