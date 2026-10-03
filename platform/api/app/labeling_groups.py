"""標註群組（A-03「Admin 建立標註群組」）：專案內負責標註的一組成員。

群組本身不授予權限（能不能標註仍由專案成員的 Labeling 權限決定），所以稽核歸 project 類：
動作 labeling_group.create／update／delete／member_removed，對象 project:{pid}/labeling_group:{gid}。
"""
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.audit import AuditCategory, record
from app.models import LabelGroup, LabelGroupMember, Membership, Project, User

_UNSET = object()


class Conflict(Exception):
    pass


class NotFound(Exception):
    pass


def target(group: LabelGroup) -> str:
    return f"project:{group.project_id}/labeling_group:{group.id}"


def _project(session: Session, project_id: int) -> Project:
    project = session.get(Project, project_id)
    if project is None:
        raise NotFound(f"找不到專案 {project_id}")
    return project


def _group(session: Session, project_id: int, group_id: int) -> LabelGroup:
    group = session.get(LabelGroup, group_id)
    if group is None or group.project_id != project_id:
        raise NotFound(f"找不到標註群組 {group_id}（專案 {project_id}）")
    return group


def members_of(session: Session, group_ids: list[int]) -> dict[int, list[User]]:
    out: dict[int, list[User]] = {gid: [] for gid in group_ids}
    if not group_ids:
        return out
    rows = session.execute(select(LabelGroupMember.group_id, User).join(User, User.id == LabelGroupMember.user_id)
                           .where(LabelGroupMember.group_id.in_(group_ids)).order_by(User.username))
    for gid, user in rows:
        out[gid].append(user)
    return out


def _usernames(session: Session, group_id: int) -> list[str]:
    return [u.username for u in members_of(session, [group_id])[group_id]]


def list_groups(session: Session, project_id: int) -> list[tuple[LabelGroup, list[User]]]:
    _project(session, project_id)
    groups = session.scalars(select(LabelGroup).where(LabelGroup.project_id == project_id)
                             .order_by(LabelGroup.name, LabelGroup.id)).all()
    members = members_of(session, [g.id for g in groups])
    return [(g, members[g.id]) for g in groups]


def _check_members(session: Session, project: Project, member_ids: list[int]) -> list[User]:
    ids = list(dict.fromkeys(member_ids))
    users = {u.id: u for u in session.scalars(select(User).where(User.id.in_(ids)))} if ids else {}
    missing = [i for i in ids if i not in users]
    if missing:
        raise NotFound(f"找不到帳號 {', '.join(map(str, missing))}")
    in_project = set(session.scalars(select(Membership.user_id).where(Membership.project_id == project.id,
                                                                      Membership.user_id.in_(ids)))) if ids else set()
    outsiders = sorted(users[i].username for i in ids if i not in in_project)
    if outsiders:
        raise Conflict(f"{'、'.join(outsiders)} 不是專案「{project.name}」的成員，請先在「專案成員」加入")
    return sorted((users[i] for i in ids), key=lambda u: u.username)


def _check_name(session: Session, project_id: int, name: str, *, exclude: int | None = None) -> None:
    query = select(LabelGroup.id).where(LabelGroup.project_id == project_id, LabelGroup.name == name)
    if exclude is not None:
        query = query.where(LabelGroup.id != exclude)
    if session.scalar(query) is not None:
        raise Conflict(f"標註群組「{name}」已存在於這個專案")


def create_group(session: Session, *, actor: str, project_id: int, name: str, description: str = "",
                 member_ids: list[int] = (), source_ip: str | None = None) -> LabelGroup:
    project = _project(session, project_id)
    _check_name(session, project_id, name)
    users = _check_members(session, project, list(member_ids))
    group = LabelGroup(project_id=project_id, name=name, description=description, created_by=actor)
    session.add(group)
    session.flush()
    session.add_all(LabelGroupMember(group_id=group.id, user_id=u.id) for u in users)
    record(session, actor=actor, category=AuditCategory.PROJECT, action="labeling_group.create", target=target(group),
           source_ip=source_ip, detail={"name": name, "description": description,
                                        "members": [u.username for u in users]})
    session.commit()
    return group


def update_group(session: Session, *, actor: str, project_id: int, group_id: int, name=_UNSET, description=_UNSET,
                 member_ids=_UNSET, source_ip: str | None = None) -> LabelGroup:
    project = _project(session, project_id)
    group = _group(session, project_id, group_id)
    changes: dict = {}
    if name is not _UNSET and name != group.name:
        _check_name(session, project_id, name, exclude=group.id)
        changes["name"] = {"from": group.name, "to": name}
        group.name = name
    if description is not _UNSET and description != group.description:
        changes["description"] = {"from": group.description, "to": description}
        group.description = description
    if member_ids is not _UNSET:
        users = _check_members(session, project, list(member_ids))
        before = _usernames(session, group.id)
        after = [u.username for u in users]
        if before != after:
            session.execute(delete(LabelGroupMember).where(LabelGroupMember.group_id == group.id))
            session.add_all(LabelGroupMember(group_id=group.id, user_id=u.id) for u in users)
            changes["members"] = {"from": before, "to": after}
    if changes:  # 沒有實際變更就不寫稽核
        record(session, actor=actor, category=AuditCategory.PROJECT, action="labeling_group.update",
               target=target(group), source_ip=source_ip, detail=changes)
    session.commit()
    return group


def _delete(session: Session, group: LabelGroup, *, actor: str, source_ip: str | None, reason: str | None) -> None:
    detail = {"name": group.name, "members": _usernames(session, group.id)}
    if reason:
        detail["reason"] = reason
    record(session, actor=actor, category=AuditCategory.PROJECT, action="labeling_group.delete", target=target(group),
           source_ip=source_ip, detail=detail)
    session.execute(delete(LabelGroupMember).where(LabelGroupMember.group_id == group.id))
    session.delete(group)


def delete_group(session: Session, *, actor: str, project_id: int, group_id: int, source_ip: str | None = None) -> None:
    _project(session, project_id)
    _delete(session, _group(session, project_id, group_id), actor=actor, source_ip=source_ip, reason=None)
    session.commit()


def delete_project_groups(session: Session, project_id: int, *, actor: str, source_ip: str | None) -> None:
    """刪除專案時呼叫（不 commit）：每個群組各 1 筆刪除稽核，原因 project_deleted。"""
    for group in session.scalars(select(LabelGroup).where(LabelGroup.project_id == project_id).order_by(LabelGroup.id)):
        _delete(session, group, actor=actor, source_ip=source_ip, reason="project_deleted")
    session.flush()


def remove_user(session: Session, user: User, *, actor: str, source_ip: str | None, reason: str,
                project_id: int | None = None) -> None:
    """把帳號移出群組（不 commit）：project_id 有值時只移出該專案的群組（移出專案），否則全部（刪除帳號）。
    每個受影響的群組各 1 筆 labeling_group.member_removed。"""
    query = (select(LabelGroup).join(LabelGroupMember, LabelGroupMember.group_id == LabelGroup.id)
             .where(LabelGroupMember.user_id == user.id).order_by(LabelGroup.id))
    if project_id is not None:
        query = query.where(LabelGroup.project_id == project_id)
    for group in session.scalars(query).all():
        record(session, actor=actor, category=AuditCategory.PROJECT, action="labeling_group.member_removed",
               target=target(group), source_ip=source_ip, detail={"username": user.username, "reason": reason})
        session.execute(delete(LabelGroupMember).where(LabelGroupMember.group_id == group.id,
                                                       LabelGroupMember.user_id == user.id))
    session.flush()
