"""最後一個 Admin 的併發保護，只能在 PostgreSQL 上驗證（SQLite 會忽略列鎖）。

執行：TEST_POSTGRES_URL=postgresql+psycopg://postgres:test@127.0.0.1:55432/postgres uv run pytest tests/test_admin_race_pg.py
"""
import os
import threading

import pytest
from sqlalchemy import func, select

from app import admin_service
from app.db import make_engine, make_sessionmaker
from app.models import Base, User
from app.permissions import AccountType

PG_URL = os.environ.get("TEST_POSTGRES_URL")
pytestmark = pytest.mark.skipif(not PG_URL, reason="需要 TEST_POSTGRES_URL（PostgreSQL）")


@pytest.fixture
def pg_sessionmaker():
    engine = make_engine(PG_URL)
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    yield make_sessionmaker(engine)
    Base.metadata.drop_all(engine)
    engine.dispose()


def test_two_admins_demoting_each_other_concurrently_keeps_one_admin(pg_sessionmaker, monkeypatch):
    with pg_sessionmaker() as s:
        s.add_all([User(username="a1", account_type="admin", idp_subject="s1"),
                   User(username="a2", account_type="admin", idp_subject="s2")])
        s.commit()
        ids = [u.id for u in s.scalars(select(User).order_by(User.id))]

    # 讓兩個交易都「數完 Admin 數量」之後才繼續，重現最糟的交錯順序。
    barrier = threading.Barrier(2, timeout=3)
    original = admin_service._admin_count

    def counted_then_wait(session):
        n = original(session)
        try:
            barrier.wait()
        except threading.BrokenBarrierError:
            pass  # 有鎖時另一個交易會卡在數量查詢，等不到屏障，屬預期
        return n

    monkeypatch.setattr(admin_service, "_admin_count", counted_then_wait)
    results = {}

    def demote(user_id):
        with pg_sessionmaker() as s:
            try:
                admin_service.update_user(s, actor="x", user_id=user_id, account_type=AccountType.USER)
                results[user_id] = "ok"
            except admin_service.Conflict:
                results[user_id] = "conflict"

    threads = [threading.Thread(target=demote, args=(uid,)) for uid in ids]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=15)

    with pg_sessionmaker() as s:
        admins = s.scalar(select(func.count()).select_from(User).where(User.account_type == "admin"))
    assert admins == 1, results
    assert sorted(results.values()) == ["conflict", "ok"]
