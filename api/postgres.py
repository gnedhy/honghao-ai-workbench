"""PostgreSQL connections and explicit schema migrations; never falls back to SQLite."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path
from threading import Lock
from typing import Iterator

import psycopg
from psycopg.conninfo import conninfo_to_dict


MIGRATIONS = Path(__file__).with_name("migrations") / "postgresql"
ENVIRONMENTS = ("development", "test", "acceptance", "production")
WRITE_LOCK = 0x484F4E4748414F
SERVICE_LOCK = WRITE_LOCK + 2
_TRANSACTION: ContextVar[tuple[str, psycopg.Connection, bool] | None] = ContextVar("postgres_transaction", default=None)
_LEASES: dict[str, psycopg.Connection] = {}
_LEASES_LOCK = Lock()


def database_url(value: str | None = None) -> str:
    value = value if value is not None else os.environ.get("HONGHAO_DATABASE_URL", "")
    try:
        if not value.startswith(("postgresql://", "postgres://")):
            raise ValueError
        parameters = conninfo_to_dict(value)
        if not all(parameters.get(key) for key in ("host", "dbname", "user")):
            raise ValueError
    except (ValueError, psycopg.Error):
        raise ValueError("HONGHAO_DATABASE_URL 必须明确指定 PostgreSQL 主机、数据库和账号") from None
    return value


def connect(url: str | None = None) -> psycopg.Connection:
    return psycopg.connect(
        database_url(url),
        autocommit=True,
        connect_timeout=5,
        application_name="honghao-workbench",
        options="-c timezone=UTC -c search_path=public,pg_catalog "
                "-c statement_timeout=30000 -c lock_timeout=10000 "
                "-c idle_in_transaction_session_timeout=60000",
    )


@contextmanager
def database_lease(url: str) -> Iterator[psycopg.Connection]:
    """One service or restore per database, even with different attachment directories."""
    with connect(url) as connection:
        with _LEASES_LOCK:
            if url in _LEASES or not connection.execute("SELECT pg_try_advisory_lock(%s)", (SERVICE_LOCK,)).fetchone()[0]:
                raise RuntimeError("当前数据库已有服务或恢复操作运行")
            _LEASES[url] = connection
        try:
            yield connection
        finally:
            with _LEASES_LOCK:
                del _LEASES[url]


@contextmanager
def transaction(url: str, *, write: bool = False) -> Iterator[psycopg.Connection]:
    active = _TRANSACTION.get()
    if active is not None:
        active_url, connection, writable = active
        if active_url != url:
            raise RuntimeError("事务内不能切换数据库")
        if write and not writable:
            raise RuntimeError("只读事务不能升级为写事务")
        # Native savepoints let a caller recover from a failed nested operation.
        with connection.transaction():
            yield connection
        return
    lease = _LEASES.get(url)
    if lease is not None:
        # A database restart can drop the session lock; the old service must then fail closed.
        lease.execute("SELECT 1")
    with connect(url) as connection, connection.transaction():
        if write:
            # ponytail: serialize business writes as SQLite did; split locks only after concurrency tests.
            connection.execute("SELECT pg_advisory_xact_lock(%s)", (WRITE_LOCK,))
        else:
            connection.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        if lease is not None:
            lease.execute("SELECT 1")
        token = _TRANSACTION.set((url, connection, write))
        try:
            yield connection
            if lease is not None:
                lease.execute("SELECT 1")
        finally:
            _TRANSACTION.reset(token)


def _migration_files() -> list[tuple[int, str, str, str]]:
    result = []
    for version, path in enumerate(sorted(MIGRATIONS.glob("*.sql")), start=1):
        if path.name.split("_", 1)[0] != f"{version:04d}":
            raise RuntimeError("迁移文件序号不连续")
        content = path.read_bytes()
        result.append((version, path.name, hashlib.sha256(content).hexdigest(), content.decode("utf-8")))
    if not result:
        raise RuntimeError("缺少 PostgreSQL 迁移文件")
    return result


def _verify_history(connection: psycopg.Connection, files: list) -> int:
    rows = connection.execute(
        "SELECT version, name, sha256 FROM honghao_meta.schema_migrations ORDER BY version"
    ).fetchall()
    if rows != [item[:3] for item in files[:len(rows)]]:
        raise RuntimeError("数据库迁移历史与当前代码不匹配，禁止继续")
    return len(rows)


def migrate(url: str, environment: str) -> int:
    if environment not in ENVIRONMENTS:
        raise ValueError("无效的数据库环境")
    files = _migration_files()
    with transaction(url, write=True) as connection:
        initialized = connection.execute(
            "SELECT to_regclass('honghao_meta.schema_migrations')"
        ).fetchone()[0] is not None
        if not initialized and connection.execute(
            "SELECT 1 FROM information_schema.tables "
            "WHERE table_schema NOT IN ('pg_catalog', 'information_schema') LIMIT 1"
        ).fetchone():
            raise RuntimeError("只允许初始化空库；现有数据库没有迁移记录")
        connection.execute("CREATE SCHEMA IF NOT EXISTS honghao_meta")
        connection.execute(
            "CREATE TABLE IF NOT EXISTS honghao_meta.schema_migrations ("
            "version integer PRIMARY KEY, name text NOT NULL, sha256 text NOT NULL, "
            "applied_at timestamptz NOT NULL DEFAULT now())"
        )
        applied = _verify_history(connection, files)
        for version, name, digest, content in files[applied:]:
            connection.execute(content)
            connection.execute(
                "INSERT INTO honghao_meta.schema_migrations (version, name, sha256) VALUES (%s, %s, %s)",
                (version, name, digest),
            )
        connection.execute(
            "INSERT INTO honghao_meta.database_identity (singleton, environment) VALUES (true, %s) "
            "ON CONFLICT (singleton) DO NOTHING", (environment,),
        )
        _check_environment(connection, environment)
    return len(files)


def _check_environment(connection: psycopg.Connection, environment: str) -> None:
    if connection.execute("SELECT environment FROM honghao_meta.database_identity").fetchall() != [(environment,)]:
        raise RuntimeError("数据库属于其他环境，禁止继续")


def readiness(url: str, environment: str) -> dict[str, str]:
    checks = {"database": "failed", "database_environment": "failed", "schema_versions": "failed", "application_role": "failed"}
    try:
        with transaction(url) as connection:
            checks["database"] = "ok"
            _check_environment(connection, environment)
            checks["database_environment"] = "ok"
            files = _migration_files()
            if _verify_history(connection, files) == len(files):
                checks["schema_versions"] = "ok"
            privileged = connection.execute(
                "SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls "
                "OR has_database_privilege(current_user, current_database(), 'CREATE') "
                "OR has_schema_privilege(current_user, 'public', 'CREATE') "
                "OR has_table_privilege(current_user, 'honghao_meta.schema_migrations', 'INSERT,UPDATE,DELETE') "
                "OR has_table_privilege(current_user, 'honghao_meta.database_identity', 'INSERT,UPDATE,DELETE') "
                "FROM pg_roles WHERE rolname = current_user"
            ).fetchone()[0]
            if not privileged:
                checks["application_role"] = "ok"
    except (psycopg.Error, OSError, RuntimeError, ValueError):
        pass
    return checks


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="PostgreSQL 基础迁移与只读就绪检查")
    parser.add_argument("command", choices=("migrate", "doctor"))
    parser.add_argument("--environment", required=True, choices=ENVIRONMENTS)
    args = parser.parse_args(argv)
    try:
        url = database_url()
        if args.command == "migrate":
            print(f"PostgreSQL 迁移完成：version={migrate(url, args.environment)}")
            return 0
        checks = readiness(url, args.environment)
        print(json.dumps(checks, ensure_ascii=False))
        return 0 if all(value == "ok" for value in checks.values()) else 1
    except (psycopg.Error, OSError, RuntimeError, ValueError):
        # libpq errors can contain connection details; do not expose credentials in CLI logs.
        print("PostgreSQL 操作失败；请检查连接、账号权限、环境和迁移版本。未使用 SQLite。")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
