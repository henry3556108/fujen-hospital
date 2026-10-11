"""資料庫初始化（一次性，可重複執行）：以資料表擁有者連線，建立平台程式用的資料庫帳號、建表、授權。

TC-SS-07「資料庫帳號對稽核表只有 INSERT 與 SELECT」：
- 擁有者（DATABASE_OWNER_URL 的帳號，compose 與 Kubernetes 都是 platform）建立所有資料表，只給這個工作、備份與還原使用。
- 平台程式（API、FHIR worker、bootstrap-admin、seed）以 APP_DB_USER（預設 platform_app）連線：
  一般資料表 SELECT／INSERT／UPDATE／DELETE、序列 USAGE／SELECT；audit_log 只有 SELECT、INSERT；不能建表、不能 TRUNCATE。
- 之後新程式加的資料表：每次部署都會先跑這個工作，由擁有者 create_all 建立；預設權限（ALTER DEFAULT PRIVILEGES）
  讓擁有者日後建立的表與序列自動授權給平台帳號，audit_log 每次都再撤銷一次。

  DATABASE_OWNER_URL=postgresql+psycopg://platform:…@postgres:5432/platform \\
  APP_DB_USER=platform_app APP_DB_PASSWORD=… python -m app.db_init
"""
from __future__ import annotations

import os
import re
import sys

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Connection, Engine

DEFAULT_APP_USER = "platform_app"
AUDIT_TABLE = "audit_log"
TABLE_RIGHTS = ("SELECT", "INSERT", "UPDATE", "DELETE")
AUDIT_RIGHTS = ("SELECT", "INSERT")
FORBIDDEN_AUDIT_RIGHTS = ("UPDATE", "DELETE", "TRUNCATE")
_ROLE_NAME = re.compile(r"^[a-z_][a-z0-9_]{0,62}$")


class InitError(RuntimeError):
    pass


