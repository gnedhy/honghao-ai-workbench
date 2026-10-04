"""Provision only the disposable GitHub-hosted PostgreSQL 18 service."""
from __future__ import annotations

import os
from pathlib import Path
import secrets
import sys
from urllib.parse import quote

import psycopg
from psycopg import sql

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from api import postgres


def main() -> None:
    if (os.environ.get("GITHUB_ACTIONS") != "true"
            or os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted"):
        raise RuntimeError("CI provisioning requires a disposable GitHub-hosted runner")
    output = Path(os.environ["GITHUB_ENV"]).resolve()
    if not output.is_relative_to(Path(os.environ["RUNNER_TEMP"]).resolve()):
        raise RuntimeError("GitHub environment file is outside the disposable runner")
    passwords = {name: secrets.token_urlsafe(32) for name in (
        "honghao_test_app", "honghao_test_migration", "honghao_cluster_admin")}
    targets = {name: f"postgresql://{name}:{quote(value, safe='')}@127.0.0.1:55432/"
               + ("postgres" if name == "honghao_cluster_admin" else "honghao_test")
               for name, value in passwords.items()}
    # GitHub consumes masking directives; neither values nor SQL are logged elsewhere.
    for value in [os.environ["CI_POSTGRES_PASSWORD"], *passwords.values(), *targets.values()]:
        print("::add-mask::" + value)
    with psycopg.connect(host="127.0.0.1", port=55432, dbname="postgres", user="postgres",
                         password=os.environ["CI_POSTGRES_PASSWORD"],
                         connect_timeout=5, autocommit=True) as connection:
        if connection.info.server_version // 10000 != 18:
            raise RuntimeError("Isolated CI server must run PostgreSQL 18")
        databases = connection.execute(
            "SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname").fetchall()
        existing = connection.execute("SELECT rolname FROM pg_roles WHERE rolname = ANY(%s)",
                                      (list(passwords),)).fetchall()
        if databases != [("postgres",)] or existing:
            raise RuntimeError("Refusing to provision a non-empty PostgreSQL cluster")
        for name, value in passwords.items():
            createdb = sql.SQL("CREATEDB") if name == "honghao_cluster_admin" else sql.SQL("NOCREATEDB")
            connection.execute(sql.SQL("CREATE ROLE {} LOGIN NOSUPERUSER {} NOCREATEROLE "
                                       "NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD {}")
                               .format(sql.Identifier(name), createdb, sql.Literal(value)))
        # Restore fixture drops its generated database as creator; owner privileges must inherit.
        connection.execute("GRANT honghao_test_migration TO honghao_cluster_admin WITH INHERIT TRUE, SET TRUE")
        connection.execute("CREATE DATABASE honghao_test OWNER honghao_test_migration "
                           "TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'")
        connection.execute("REVOKE ALL ON DATABASE honghao_test FROM PUBLIC")
        connection.execute("GRANT CONNECT ON DATABASE honghao_test TO honghao_test_app")
    migration = targets["honghao_test_migration"]
    postgres.migrate(migration, "test")
    with postgres.transaction(migration, write=True) as connection:
        connection.execute("REVOKE CREATE ON SCHEMA public FROM PUBLIC")
        connection.execute("GRANT USAGE ON SCHEMA public, honghao_meta TO honghao_test_app")
        connection.execute("GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO honghao_test_app")
        connection.execute("GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO honghao_test_app")
        connection.execute("GRANT SELECT ON ALL TABLES IN SCHEMA honghao_meta TO honghao_test_app")
        connection.execute("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE "
                           "ON TABLES TO honghao_test_app")
        connection.execute("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE,SELECT "
                           "ON SEQUENCES TO honghao_test_app")
    if set(postgres.readiness(targets["honghao_test_app"], "test").values()) != {"ok"}:
        raise RuntimeError("Restricted application role did not pass readiness")
    variables = {"HONGHAO_TEST_DATABASE_URL": targets["honghao_test_app"],
                 "HONGHAO_TEST_MIGRATION_URL": migration,
                 "HONGHAO_TEST_CLUSTER_URL": targets["honghao_cluster_admin"],
                 "HONGHAO_DATABASE_ENVIRONMENT": "test"}
    with output.open("a", encoding="utf-8") as stream:
        for key, value in variables.items():
            stream.write(f"{key}={value}\n")
    print("PASS isolated PostgreSQL 18; migration, restricted app, restore creator ready")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Native connection errors can contain generated credentials; fail without echoing them.
        print("CI PostgreSQL provisioning failed; refusing to continue", file=sys.stderr)
        raise SystemExit(1) from None
