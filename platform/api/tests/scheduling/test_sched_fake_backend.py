from app.scheduling.backend import FakeJobBackend, JobSpec
from app.scheduling.states import JobStatus


def spec(name, pool="gpu-exclusive", *, gpus=1, duration=10, fail=False, labels=None):
    return JobSpec(name=name, queue=pool, pool=pool, gpus=gpus, duration_seconds=duration, fail=fail,
                   labels=labels or {"platform/job-id": name})


def states(backend, *names):
    return [backend.get(n).state for n in names]


def test_exclusive_pool_runs_one_job_per_gpu_in_fifo_order():
    b = FakeJobBackend()
    for n in ["a", "b", "c"]:
        b.submit(spec(n))
    assert states(b, "a", "b", "c") == [JobStatus.RUNNING, JobStatus.RUNNING, JobStatus.QUEUED]
    b.advance(10)
    assert states(b, "a", "b", "c") == [JobStatus.SUCCEEDED, JobStatus.SUCCEEDED, JobStatus.RUNNING]
    assert b.start_order() == ["a", "b", "c"]


def test_exclusive_gpu_holds_exactly_one_job():
    b = FakeJobBackend()
    b.submit(spec("a"))
    b.submit(spec("b"))
    rows = b.allocations()
    assert sorted((r.node, r.gpu_index, r.slot) for r in rows) == [("gpu-exclusive-1", 0, 0), ("gpu-exclusive-1", 1, 0)]


def test_shared_pool_runs_up_to_time_slice_replicas_concurrently():
    b = FakeJobBackend(time_slice_replicas=2)
    for n in ["a", "b", "c"]:
        b.submit(spec(n, "gpu-shared"))
    assert states(b, "a", "b", "c") == [JobStatus.RUNNING, JobStatus.RUNNING, JobStatus.QUEUED]
    assert {(r.gpu_index, r.slot) for r in b.allocations()} == {(0, 0), (0, 1)}
    b.configure_shared(4)
    assert b.get("c").state == JobStatus.RUNNING


def test_head_of_line_blocks_later_jobs_strict_fifo():
    b = FakeJobBackend()
    b.submit(spec("big", gpus=2, duration=5))
    b.submit(spec("x", gpus=2, duration=5))
    b.submit(spec("small", gpus=1, duration=5))
    assert states(b, "big", "x", "small") == [JobStatus.RUNNING, JobStatus.QUEUED, JobStatus.QUEUED]


def test_cancel_queued_job_and_failure_do_not_stall_queue():
    b = FakeJobBackend()
    b.submit(spec("long", duration=20))
    b.submit(spec("bad", duration=2, fail=True))
    b.submit(spec("cancel-me"))
    b.submit(spec("next"))
    b.cancel("cancel-me")
    assert b.get("cancel-me") is None
    b.advance(2)
    assert states(b, "bad", "next") == [JobStatus.FAILED, JobStatus.RUNNING]
    assert b.start_order() == ["long", "bad", "next"]


def test_cancel_running_job_frees_gpu():
    b = FakeJobBackend()
    for n in ["a", "b", "c"]:
        b.submit(spec(n))
    b.cancel("a")
    assert b.get("c").state == JobStatus.RUNNING


def test_timeout_fails_job():
    b = FakeJobBackend()
    b.submit(JobSpec(name="t", queue="gpu-shared", pool="gpu-shared", gpus=1, duration_seconds=100,
                     labels={}, timeout_seconds=30))
    b.advance(30)
    assert b.get("t").state == JobStatus.FAILED and "時限" in b.get("t").message


def test_cpu_jobs_run_on_their_pool_without_gpu():
    b = FakeJobBackend()
    b.submit(spec("clean", "cpu-data", gpus=0))
    assert b.get("clean").node == "cpu-data-1" and b.allocations() == []


def test_nodes_report_pool_and_gpus():
    b = FakeJobBackend()
    by_name = {n.name: n for n in b.nodes()}
    assert by_name["gpu-exclusive-1"].gpu_capacity == 2 and by_name["gpu-exclusive-1"].pool == "gpu-exclusive"
    assert by_name["gpu-shared-1"].gpu_capacity == 4 and by_name["gpu-shared-1"].gpu_physical == 1
    b.add_node("cpu-data-2", "cpu-data")
    assert "cpu-data-2" in {n.name for n in b.nodes()}


def test_allocation_carries_job_labels():
    b = FakeJobBackend()
    b.submit(spec("a", labels={"platform/project-id": "7", "platform/job-id": "3", "platform/user": "ra01"}))
    (row,) = b.allocations()
    assert row.labels["platform/project-id"] == "7" and row.job_name == "a"
