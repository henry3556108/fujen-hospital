from enum import StrEnum


class JobStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"
    HELD = "held"             # 暫存：排隊中的工作移出佇列、保存定義，稍後再恢復排隊


TERMINAL = frozenset({JobStatus.SUCCEEDED, JobStatus.FAILED, JobStatus.CANCELLED})

_ALLOWED: dict[JobStatus, frozenset[JobStatus]] = {
    # 排隊中也可能直接失敗（例如映像拉不到、超過時限）
    JobStatus.QUEUED: frozenset({JobStatus.RUNNING, JobStatus.CANCELLED, JobStatus.FAILED, JobStatus.HELD}),
    # 暫存中的工作不在叢集裡，只能恢復排隊或取消
    JobStatus.HELD: frozenset({JobStatus.QUEUED, JobStatus.CANCELLED}),
    JobStatus.RUNNING: frozenset({JobStatus.SUCCEEDED, JobStatus.FAILED, JobStatus.CANCELLED}),
}


class InvalidTransition(Exception):
    pass


def check_transition(src: JobStatus, dst: JobStatus) -> None:
    if dst not in _ALLOWED.get(src, frozenset()):
        raise InvalidTransition(f"工作狀態不可從 {src.value} 變成 {dst.value}")


def path_to(src: JobStatus, dst: JobStatus) -> list[JobStatus]:
    """把後端回報的狀態換成一串合法轉換。輪詢可能錯過短暫的 running，
    此時補上 running，讓紀錄仍是 queued→running→succeeded。"""
    if src == dst:
        return []
    if src == JobStatus.QUEUED and dst == JobStatus.SUCCEEDED:
        return [JobStatus.RUNNING, JobStatus.SUCCEEDED]
    check_transition(src, dst)
    return [dst]
