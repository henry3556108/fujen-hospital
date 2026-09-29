"""WP7 路由總表。main.py 只 include 這一個 router。"""
from fastapi import APIRouter

from app.llm import models as _models  # noqa: F401  確保資料表在 create_all 之前註冊
from app.llm import routes_knowledge, routes_models, routes_prompts

router = APIRouter()
router.include_router(routes_knowledge.router)
router.include_router(routes_models.router)
router.include_router(routes_prompts.router)
