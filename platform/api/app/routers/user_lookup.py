"""授權對象的帳號查詢：非 Admin 分享模型（部署）、發布 LLM 服務時，選同事的帳號用。

只有能授權別人的人可以查（本專案的 training 或 coding 權限；Admin 一律可以），只依帳號開頭比對，
最多回 20 筆，只回帳號名稱與是否為本專案成員，不回 Email、帳號類型等其他欄位。"""
from fastapi import APIRouter, Depends, Query
from sqlalchemy import select

from app.deps import ProjectContext, require_project_permission
from app.models import Membership, User
from app.permissions import Permission

router = APIRouter(tags=["user-lookup"])

can_grant = require_project_permission(Permission.TRAINING, Permission.CODING)
MAX_RESULTS = 20


def _escape(text: str) -> str:
    return text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


@router.get("/api/projects/{project_id}/user-lookup")
def lookup(q: str = Query(..., min_length=1, max_length=64), limit: int = Query(10, ge=1, le=MAX_RESULTS),
           ctx: ProjectContext = Depends(can_grant)) -> list[dict]:
    """帳號開頭符合 q（不分大小寫）的帳號；本專案成員排在前面。"""
    prefix = _escape(q.strip().lower())
    if not prefix:
        return []
    matches = User.username.ilike(f"{prefix}%", escape="\\")
    in_project = select(Membership.user_id).where(Membership.project_id == ctx.project.id)
    members = ctx.session.scalars(select(User.username).where(matches, User.id.in_(in_project))
                                  .order_by(User.username).limit(limit)).all()
    others = ctx.session.scalars(select(User.username).where(matches, User.id.not_in(in_project))
                                 .order_by(User.username).limit(limit - len(members))).all() if len(members) < limit else []
    return [{"username": u, "member": True} for u in members] + [{"username": u, "member": False} for u in others]
