"""Kubernetes 後端：平台送出的每個工作都是一個由 Kueue 管理的 batch/v1 Job。

- Job 以 suspend=true 建立並帶 `kueue.x-k8s.io/queue-name`，由 Kueue 依 ClusterQueue 配額放行。
- Job 與 Pod 都帶平台標籤（project-id、job-id、training-id、user），GPU Dashboard 只讀這些標籤。
- Mac（kind）上的 GPU 是假的：節點以 status patch 宣告 `nvidia.com/gpu`，GPU 編號依開始時間推算；
  甲方環境改由 NVIDIA device plugin／DCGM 提供實際對應。
- 調整順序與暫存：ClusterQueue 是 StrictFIFO、沒有優先權，Kueue 依 Workload 建立時間放行。
  所以「移到後面」＝刪掉還在等待（suspend）的 Job，以新名稱照原定義重建（新的建立時間排在最後）。
  刪除時帶 resourceVersion 前置條件：Job 一旦被 Kueue 放行（解除 suspend）就刪不掉，不會誤刪即將執行的工作。
"""
import copy
import json
import os
import threading
import time
from collections import defaultdict
from collections.abc import Callable

from app.scheduling.backend import (LABEL_GPU_PHYSICAL, LABEL_GPU_SOURCE, LABEL_POOL, Allocation, BackendJob, JobSpec, NodeInfo,
                                    NotWaiting, PartialReorder, slot_position)
from app.scheduling.states import JobStatus

GPU = "nvidia.com/gpu"
QUEUE_LABEL = "kueue.x-k8s.io/queue-name"
KUEUE_GROUP, KUEUE_VERSION = "kueue.x-k8s.io", "v1beta2"
# Kueue 以 Workload 建立時間（秒級）排序；同一秒送出的工作可能被視為平手而亂序，
# 所以同一佇列的相鄰提交至少間隔這麼久，確保 FIFO 與提交順序一致。
SAME_QUEUE_GAP_SECONDS = 1.05
# Job controller 產生的標籤與 selector：重建時要拿掉，否則新 Job 會被拒絕（selector 對不上新的 uid）
GENERATED_LABELS = frozenset({"controller-uid", "job-name", "batch.kubernetes.io/controller-uid",
                              "batch.kubernetes.io/job-name"})
# 真 GPU 節點（platform/gpu-source=device-plugin）的時間片設定：platform/deploy/kind/gpu/ 的 ConfigMap 與 DaemonSet
DEVICE_PLUGIN_CONFIG = "kube-system/nvdp-config"
DEVICE_PLUGIN_DAEMONSET = "kube-system/nvidia-device-plugin-daemonset"
DEVICE_PLUGIN_CONFIG_KEY = "config.yaml"
REPLICAS_ANNOTATION = "platform/time-slice-replicas"

_serializer = None


def _as_dict(obj) -> dict:
    global _serializer
    if isinstance(obj, dict):
        return copy.deepcopy(obj)
    if _serializer is None:
        from kubernetes.client import ApiClient
        _serializer = ApiClient()
    return _serializer.sanitize_for_serialization(obj)


def portable_manifest(job) -> dict:
    """把讀回來的 Job 變成可以重新建立的定義：去掉伺服器設定的中繼資料、狀態、自動產生的 selector 與標籤。
    平台標籤（platform/job-id 等）與 Kueue 佇列標籤保留，GPU Dashboard 與訓練同步不受影響。"""
    data = _as_dict(job)
    meta = data.get("metadata") or {}
    spec = copy.deepcopy(data["spec"])
    spec.pop("selector", None)
    spec.pop("manualSelector", None)
    spec["suspend"] = True
    template_meta = spec.setdefault("template", {}).setdefault("metadata", {})
    template_meta.pop("creationTimestamp", None)
    template_meta["labels"] = {k: v for k, v in (template_meta.get("labels") or {}).items()
                               if k not in GENERATED_LABELS}
    out_meta = {"labels": {k: v for k, v in (meta.get("labels") or {}).items() if k not in GENERATED_LABELS}}
    if meta.get("annotations"):
        out_meta["annotations"] = dict(meta["annotations"])
    return {"apiVersion": "batch/v1", "kind": "Job", "metadata": out_meta, "spec": spec}


