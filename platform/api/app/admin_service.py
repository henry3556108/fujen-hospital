import logging

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import audit, labeling_groups, project_cleanup
from app.audit import AuditCategory, record
from app.identity import IdentityProvider
from app.models import Membership, Project, User
from app.permissions import DEFAULT_ROLE_PERMISSIONS, AccountType, Permission, Role


log = logging.getLogger(__name__)


class Conflict(Exception):
    pass


class NotFound(Exception):
    pass


def _get(session: Session, model, obj_id: int):
    obj = session.get(model, obj_id)
    if obj is None:
        raise NotFound(f"找不到 {model.__tablename__} {obj_id}")
    return obj


def create_project(session: Session, *, actor: str, name: str, description: str = "",
                   gpu_group: str | None = None, source_ip: str | None = None) -> Project:
    if session.scalar(select(Project).where(Project.name == name)):
        raise Conflict(f"專案名稱「{name}」已存在")
    project = Project(name=name, description=description, gpu_group=gpu_group)
    session.add(project)
    session.flush()
    record(session, actor=actor, category=AuditCategory.PROJECT, action="create",
           target=f"project:{project.id}", source_ip=source_ip,
           detail={"name": name, "gpu_group": gpu_group})
    session.commit()
    return project


def update_project(session: Session, *, actor: str, project_id: int, changes: dict,
                   source_ip: str | None = None) -> Project:
    project = _get(session, Project, project_id)
    new_name = changes.get("name")
    if new_name and new_name != project.name and session.scalar(select(Project).where(Project.name == new_name)):
        raise Conflict(f"專案名稱「{new_name}」已存在")
    for key, value in changes.items():
        setattr(project, key, value)
    record(session, actor=actor, category=AuditCategory.PROJECT, action="update",
           target=f"project:{project.id}", source_ip=source_ip, detail=changes)
    session.commit()
    return project


def _revoke_memberships(session: Session, condition, *, actor: str, reason: str, source_ip: str | None) -> None:
    """刪除帳號或專案時連帶移除成員資格：每筆各寫 1 筆 role 稽核，與刪除同一個交易。"""
    for m in session.scalars(select(Membership).where(condition).order_by(Membership.id)).all():
        if reason != "project_deleted":  # 刪除專案時群組已先整個刪除
            labeling_groups.remove_user(session, session.get(User, m.user_id), actor=actor, source_ip=source_ip,
                                        reason=reason, project_id=m.project_id)
        record(session, actor=actor, category=AuditCategory.ROLE, action="revoke",
               target=f"project:{m.project_id}/user:{m.user_id}", source_ip=source_ip,
               detail={"role": m.role, "reason": reason})
        session.delete(m)
    session.flush()


def delete_project(session: Session, *, actor: str, project_id: int, source_ip: str | None = None,
                   store=None, orthanc=None, fhir=None, jobs=None) -> None:
    """刪除專案與它的索引；commit 之後才清 Orthanc 影像、物件儲存檔案與 FHIR 租戶，並取消叢集中的工作
    （失敗可重試，見 app.project_cleanup）。"""
    project = _get(session, Project, project_id)
    name = project.name
    labeling_groups.delete_project_groups(session, project_id, actor=actor, source_ip=source_ip)
    _revoke_memberships(session, Membership.project_id == project_id, actor=actor, reason="project_deleted",
                        source_ip=source_ip)
    project_cleanup.stage(session, project_id, fhir=fhir is not None)
    session.delete(session.get(Project, project_id))
    record(session, actor=actor, category=AuditCategory.PROJECT, action="delete",
           target=f"project:{project_id}", source_ip=source_ip, detail={"name": name})
    session.commit()
    project_cleanup.run_pending(session, store, orthanc, actor=actor, source_ip=source_ip, fhir=fhir, jobs=jobs)


def _commit_after_idp(session: Session, idp_call) -> None:
    """先把資料庫變更（含稽核）flush 成功，再呼叫身分提供者，最後 commit。
    資料庫這側先失敗時，身分提供者完全不會被動到。"""
    try:
        session.flush()
        idp_call()
    except Exception:
        session.rollback()
        raise
    session.commit()


def _admin_count(session: Session) -> int:
    """鎖住所有 Admin 列再計數：兩個交易同時降級／刪除 Admin 時，後到的會等前一個 commit 後重新計算，
    避免兩邊都看到 2 而把 Admin 降到 0（PostgreSQL READ COMMITTED 下的競態）。"""
    admin_ids = session.scalars(
        select(User.id).where(User.account_type == AccountType.ADMIN).with_for_update()
    ).all()
    return len(admin_ids)


def create_user(session: Session, idp: IdentityProvider, *, actor: str, username: str, password: str,
                account_type: AccountType, source_ip: str | None = None) -> User:
    if session.scalar(select(User).where(User.username == username)):
        raise Conflict(f"帳號「{username}」已存在")
    subject = idp.create_user(username, password)
    try:
        user = User(username=username, account_type=account_type.value, idp_subject=subject)
        session.add(user)
        session.flush()
        record(session, actor=actor, category=AuditCategory.ACCOUNT, action="create", target=f"user:{user.id}",
               source_ip=source_ip, detail={"username": username, "account_type": account_type.value})
        session.commit()
    except Exception as original:
        session.rollback()
        try:
            idp.delete_user(subject)  # 補償：資料庫失敗時不留下孤兒帳號
        except Exception as compensation:
            _report_orphan(session, original, compensation, actor=actor, username=username, subject=subject,
                           source_ip=source_ip)
        raise  # 一律拋原本的錯誤；補償失敗不可以蓋掉它
    return user


