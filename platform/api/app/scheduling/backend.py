"""工作後端介面。平台 API 只經由這個介面送出、查詢、取消工作。

- FakeJobBackend：記憶體版、時間由測試推進，語意與 Kueue 設定相同（StrictFIFO、獨占一卡一件、共享池時間片）。
- KubernetesJobBackend（kube.py）：建立 Kueue 管理的 Kubernetes Job。
"""
import os
from dataclasses import dataclass, field
from typing import Protocol

from app.scheduling.states import JobStatus

LABEL_POOL = "platform/pool"
LABEL_GPU_PHYSICAL = "platform/gpu-physical"


@dataclass(frozen=True)
class JobSpec:
    name: str                 # Kubernetes Job 名稱（全域唯一）
    queue: str                # Kueue LocalQueue
    pool: str                 # 節點池（nodeSelector platform/pool）
    gpus: int                 # 0 表示純 CPU 工作
    duration_seconds: int
    labels: dict[str, str]
    fail: bool = False        # 假工作：跑完後以非 0 結束
    memory_mb: int = 16       # 假工作：配置的記憶體量
    timeout_seconds: int | None = None
    # 真實工作（WP5b 訓練）：指定映像與指令時不再產生假工作的 sleep 指令稿
    image: str | None = None
    command: tuple[str, ...] | None = None
    env: tuple[tuple[str, str], ...] = ()
    cpu_request: str = "10m"


@dataclass(frozen=True)
class Workload:
    """要在 Job 容器內執行的真實工作。env 只能放這一次工作需要的值，不可放任何平台憑證。"""
    image: str
    command: tuple[str, ...]
    env: dict[str, str] = field(default_factory=dict)
    memory_mb: int = 1024
    cpu_request: str = "250m"
    expected_seconds: int = 60          # 記憶體版後端用來推進時間；Kubernetes 後端不使用
    training_id: int | None = None      # 標籤 platform/training-id（GPU Dashboard 顯示）


@dataclass(frozen=True)
class BackendJob:
    state: JobStatus          # 只會是 queued／running／succeeded／failed；被取消的工作查不到（None）
    node: str | None = None
    message: str = ""


@dataclass(frozen=True)
class NodeInfo:
    name: str
    pool: str | None
    ready: bool
    gpu_capacity: int = 0     # 可排程的 GPU 份數（共享池 = 實體張數 × 時間片份數）
    gpu_allocatable: int = 0
    gpu_physical: int = 0


@dataclass(frozen=True)
class Allocation:
    node: str
    gpu_index: int            # 實體 GPU 編號
    slot: int                 # 該卡上的時間片序號（獨占池恆為 0）
    job_name: str
    labels: dict[str, str]


class JobBackend(Protocol):
    def submit(self, spec: JobSpec) -> None: ...
    def get(self, name: str) -> BackendJob | None: ...
    def cancel(self, name: str) -> None: ...
    def nodes(self) -> list[NodeInfo]: ...
    def allocations(self) -> list[Allocation]: ...
    def configure_shared(self, replicas: int) -> None: ...


def backend_from_env() -> JobBackend | None:
    """依 JOB_BACKEND 建立後端：kubernetes（kind／甲方叢集）或 fake（前端開發用）；未設定回 None。"""
    kind = os.environ.get("JOB_BACKEND", "").strip().lower()
    if kind == "kubernetes":
        from app.scheduling.kube import KubernetesJobBackend
        return KubernetesJobBackend.from_env()
    if kind == "fake":
        return FakeJobBackend()
    return None


