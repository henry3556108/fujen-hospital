"""TC-SS-07 資料庫層：平台帳號對稽核表只有 INSERT 與 SELECT（app.db_init）。只能在 PostgreSQL 上驗證。

TEST_POSTGRES_URL 要是可建立資料庫與角色的帳號（例如容器的 POSTGRES_USER），有 pgvector 時另外驗證向量表：
  docker run -d --rm --name pg-m1gaps -e POSTGRES_USER=platform -e POSTGRES_PASSWORD=test -e POSTGRES_DB=platform \\
    -p 127.0.0.1:55441:5432 pgvector/pgvector:0.8.7-pg16-trixie
  TEST_POSTGRES_URL=postgresql+psycopg://platform:test@127.0.0.1:55441/platform uv run pytest tests/test_db_roles_pg.py
"""
import logging
import os
import secrets

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import ProgrammingError

from app import db_init
from app.identity import InMemoryIdentityProvider, JwtVerifier
from app.main import create_app
from app.models import User
from app.permissions import AccountType

PG_URL = os.environ.get("TEST_POSTGRES_URL")
pytestmark = pytest.mark.skipif(not PG_URL, reason="需要 TEST_POSTGRES_URL（PostgreSQL）")


@pytest.fixture
def pg():
    """每個測試一個新資料庫與一個新的平台帳號；結束時刪除。"""
    admin = create_engine(PG_URL, isolation_level="AUTOCOMMIT")
    suffix = secrets.token_hex(4)
    database, role, password = f"m1roles_{suffix}", f"app_{suffix}", f"pw-{suffix}'\"x"
    with admin.connect() as conn:
        conn.exec_driver_sql(f'CREATE DATABASE "{database}"')
    owner_url = make_url(PG_URL).set(database=database)
    app_url = owner_url.set(username=role, password=password)
    summary = db_init.run(owner_url.render_as_string(hide_password=False), role, password)
    yield {"owner": owner_url, "app": app_url, "role": role, "password": password, "summary": summary}
    with admin.connect() as conn:
        conn.exec_driver_sql(f'DROP DATABASE IF EXISTS "{database}" WITH (FORCE)')
        conn.exec_driver_sql(f'DROP ROLE IF EXISTS "{role}"')
    admin.dispose()


def _engine(url):
    return create_engine(url)


def _denied(conn, sql, params=None):
    with pytest.raises(ProgrammingError) as info:
        with conn.begin_nested():
            conn.execute(text(sql), params or {})
    assert "permission denied" in str(info.value) or "must be owner" in str(info.value)


AUDIT_ROW = ("insert into audit_log (at, actor, category, action, target, result, source_ip, detail) "
             "values (now(), 'admin01', 'project', 'create', 'project:1', 'success', '10.0.0.1', '{}')")


def test_app_role_can_only_insert_and_select_audit_log(pg):
    engine = _engine(pg["app"])
    with engine.connect() as conn:
        conn.execute(text(AUDIT_ROW))
        assert conn.scalar(text("select count(*) from audit_log")) == 1
        _denied(conn, "update audit_log set actor = 'someone'")
        _denied(conn, "delete from audit_log")
        _denied(conn, "truncate audit_log")
        _denied(conn, "alter table audit_log add column x int")
        _denied(conn, "drop table audit_log")
        _denied(conn, "select setval('audit_log_id_seq', 1)")
        conn.commit()
        assert conn.scalar(text("select actor from audit_log")) == "admin01"
    engine.dispose()


def test_app_role_reads_and_writes_other_tables_but_cannot_create_tables(pg):
    engine = _engine(pg["app"])
    with engine.connect() as conn:
        conn.execute(text("insert into projects (name, description) values ('P1', '')"))
        conn.execute(text("update projects set description = 'x' where name = 'P1'"))
        assert conn.scalar(text("select description from projects")) == "x"
        conn.execute(text("delete from projects"))
        _denied(conn, "create table sneaky (id int)")
        _denied(conn, "truncate projects")
        conn.commit()
    engine.dispose()


def test_role_has_no_special_attributes_and_is_not_a_member_of_the_owner(pg):
    engine = _engine(pg["owner"])
    with engine.connect() as conn:
        flags = conn.execute(text("select rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls "
                                  "from pg_roles where rolname = :r"), {"r": pg["role"]}).one()
        assert not any(flags)
        assert conn.scalar(text("select count(*) from pg_auth_members m join pg_roles a on a.oid = m.member "
                                "where a.rolname = :r"), {"r": pg["role"]}) == 0
    engine.dispose()


def test_tables_created_later_by_the_owner_are_granted_automatically(pg):
    owner = _engine(pg["owner"])
    with owner.begin() as conn:
        conn.execute(text("create table later_feature (id serial primary key, note text)"))
    app = _engine(pg["app"])
    with app.connect() as conn:
        conn.execute(text("insert into later_feature (note) values ('a')"))
        conn.execute(text("update later_feature set note = 'b'"))
        conn.execute(text("delete from later_feature"))
        conn.commit()
    owner.dispose()
    app.dispose()


