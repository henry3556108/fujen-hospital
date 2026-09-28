import pytest

from app.scheduling.states import InvalidTransition, JobStatus, check_transition, path_to


@pytest.mark.parametrize("src,dst", [
    ("queued", "running"), ("queued", "cancelled"), ("queued", "failed"),
    ("running", "succeeded"), ("running", "failed"), ("running", "cancelled"),
])
def test_allowed_transitions(src, dst):
    check_transition(JobStatus(src), JobStatus(dst))


@pytest.mark.parametrize("src,dst", [
    ("queued", "succeeded"), ("running", "queued"), ("succeeded", "running"),
    ("failed", "running"), ("cancelled", "queued"), ("succeeded", "cancelled"), ("running", "running"),
])
def test_rejected_transitions(src, dst):
    with pytest.raises(InvalidTransition):
        check_transition(JobStatus(src), JobStatus(dst))


def test_sync_path_passes_through_running_when_backend_skipped_it():
    assert path_to(JobStatus.QUEUED, JobStatus.SUCCEEDED) == [JobStatus.RUNNING, JobStatus.SUCCEEDED]
    assert path_to(JobStatus.QUEUED, JobStatus.RUNNING) == [JobStatus.RUNNING]
    assert path_to(JobStatus.RUNNING, JobStatus.RUNNING) == []


def test_sync_path_never_leaves_terminal_state():
    with pytest.raises(InvalidTransition):
        path_to(JobStatus.CANCELLED, JobStatus.RUNNING)
    with pytest.raises(InvalidTransition):
        path_to(JobStatus.RUNNING, JobStatus.QUEUED)