def _report_orphan(session: Session, original: Exception, compensation: Exception, *, actor: str, username: str,
                   subject: str, source_ip: str | None) -> None:
    """補償失敗：身分提供者留下了平台不認得的帳號。寫 log 與 1 筆稽核，讓管理者找得到並手動清掉。"""
    log.error("建立帳號 %s 失敗後補償失敗，身分提供者留下孤兒帳號 subject=%s：%s: %s（原本的錯誤：%s: %s）",
              username, subject, type(compensation).__name__, compensation, type(original).__name__, original)
    original.add_note(f"補償也失敗：身分提供者的帳號 {subject} 未刪除（{type(compensation).__name__}）")
    try:
        audit.record(session, actor=actor, category=AuditCategory.ACCOUNT, action="create.compensation_failed",
                     target=f"idp:{subject}", result="failed", source_ip=source_ip,
                     detail={"username": username, "idp_subject": subject,
                             "error": type(original).__name__, "compensation_error": type(compensation).__name__})
        session.commit()
    except Exception:  # 資料庫仍然不通：至少 log 已經留下
        session.rollback()
        log.exception("補償失敗的稽核也寫不進去（帳號 %s，subject=%s）", username, subject)


def update_user(session: Session, *, actor: str, user_id: int, account_type: AccountType,
                source_ip: str | None = None) -> User:
    user = _get(session, User, user_id)
    if user.account_type == AccountType.ADMIN and account_type != AccountType.ADMIN and _admin_count(session) <= 1:
        raise Conflict("至少要保留 1 個 Admin")
    before = user.account_type
    user.account_type = account_type.value
    record(session, actor=actor, category=AuditCategory.ACCOUNT, action="update", target=f"user:{user.id}",
           source_ip=source_ip, detail={"account_type": {"from": before, "to": account_type.value}})
    session.commit()
    return user


def delete_user(session: Session, idp: IdentityProvider, *, actor_user: User, user_id: int,
                source_ip: str | None = None) -> None:
    user = _get(session, User, user_id)
    if user.id == actor_user.id:
        raise Conflict("不能刪除自己的帳號")
    if user.account_type == AccountType.ADMIN and _admin_count(session) <= 1:
        raise Conflict("至少要保留 1 個 Admin")
    _revoke_memberships(session, Membership.user_id == user_id, actor=actor_user.username, reason="user_deleted",
                        source_ip=source_ip)
    labeling_groups.remove_user(session, user, actor=actor_user.username, source_ip=source_ip, reason="user_deleted")
    session.delete(user)
    record(session, actor=actor_user.username, category=AuditCategory.ACCOUNT, action="delete",
           target=f"user:{user_id}", source_ip=source_ip, detail={"username": user.username})
    _commit_after_idp(session, lambda: idp.delete_user(user.idp_subject))


def reset_password(session: Session, idp: IdentityProvider, *, actor: str, user_id: int, new_password: str,
                   source_ip: str | None = None) -> None:
    user = _get(session, User, user_id)
    record(session, actor=actor, category=AuditCategory.ACCOUNT, action="reset_password",
           target=f"user:{user_id}", source_ip=source_ip)
    _commit_after_idp(session, lambda: idp.reset_password(user.idp_subject, new_password))


def set_membership(session: Session, *, actor: str, project_id: int, user_id: int, role: Role,
                   permissions: set[Permission] | None = None, source_ip: str | None = None) -> Membership:
    _get(session, Project, project_id)
    _get(session, User, user_id)
    target = f"project:{project_id}/user:{user_id}"
    chosen = permissions if permissions is not None else DEFAULT_ROLE_PERMISSIONS[role]
    new_perms = sorted(p.value for p in chosen)
    membership = session.scalar(
        select(Membership).where(Membership.user_id == user_id, Membership.project_id == project_id)
    )
    if membership is None:
        membership = Membership(user_id=user_id, project_id=project_id, role=role.value, permissions=new_perms)
        session.add(membership)
        record(session, actor=actor, category=AuditCategory.ROLE, action="assign", target=target,
               source_ip=source_ip, detail={"role": role.value})
        record(session, actor=actor, category=AuditCategory.PERMISSION, action="grant", target=target,
               source_ip=source_ip, detail={"permissions": new_perms})
    else:
        if membership.role != role.value:
            record(session, actor=actor, category=AuditCategory.ROLE, action="change", target=target,
                   source_ip=source_ip, detail={"from": membership.role, "to": role.value})
            membership.role = role.value
        if membership.permissions != new_perms:
            record(session, actor=actor, category=AuditCategory.PERMISSION, action="change", target=target,
                   source_ip=source_ip, detail={"from": membership.permissions, "to": new_perms})
            membership.permissions = new_perms
    session.commit()
    return membership


def remove_membership(session: Session, *, actor: str, project_id: int, user_id: int,
                      source_ip: str | None = None) -> None:
    membership = session.scalar(
        select(Membership).where(Membership.user_id == user_id, Membership.project_id == project_id)
    )
    if membership is None:
        raise NotFound(f"找不到成員資格：使用者 {user_id} 不在專案 {project_id}")
    labeling_groups.remove_user(session, session.get(User, user_id), actor=actor, source_ip=source_ip,
                                reason="membership_revoked", project_id=project_id)
    session.delete(membership)
    record(session, actor=actor, category=AuditCategory.ROLE, action="revoke",
           target=f"project:{project_id}/user:{user_id}", source_ip=source_ip, detail={"role": membership.role})
    session.commit()


def list_members(session: Session, *, project_id: int) -> list[tuple[User, Membership]]:
    _get(session, Project, project_id)
    rows = session.execute(
        select(User, Membership).join(Membership, Membership.user_id == User.id)
        .where(Membership.project_id == project_id).order_by(User.username)
    )
    return [(u, m) for u, m in rows]