def test_db_init_is_repeatable_restores_audit_restrictions_and_updates_password(pg):
    owner = _engine(pg["owner"])
    with owner.begin() as conn:  # 有人手動多給了權限（或還原了舊備份）
        conn.exec_driver_sql(f'GRANT UPDATE, DELETE ON audit_log TO "{pg["role"]}"')
    db_init.run(pg["owner"].render_as_string(hide_password=False), pg["role"], "new-password")
    with owner.connect() as conn:
        assert db_init.check(conn, pg["role"])["audit_log"] == ["SELECT", "INSERT"]
    app = _engine(pg["app"].set(password="new-password"))
    with app.connect() as conn:
        _denied(conn, "update audit_log set actor = 'x'")
    app.dispose()
    owner.dispose()


def test_db_init_rejects_owner_as_app_role_and_bad_names(pg):
    owner_url = pg["owner"].render_as_string(hide_password=False)
    with pytest.raises(db_init.InitError, match="不可以和資料表擁有者相同"):
        db_init.run(owner_url, pg["owner"].username, "x")
    with pytest.raises(db_init.InitError, match="不合法"):
        db_init.run(owner_url, "bad-name; drop", "x")
    with pytest.raises(db_init.InitError, match="密碼"):
        db_init.run(owner_url, pg["role"], "")


def test_pgvector_table_is_created_by_db_init_and_usable_by_the_app(pg):
    owner = _engine(pg["owner"])
    with owner.connect() as conn:
        if not conn.scalar(text("select 1 from pg_available_extensions where name = 'vector'")):
            pytest.skip("這個 PostgreSQL 沒有 pgvector")
    owner.dispose()
    from app.db import make_sessionmaker
    from app.llm.vectors import PgVectorStore
    engine = _engine(pg["app"])
    store = PgVectorStore(make_sessionmaker(engine))  # 表已存在：不執行 DDL
    with make_sessionmaker(engine)() as session:
        store.add(session, 1, 1, ["a"], [[0.1, 0.2]])
        session.commit()
        assert store.count(session, 1) == 1
    engine.dispose()


def test_whole_api_runs_as_the_app_role_and_audits(pg, rsa_key, make_token, caplog):
    idp = InMemoryIdentityProvider()
    verifier = JwtVerifier(issuer="http://test-idp/realms/ai-platform", audience="ai-platform",
                           key_resolver=lambda token: rsa_key.public_key())
    with caplog.at_level(logging.WARNING, logger="app.main"):
        app = create_app(database_url=pg["app"].render_as_string(hide_password=False), verifier=verifier, idp=idp)
    assert "稽核表" not in caplog.text
    with app.state.sessionmaker() as s:
        subject = idp.create_user("admin01", "x")
        s.add(User(username="admin01", account_type=AccountType.ADMIN.value, idp_subject=subject))
        s.commit()
    headers = {"Authorization": f"Bearer {make_token(subject, 'admin01')}"}
    client = TestClient(app)
    pid = client.post("/api/admin/projects", headers=headers, json={"name": "P1"}).json()["id"]
    assert client.post(f"/api/admin/projects/{pid}/labeling-groups", headers=headers,
                       json={"name": "G"}).status_code == 201
    assert client.get("/api/admin/dashboard", headers=headers).json()["labeling_groups"] == 1
    assert client.delete(f"/api/admin/projects/{pid}", headers=headers).status_code == 204
    with app.state.sessionmaker() as s:
        actions = s.scalars(text("select action from audit_log order by id")).all()
    assert actions[:2] == ["create", "labeling_group.create"] and "delete" in actions
    page = client.get("/api/admin/audit", headers=headers,
                      params={"category": "project", "since": "2000-01-01T00:00:00Z", "until": "2999-01-01T00:00:00+08:00",
                              "action": "labeling_group."}).json()
    assert page["total"] == 2 and {i["action"] for i in page["items"]} == {"labeling_group.create",
                                                                           "labeling_group.delete"}


def test_api_started_with_the_owner_account_logs_a_warning(pg, caplog):
    with caplog.at_level(logging.WARNING, logger="app.main"):
        create_app(database_url=pg["owner"].render_as_string(hide_password=False))
    assert "稽核表" in caplog.text and "UPDATE" in caplog.text


def test_api_without_tables_explains_db_init(pg):
    owner = _engine(pg["owner"])
    with owner.begin() as conn:
        conn.exec_driver_sql("drop table label_group_members")
    owner.dispose()
    with pytest.raises(RuntimeError, match="db-init"):
        create_app(database_url=pg["app"].render_as_string(hide_password=False))