def _finished(job) -> bool:
    return any(c.status == "True" and c.type in ("Complete", "Failed")
               for c in ((job.status.conditions or []) if job.status else []))


def is_waiting(job) -> bool:
    """還在佇列裡等待：Job 仍是 suspend（Kueue 尚未放行）且沒有結束。"""
    return bool(job.spec.suspend) and not _finished(job)


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


def job_times(job, pods) -> tuple["datetime | None", "datetime | None"]:
    """叢集實際的開始與結束時間。開始＝最早的容器啟動時間（Kueue 放行、映像拉完之後，與「執行中」一致），
    沒有容器狀態時用 Pod 的 start_time；結束＝Job 的 completion_time 或 Failed 條件的時間，沒有就用容器結束時間。"""
    starts, ends = [], []
    for p in pods:
        statuses = (p.status.container_statuses or []) if p.status else []
        for c in statuses:
            state = c.state
            if state and state.running and state.running.started_at:
                starts.append(state.running.started_at)
            if state and state.terminated:
                if state.terminated.started_at:
                    starts.append(state.terminated.started_at)
                if state.terminated.finished_at:
                    ends.append(state.terminated.finished_at)
        if not statuses and p.status and p.status.start_time:
            starts.append(p.status.start_time)
    status = job.status
    finished = status.completion_time if status else None
    if finished is None and status:
        failed = [c.last_transition_time for c in (status.conditions or [])
                  if c.type == "Failed" and c.status == "True" and c.last_transition_time]
        finished = failed[0] if failed else None
    if finished is None and ends and job_state(job)[0] in (JobStatus.SUCCEEDED, JobStatus.FAILED):
        finished = max(ends)
    return (min(starts) if starts else None), finished


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
                    gpu_physical=_qty(labels.get(LABEL_GPU_PHYSICAL)),
                    real_gpu=labels.get(LABEL_GPU_SOURCE) == "device-plugin")


def _pod_gpus(pod) -> int:
    return sum(_qty((c.resources.limits or {}).get(GPU)) for c in pod.spec.containers if c.resources)