def _q(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _literal(value: str) -> str:
    # standard_conforming_strings 預設開啟：只需把單引號加倍
    return "'" + value.replace("'", "''") + "'"


def ensure_role(conn: Connection, role: str, password: str) -> None:
    """建立或更新平台帳號：可登入、沒有任何特殊權限、不屬於任何角色（不會繼承擁有者的權限）。"""
    if not _ROLE_NAME.match(role):
        raise InitError(f"資料庫帳號名稱不合法：{role!r}（只能用小寫英文、數字、底線）")
    if not password:
        raise InitError("缺少平台資料庫帳號的密碼（APP_DB_PASSWORD）")
    if role == conn.scalar(text("select current_user")):
        raise InitError("平台資料庫帳號不可以和資料表擁有者相同")
    exists = conn.scalar(text("select 1 from pg_roles where rolname = :r"), {"r": role})
    verb = "ALTER ROLE" if exists else "CREATE ROLE"
    conn.exec_driver_sql(f"{verb} {_q(role)} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION "
                         f"NOBYPASSRLS PASSWORD {_literal(password)}")
    for parent in conn.scalars(text(
            "select r.rolname from pg_auth_members m join pg_roles r on r.oid = m.roleid "
            "join pg_roles a on a.oid = m.member where a.rolname = :r"), {"r": role}).all():
        conn.exec_driver_sql(f"REVOKE {_q(parent)} FROM {_q(role)}")


def create_schema(engine: Engine) -> None:
    """建立所有資料表（含 pgvector 向量表，資料庫有 vector 外掛時）。"""
    import app.main  # noqa: F401  載入所有模組的資料表定義
    from app.llm.vectors import PgVectorStore
    from app.models import Base

    Base.metadata.create_all(engine)
    with engine.begin() as conn:
        if engine.dialect.name == "postgresql":
            add_columns(conn)
        if conn.scalar(text("select 1 from pg_available_extensions where name = 'vector'")):
            PgVectorStore.ensure_schema(conn)


# 既有資料表後來加的欄位。create_all 不會改已存在的表，所以每次部署在這裡補上（可重複執行）。
ADDED_COLUMNS = (
    ("llm_model_whitelist", "files", "JSON NOT NULL DEFAULT '[]'"),
    ("llm_model_downloads", "progress", "JSON"),
    ("llm_call_records", "prompt_id", "INTEGER"),
)


def add_columns(conn: Connection) -> None:
    for table, column, ddl in ADDED_COLUMNS:
        conn.exec_driver_sql(f"ALTER TABLE {_q(table)} ADD COLUMN IF NOT EXISTS {_q(column)} {ddl}")


def grant(conn: Connection, role: str) -> None:
    r = _q(role)
    database = conn.scalar(text("select current_database()"))
    rights = ", ".join(TABLE_RIGHTS)
    for statement in (
        f"GRANT CONNECT ON DATABASE {_q(database)} TO {r}",
        f"GRANT USAGE ON SCHEMA public TO {r}",
        "REVOKE CREATE ON SCHEMA public FROM PUBLIC",
        f"REVOKE CREATE ON SCHEMA public FROM {r}",
        f"GRANT {rights} ON ALL TABLES IN SCHEMA public TO {r}",
        f"GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO {r}",
        # 擁有者（目前連線的帳號）日後建立的表與序列自動授權
        f"ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT {rights} ON TABLES TO {r}",
        f"ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO {r}",
        # 稽核表：只能新增與查詢（TC-SS-07）
        f"REVOKE ALL ON {AUDIT_TABLE} FROM PUBLIC",
        f"REVOKE ALL ON {AUDIT_TABLE} FROM {r}",
        f"GRANT {', '.join(AUDIT_RIGHTS)} ON {AUDIT_TABLE} TO {r}",
    ):
        conn.exec_driver_sql(statement)


def check(conn: Connection, role: str) -> dict:
    """確認授權結果；不符合就丟 InitError。回傳摘要供輸出。"""
    tables = conn.scalars(text("select tablename from pg_tables where schemaname = 'public' order by 1")).all()
    if AUDIT_TABLE not in tables:
        raise InitError("找不到稽核表 audit_log")
    has = lambda table, right: conn.scalar(  # noqa: E731
        text("select has_table_privilege(:r, :t, :p)"), {"r": role, "t": f"public.{table}", "p": right})
    wrong = [f"{AUDIT_TABLE} 可以 {p}" for p in FORBIDDEN_AUDIT_RIGHTS if has(AUDIT_TABLE, p)]
    wrong += [f"{AUDIT_TABLE} 不能 {p}" for p in AUDIT_RIGHTS if not has(AUDIT_TABLE, p)]
    for table in tables:
        if table != AUDIT_TABLE:
            wrong += [f"{table} 不能 {p}" for p in TABLE_RIGHTS if not has(table, p)]
    if conn.scalar(text("select has_schema_privilege(:r, 'public', 'CREATE')"), {"r": role}):
        wrong.append("可以在 public 建立物件")
    flags = conn.execute(text("select rolsuper, rolcreatedb, rolcreaterole from pg_roles where rolname = :r"),
                         {"r": role}).one()
    if any(flags):
        wrong.append("帳號有特殊權限（superuser／createdb／createrole）")
    if wrong:
        raise InitError(f"平台資料庫帳號 {role} 的權限不正確：" + "；".join(wrong))
    return {"role": role, "tables": len(tables), "audit_log": list(AUDIT_RIGHTS)}


def run(owner_url: str, app_user: str, app_password: str) -> dict:
    engine = create_engine(owner_url)
    try:
        if engine.dialect.name != "postgresql":
            raise InitError("db-init 只支援 PostgreSQL")
        with engine.begin() as conn:
            ensure_role(conn, app_user, app_password)
        create_schema(engine)
        with engine.begin() as conn:
            grant(conn, app_user)
            return check(conn, app_user)
    finally:
        engine.dispose()


def audit_write_rights(engine: Engine) -> list[str]:
    """目前連線帳號對稽核表多出的權限（UPDATE／DELETE／TRUNCATE）。平台 API 啟動時檢查，非空就寫警告。"""
    if engine.dialect.name != "postgresql":
        return []
    with engine.connect() as conn:
        return [p for p in FORBIDDEN_AUDIT_RIGHTS
                if conn.scalar(text("select has_table_privilege(current_user, :t, :p)"),
                               {"t": f"public.{AUDIT_TABLE}", "p": p})]


def main() -> int:
    owner_url = os.environ.get("DATABASE_OWNER_URL")
    password = os.environ.get("APP_DB_PASSWORD", "")
    if not owner_url:
        print("缺少環境變數 DATABASE_OWNER_URL（資料表擁有者的連線網址）", file=sys.stderr)
        return 2
    try:
        summary = run(owner_url, os.environ.get("APP_DB_USER") or DEFAULT_APP_USER, password)
    except InitError as exc:
        print(f"db-init 失敗：{exc}", file=sys.stderr)
        return 1
    print(f"db-init 完成：帳號 {summary['role']}，資料表 {summary['tables']} 張，"
          f"稽核表只有 {'、'.join(summary['audit_log'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
