from collections.abc import Iterator

from fastapi import Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.identity import Identity, TokenError
from app.models import User
from app.permissions import AccountType


def get_session(request: Request) -> Iterator[Session]:
    with request.app.state.sessionmaker() as session:
        yield session


def client_ip(request: Request) -> str | None:
    # Gateway 會把它看到的來源附加在最右邊；左邊的值是用戶端自己帶的，不可信。
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[-1].strip()
    return request.client.host if request.client else None


def current_identity(request: Request) -> Identity:
    auth = request.headers.get("authorization", "")
    if not auth.lower().startswith("bearer "):
        raise HTTPException(401, "未登入")
    try:
        return request.app.state.verifier.verify(auth[7:])
    except TokenError:
        raise HTTPException(401, "登入已失效，請重新登入")


def current_user(identity: Identity = Depends(current_identity), session: Session = Depends(get_session)) -> User:
    user = session.scalar(select(User).where(User.idp_subject == identity.subject))
    if user is None:
        raise HTTPException(401, "帳號不存在或已停用")
    return user


def require_admin(user: User = Depends(current_user)) -> User:
    if user.account_type != AccountType.ADMIN:
        raise HTTPException(403, "需要 Admin 權限")
    return user