class KubernetesJobBackend:
    def __init__(self, *, core, batch, custom, namespace: str, image: str, shared_reserved: int = 0,
                 clock: Callable[[], float] = time.monotonic, sleep: Callable[[float], None] = time.sleep,
                 apps=None, gpu_plugin_config: str = DEVICE_PLUGIN_CONFIG,
                 gpu_plugin_daemonset: str = DEVICE_PLUGIN_DAEMONSET):
        self.core, self.batch, self.custom, self.apps = core, batch, custom, apps
        # 真 GPU 節點的時間片份數：NVIDIA device plugin 的設定 ConfigMap 與 DaemonSet（<namespace>/<名稱>）
        self.gpu_plugin_config, self.gpu_plugin_daemonset = gpu_plugin_config, gpu_plugin_daemonset
        self.namespace, self.image = namespace, image
        # 共享池裡不經 Kueue 的常駐服務（正式環境的 Ollama、MONAI Label）占用的份數，從配額扣掉
        self.shared_reserved = shared_reserved
        self._clock, self._sleep = clock, sleep
        self._last_submit: dict[str, float] = {}
        self._lock = threading.RLock()

    @classmethod
    def from_env(cls) -> "KubernetesJobBackend":
        from kubernetes import client, config

        try:
            config.load_incluster_config()
        except config.ConfigException:
            config.load_kube_config(context=os.environ.get("KUBE_CONTEXT") or None)
        return cls(core=client.CoreV1Api(), batch=client.BatchV1Api(), custom=client.CustomObjectsApi(),
                   apps=client.AppsV1Api(),
                   namespace=os.environ.get("JOB_NAMESPACE", "platform-jobs"),
                   image=os.environ.get("JOB_IMAGE", "busybox:1.36"),
                   shared_reserved=int(os.environ.get("GPU_SHARED_RESERVED", "0")),
                   gpu_plugin_config=os.environ.get("GPU_PLUGIN_CONFIG", DEVICE_PLUGIN_CONFIG),
                   gpu_plugin_daemonset=os.environ.get("GPU_PLUGIN_DAEMONSET", DEVICE_PLUGIN_DAEMONSET))

    # --- JobBackend ---
    def submit(self, spec: JobSpec) -> None:
        self._create(spec.queue, build_job_manifest(spec, namespace=self.namespace, image=self.image))

    def _create(self, queue: str, manifest: dict) -> None:
        with self._lock:
            last = self._last_submit.get(queue)
            if last is not None:
                wait = SAME_QUEUE_GAP_SECONDS - (self._clock() - last)
                if wait > 0:
                    self._sleep(wait)
            self.batch.create_namespaced_job(self.namespace, manifest)
            self._last_submit[queue] = self._clock()

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
        started, finished = job_times(job, pods)
        return BackendJob(state=state, node=node, message=message, started_at=started, finished_at=finished,
                          waiting=is_waiting(job))

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
        shared = [n for n in self.nodes() if n.pool == "gpu-shared"]
        if any(n.real_gpu for n in shared):
            # 真 GPU 節點的份數由 device plugin 回報：改它的 time-slicing 設定並重啟 plugin，否則 kubelet 會把份數改回去
            self._configure_device_plugin(replicas)
        for n in shared:
            physical = n.gpu_physical or 1
            # 真 GPU 節點也先改節點宣告，讓畫面與 Kueue 立即一致；plugin 重新註冊後 kubelet 回報的是同一個數字
            self.core.patch_node_status(n.name, {"status": {"capacity": {GPU: str(physical * replicas)}}})
        cq = self.custom.get_cluster_custom_object(KUEUE_GROUP, KUEUE_VERSION, "clusterqueues", "gpu-shared")
        groups = cq["spec"]["resourceGroups"]
        total = sum(max(1, n.gpu_physical) for n in self.nodes() if n.pool == "gpu-shared") * replicas
        total = max(0, total - self.shared_reserved)
        for group in groups:
            for flavor in group["flavors"]:
                for resource in flavor["resources"]:
                    if resource["name"] == GPU:
                        resource["nominalQuota"] = str(total)
        self.custom.patch_cluster_custom_object(KUEUE_GROUP, KUEUE_VERSION, "clusterqueues", "gpu-shared",
                                                {"spec": {"resourceGroups": groups}})

    def _configure_device_plugin(self, replicas: int) -> None:
        """改 NVIDIA device plugin 的 time-slicing 份數（ConfigMap），再以 Pod 範本註記觸發 DaemonSet 重啟。
        plugin 只在啟動時讀設定；重啟後向 kubelet 重新註冊，節點份數約 10–20 秒後由 kubelet 回報為新值。"""
        cm_ns, cm_name = self.gpu_plugin_config.split("/", 1)
        ds_ns, ds_name = self.gpu_plugin_daemonset.split("/", 1)
        # JSON 也是合法的 YAML；kind 的設定只有 time-slicing 這一項（platform/deploy/kind/gpu/time-slicing.yaml）
        config = {"version": "v1", "sharing": {"timeSlicing": {"resources": [{"name": GPU, "replicas": replicas}]}}}
        self.core.patch_namespaced_config_map(cm_name, cm_ns,
                                              {"data": {DEVICE_PLUGIN_CONFIG_KEY: json.dumps(config, indent=2)}})
        if self.apps is None:   # 沒有另外給：沿用 core 的連線設定（例如以 new_client_from_config 指定 context）
            from kubernetes import client
            self.apps = client.AppsV1Api(getattr(self.core, "api_client", None))
        self.apps.patch_namespaced_daemon_set(
            ds_name, ds_ns,
            {"spec": {"template": {"metadata": {"annotations": {REPLICAS_ANNOTATION: str(replicas)}}}}})

    # --- 佇列順序與暫存 ---
    def order(self, queue: str) -> list[str]:
        """佇列中等待的 Job，依 Kueue 放行的先後（建立時間，同時間再比名稱）。"""
        jobs = self.batch.list_namespaced_job(self.namespace, label_selector=f"{QUEUE_LABEL}={queue}").items
        waiting = [j for j in jobs if is_waiting(j)]
        waiting.sort(key=lambda j: (j.metadata.creation_timestamp is None, j.metadata.creation_timestamp or 0,
                                    j.metadata.name))
        return [j.metadata.name for j in waiting]

    def _read_waiting(self, name: str):
        from kubernetes.client.exceptions import ApiException

        try:
            job = self.batch.read_namespaced_job(name, self.namespace)
        except ApiException as exc:
            if exc.status == 404:
                raise NotWaiting(name) from exc
            raise
        if not is_waiting(job):
            raise NotWaiting(name)
        return job

    def _delete_waiting(self, name: str, job):
        """只在 Job 仍在等待時刪除（resourceVersion 前置條件）。回傳刪除當下的 Job（定義以它為準）。"""
        from kubernetes.client.exceptions import ApiException

        for _ in range(3):
            body = {"propagationPolicy": "Background",
                    "preconditions": {"resourceVersion": job.metadata.resource_version}}
            try:
                self.batch.delete_namespaced_job(name, self.namespace, body=body)
                return job
            except ApiException as exc:
                if exc.status == 404:
                    raise NotWaiting(name) from exc
                if exc.status != 409:
                    raise
            job = self._read_waiting(name)   # 讀取後被改過（例如 Kueue 放行）：還在等待就再試
        raise NotWaiting(name)

    def _manifest(self, job, name: str) -> dict:
        manifest = portable_manifest(job)
        manifest["metadata"] |= {"name": name, "namespace": self.namespace}
        return manifest

    def reorder(self, moves: list[tuple[str, str]]) -> None:
        """moves 依新的順序排列 (舊名稱, 新名稱)。先確認全部仍在等待，再依目前的先後刪除（排頭最可能被放行，先處理），
        最後依新順序重建、相鄰間隔 SAME_QUEUE_GAP_SECONDS。中途有工作被放行：已刪除的照新順序重建（排到最後）
        並拋出 NotWaiting，moved 說明哪些已移動。"""
        with self._lock:
            jobs = {old: self._read_waiting(old) for old, _ in moves}
            current = sorted(jobs, key=lambda n: (jobs[n].metadata.creation_timestamp is None,
                                                  jobs[n].metadata.creation_timestamp or 0, n))
            deleted: dict[str, object] = {}
            blocked = None
            for old in current:
                try:
                    deleted[old] = self._delete_waiting(old, jobs[old])
                except NotWaiting as exc:
                    blocked = exc.name
                    break
            moved: dict[str, str] = {}
            pending = [(old, new) for old, new in moves if old in deleted]
            for i, (old, new) in enumerate(pending):
                job = deleted[old]
                try:
                    self._create(job.metadata.labels.get(QUEUE_LABEL, ""), self._manifest(job, new))
                except Exception as exc:
                    unplaced = {o: portable_manifest(deleted[o]) for o, _ in pending[i:]}
                    raise PartialReorder(exc, moved, unplaced) from exc
                moved[old] = new
            if blocked is not None:
                raise NotWaiting(blocked, moved)

    def hold(self, name: str) -> dict:
        with self._lock:
            job = self._delete_waiting(name, self._read_waiting(name))
        return portable_manifest(job)

    def restore(self, manifest: dict, name: str) -> None:
        body = copy.deepcopy(manifest)
        body["metadata"] = dict(body.get("metadata") or {}, name=name, namespace=self.namespace)
        body["spec"]["suspend"] = True
        self._create((body["metadata"].get("labels") or {}).get(QUEUE_LABEL, ""), body)
