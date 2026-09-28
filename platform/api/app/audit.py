from enum import StrEnum

from sqlalchemy.orm import Session

from app.models import AuditLog


class AuditCategory(StrEnum):
    ACCOUNT = "account"
    ROLE = "role"
    PERMISSION = "permission"
    PROJECT = "project"
    DATASET = "dataset"
    TRAINING = "training"
    INFERENCE = "inference"
    DATA_EXCHANGE = "data_exchange"


def record(
    session: Session,
    *,
    actor: str,
    category: AuditCategory,
    action: str,
    target: str,
    result: str = "success",
    source_ip: str | None = None,
    detail: dict | None = None,
) -> AuditLog:
    """寫入一筆稽核。只 add，不 commit：與業務變更同一個交易，一起成功或一起失敗。"""
    entry = AuditLog(
        actor=actor, category=category.value, action=action, target=target,
        result=result, source_ip=source_ip, detail=detail or {},
    )
    session.add(entry)
    return entry
