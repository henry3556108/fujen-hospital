"""第一次部署（甲方環境）：把 Keycloak realm 匯入時建立的初始管理者登記為平台 Admin。

不建立任何專案或測試帳號（測試基線是 app.seed，只用於開發與驗收環境）。可重複執行：
已登記時只同步 Keycloak 的 subject（Keycloak 資料庫重建後 subject 會變）。

  python -m app.bootstrap_admin        環境變數 BOOTSTRAP_ADMIN（預設 admin01）
"""
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit import AuditCategory, record
from app.identity import IdentityProvider
from app.models import User
from app.permissions import AccountType

SOURCE = "local:bootstrap_admin"


def ensure_admin(session: Session, idp: IdentityProvider, username: str) -> dict:
    subject = idp.find_subject(username)
    if subject is None:
        raise RuntimeError(f"身分提供者中找不到 {username}")
    admin = session.scalar(select(User).where(User.username == username))
    if admin is not None and admin.idp_subject == subject and admin.account_type == AccountType.ADMIN.value:
        return {"admin": username, "changed": False}
    created = admin is None
    if created:
        admin = User(username=username, account_type=AccountType.ADMIN.value, idp_subject=subject)
        session.add(admin)
    else:
        admin.idp_subject = subject
        admin.account_type = AccountType.ADMIN.value
    record(session, actor=username, category=AuditCategory.ACCOUNT, action="admin.bootstrap", target=username,
           source_ip=SOURCE, detail={"created": created})
    session.commit()
    return {"admin": username, "changed": True, "created": created}


if __name__ == "__main__":
    import json
    import os

    from app.asgi import app, idp

    with app.state.sessionmaker() as s:
        print(json.dumps(ensure_admin(s, idp, os.environ.get("BOOTSTRAP_ADMIN", "admin01")), ensure_ascii=False))
