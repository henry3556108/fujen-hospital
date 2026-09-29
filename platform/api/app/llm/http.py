"""路由共用：錯誤轉換、權限相依。"""
from collections.abc import Iterator
from contextlib import contextmanager

from fastapi import HTTPException

from app.deps import require_project_permission
from app.llm.client import LlmError
from app.llm.errors import LlmServiceError
from app.permissions import AccountType, Permission

# 「LLM No-code 開發」入口的規則：目前專案的 coding 權限
coding = require_project_permission(Permission.CODING)


def is_admin(user) -> bool:
    return user.account_type == AccountType.ADMIN


@contextmanager
def errors() -> Iterator[None]:
    try:
        yield
    except LlmServiceError as exc:
        raise HTTPException(exc.status_code, exc.detail())
    except LlmError as exc:
        raise HTTPException(exc.status_code, exc.detail())