def slot_position(slot: int, physical: int, capacity: int) -> tuple[int, int]:
    """第 slot 份 GPU 落在哪張實體卡的第幾個時間片。"""
    replicas = max(1, capacity // max(1, physical))
    return slot // replicas, slot % replicas


@dataclass
class _FakeJob:
    spec: JobSpec
    state: JobStatus = JobStatus.QUEUED
    node: str | None = None
    slots: list[int] = field(default_factory=list)
    ends_at: float | None = None
    message: str = ""


@dataclass
class _FakeNode:
    name: str
    pool: str
    physical: int = 0
    capacity: int = 0          # GPU 份數；CPU 節點以 cpu_slots 限制併行
    cpu_slots: int = 8


class FakeJobBackend:
    def __init__(self, *, time_slice_replicas: int = 4):
        self.now = 0.0
        self._jobs: dict[str, _FakeJob] = {}
        self._queue: list[str] = []      # 提交順序
        self._started: list[str] = []
        self._nodes = [
            _FakeNode("ai-platform-control-plane", ""),
            _FakeNode("cpu-web-1", "cpu-web"),
            _FakeNode("cpu-data-1", "cpu-data"),
            _FakeNode("gpu-exclusive-1", "gpu-exclusive", physical=2, capacity=2),
            _FakeNode("gpu-shared-1", "gpu-shared", physical=1, capacity=time_slice_replicas),
        ]

    # --- 測試用控制 ---
    def advance(self, seconds: float) -> None:
        target = self.now + seconds
        while True:
            running = [j for j in self._jobs.values() if j.state == JobStatus.RUNNING and j.ends_at <= target]
            if not running:
                break
            first = min(running, key=lambda j: j.ends_at)
            self.now = first.ends_at
            self._finish(first)
            self._schedule()
        self.now = target
        self._schedule()

    def start_order(self) -> list[str]:
        return list(self._started)

    def add_node(self, name: str, pool: str, *, gpus: int = 0) -> None:
        self._nodes.append(_FakeNode(name, pool, physical=gpus, capacity=gpus))

    # --- JobBackend ---
    def submit(self, spec: JobSpec) -> None:
        self._jobs[spec.name] = _FakeJob(spec)
        self._queue.append(spec.name)
        self._schedule()

    def get(self, name: str) -> BackendJob | None:
        job = self._jobs.get(name)
        if job is None:
            return None
        return BackendJob(state=job.state, node=job.node, message=job.message)

    def cancel(self, name: str) -> None:
        job = self._jobs.pop(name, None)
        if job and name in self._queue:
            self._queue.remove(name)
        self._schedule()

    def nodes(self) -> list[NodeInfo]:
        return [NodeInfo(name=n.name, pool=n.pool or None, ready=True, gpu_capacity=n.capacity,
                         gpu_allocatable=n.capacity, gpu_physical=n.physical) for n in self._nodes]

    def allocations(self) -> list[Allocation]:
        rows = []
        for job in self._jobs.values():
            if job.state != JobStatus.RUNNING or not job.spec.gpus:
                continue
            node = self._node(job.node)
            for slot in job.slots:
                gpu_index, time_slice = slot_position(slot, node.physical, node.capacity)
                rows.append(Allocation(node=node.name, gpu_index=gpu_index, slot=time_slice,
                                       job_name=job.spec.name, labels=dict(job.spec.labels)))
        return rows

    def configure_shared(self, replicas: int) -> None:
        for node in self._nodes:
            if node.pool == "gpu-shared":
                node.capacity = node.physical * replicas
        self._schedule()

    # --- 內部 ---
    def _node(self, name: str) -> _FakeNode:
        return next(n for n in self._nodes if n.name == name)

    def _used(self, node: _FakeNode) -> set[int]:
        return {s for j in self._jobs.values() if j.state == JobStatus.RUNNING and j.node == node.name for s in j.slots}

    def _cpu_used(self, node: _FakeNode) -> int:
        return sum(1 for j in self._jobs.values() if j.state == JobStatus.RUNNING and j.node == node.name)

    def _place(self, job: _FakeJob) -> bool:
        for node in (n for n in self._nodes if n.pool == job.spec.pool):
            if job.spec.gpus:
                free = [s for s in range(node.capacity) if s not in self._used(node)]
                if len(free) >= job.spec.gpus:
                    job.slots = free[: job.spec.gpus]
                    job.node = node.name
                    return True
            elif self._cpu_used(node) < node.cpu_slots:
                job.node = node.name
                return True
        return False

    def _schedule(self) -> None:
        # StrictFIFO：每個佇列只看排頭，排頭放不下時後面的也不能插隊
        for queue in {self._jobs[n].spec.queue for n in self._queue}:
            for name in [n for n in self._queue if self._jobs[n].spec.queue == queue]:
                job = self._jobs[name]
                if not self._place(job):
                    break
                self._queue.remove(name)
                job.state = JobStatus.RUNNING
                timeout = job.spec.timeout_seconds
                runtime = job.spec.duration_seconds if not timeout else min(job.spec.duration_seconds, timeout)
                job.ends_at = self.now + runtime
                self._started.append(name)

    def _finish(self, job: _FakeJob) -> None:
        timeout = job.spec.timeout_seconds
        if timeout and job.spec.duration_seconds > timeout:
            job.state, job.message = JobStatus.FAILED, "超過執行時限"
        elif job.spec.fail:
            job.state, job.message = JobStatus.FAILED, "工作以非 0 結束"
        else:
            job.state = JobStatus.SUCCEEDED
        job.slots = []
