"""Real PostgreSQL tests. Only the explicit local test database may be reset."""
import os
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4

import psycopg
import pytest
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict

from api import postgres


def _test_target(variable, user):
    value = os.environ.get(variable, "")
    try:
        parts = conninfo_to_dict(postgres.database_url(value))
        assert parts.get("host") == "127.0.0.1" and parts.get("dbname") == "honghao_test"
        assert parts.get("user") == user
    except (AssertionError, ValueError, psycopg.Error):
        raise pytest.UsageError(f"{variable} must explicitly select the dedicated local test account") from None
    return value


def _grant_app(connection):
    connection.execute("GRANT USAGE ON SCHEMA public, honghao_meta TO honghao_test_app")
    connection.execute("GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO honghao_test_app")
    connection.execute("GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO honghao_test_app")
    connection.execute("GRANT SELECT ON ALL TABLES IN SCHEMA honghao_meta TO honghao_test_app")
    connection.execute("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO honghao_test_app")
    connection.execute("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO honghao_test_app")
    connection.execute("REVOKE CREATE ON SCHEMA public FROM PUBLIC")


@pytest.fixture(scope="session")
def pg_targets():
    app = _test_target("HONGHAO_TEST_DATABASE_URL", "honghao_test_app")
    migration = _test_target("HONGHAO_TEST_MIGRATION_URL", "honghao_test_migration")
    # Serialize complete test runs: independent pytest processes must not reset each other's data.
    with postgres.connect(migration) as run_lock:
        run_lock.execute("SELECT pg_advisory_lock(%s)", (postgres.WRITE_LOCK + 1,))
        postgres.migrate(migration, "test")
        yield app, migration


@pytest.fixture(autouse=True)
def isolated_postgres(pg_targets, monkeypatch):
    app, migration = pg_targets
    with postgres.transaction(migration, write=True) as connection:
        postgres._check_environment(connection, "test")
        connection.execute("DROP SCHEMA public CASCADE")
        connection.execute("CREATE SCHEMA public")
        for _, _, _, content in postgres._migration_files()[1:]:
            connection.execute(content)
        _grant_app(connection)
    monkeypatch.setenv("HONGHAO_DATABASE_URL", app)
    monkeypatch.setenv("HONGHAO_DATABASE_ENVIRONMENT", "test")
    yield


@pytest.fixture
def second_pg(pg_targets):
    """A generated database for restore/isolation tests; never an existing database."""
    admin = os.environ.get("HONGHAO_TEST_CLUSTER_URL", "")
    try:
        parts = conninfo_to_dict(postgres.database_url(admin))
        assert parts.get("host") == "127.0.0.1" and parts.get("dbname") == "postgres"
        assert parts.get("user") == "honghao_cluster_admin"
    except (ValueError, AssertionError, psycopg.Error):
        raise pytest.UsageError("Restore tests need an explicitly supplied local test database creator") from None
    name = "honghao_test_restore_" + uuid4().hex
    def target(url):
        parts = urlsplit(url)
        return urlunsplit(parts._replace(path="/" + name))
    app, migration = map(target, pg_targets)
    with postgres.connect(admin) as connection:
        connection.execute(sql.SQL("CREATE DATABASE {} OWNER honghao_test_migration TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'").format(sql.Identifier(name)))
        connection.execute(sql.SQL("REVOKE ALL ON DATABASE {} FROM PUBLIC").format(sql.Identifier(name)))
        connection.execute(sql.SQL("GRANT CONNECT ON DATABASE {} TO honghao_test_app").format(sql.Identifier(name)))
    try:
        postgres.migrate(migration, "test")
        with postgres.transaction(migration, write=True) as connection:
            _grant_app(connection)
        yield {"url": app, "migration_url": migration, "environment": "test"}
    finally:
        # name is generated here; no user-controlled or pre-existing database can reach DROP.
        with postgres.connect(admin) as connection:
            connection.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(name)))
