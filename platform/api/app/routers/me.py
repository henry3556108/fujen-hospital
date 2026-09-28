from fastapi import APIRouter, Depends

from app.deps import current_user
from app.models import User

router = APIRouter(prefix="/api")


@router.get("/me")
def me(user: User = Depends(current_user)) -> dict:
    return {"username": user.username, "account_type": user.account_type}
