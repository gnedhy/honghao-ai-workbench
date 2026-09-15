"""Run explicitly against the dedicated, empty-business-data PostgreSQL test database."""
import os
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal
from threading import Event, current_thread

import psycopg
import pytest
from psycopg.conninfo import conninfo_to_dict

from api import postgres


@pytest.fixture
def targets():
    app = postgres.database_url(os.environ["HONGHAO_TEST_DATABASE_URL"])
    migration = postgres.database_url(os.environ["HONGHAO_TEST_MIGRATION_URL"])
    for url in (app, migration):
        parts = conninfo_to_dict(url)
        if parts["dbname"] != "honghao_test" or parts["host"] != "127.0.0.1":
            pytest.fail("Foundation tests require the dedicated local honghao_test database")
    with postgres.transaction(app) as connection:
        postgres._check_environment(connection, "test")
    return app, migration


@pytest.fixture
def probe(targets):
    app, migration = targets
    with postgres.transaction(migration, write=True) as connection:
        connection.execute("CREATE TABLE foundation_probe (id integer PRIMARY KEY, amount text, salt bytea)")
    try:
        yield app, migration
    finally:
        with postgres.transaction(migration, write=True) as connection:
            connection.execute("DROP TABLE foundation_probe")


def test_runtime_role_and_environment(targets):
    app, migration = targets
    assert set(postgres.readiness(app, "test").values()) == {"ok"}
    assert postgres.readiness(app, "acceptance")["database_environment"] == "failed"
    assert postgres.readiness(migration, "test")["application_role"] == "failed"


def test_transactions_preserve_precision_bytes_and_rollback(probe):
    app, _ = probe
    amount = Decimal("0.123456789012345678901234567890")
    salt = bytes(range(32))
    with postgres.transaction(app, write=True) as connection:
        connection.execute("INSERT INTO foundation_probe VALUES (%s, %s, %s)", (1, str(amount), salt))
    with pytest.raises(ZeroDivisionError):
        with postgres.transaction(app, write=True) as connection:
            connection.execute("UPDATE foundation_probe SET amount = '0' WHERE id = 1")
            1 / 0
    with postgres.transaction(app) as connection:
        assert connection.execute("SELECT amount, salt FROM foundation_probe").fetchall() == [(str(amount), salt)]


def test_reads_reject_writes_and_application_cannot_change_schema(probe):
    app, _ = probe
    with pytest.raises(psycopg.errors.ReadOnlySqlTransaction):
        with postgres.transaction(app) as connection:
            connection.execute("INSERT INTO foundation_probe (id) VALUES (2)")
    for statement in (
        "CREATE TABLE must_not_exist (id integer)",
        "DROP TABLE foundation_probe",
        "UPDATE honghao_meta.database_identity SET environment = 'production'",
        "DELETE FROM honghao_meta.schema_migrations",
    ):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            with postgres.transaction(app, write=True) as connection:
                connection.execute(statement)


def test_migrations_are_idempotent_and_wrong_environment_rolls_back(targets):
    app, migration = targets
    assert postgres.migrate(migration, "test") == len(postgres._migration_files())
    assert postgres.migrate(migration, "test") == len(postgres._migration_files())
    with pytest.raises(RuntimeError, match="其他环境"):
        postgres.migrate(migration, "production")
    assert set(postgres.readiness(app, "test").values()) == {"ok"}


def test_modified_migration_is_rejected(targets, tmp_path, monkeypatch):
    app, migration = targets
    for _, name, _, content in postgres._migration_files():
        (tmp_path / name).write_text(content + "\n-- tampered\n", encoding="utf-8")
    monkeypatch.setattr(postgres, "MIGRATIONS", tmp_path)
    with pytest.raises(RuntimeError, match="迁移历史"):
        postgres.migrate(migration, "test")
    assert postgres.readiness(app, "test")["schema_versions"] == "failed"


def test_failed_migration_rolls_back_ddl_and_history(targets, tmp_path, monkeypatch):
    app, migration = targets
    files = postgres._migration_files()
    for _, name, _, content in files:
        (tmp_path / name).write_bytes(content.encode("utf-8"))
    (tmp_path / f"{len(files)+1:04d}_failure.sql").write_text(
        "CREATE TABLE should_roll_back (id integer); SELECT 1 / 0;", encoding="utf-8",
    )
    monkeypatch.setattr(postgres, "MIGRATIONS", tmp_path)
    with pytest.raises(psycopg.errors.DivisionByZero):
        postgres.migrate(migration, "test")
    with postgres.transaction(app) as connection:
        assert connection.execute("SELECT to_regclass('public.should_roll_back')").fetchone() == (None,)
        assert connection.execute("SELECT count(*) FROM honghao_meta.schema_migrations").fetchone() == (len(files),)


def test_write_lock_waits_and_releases_after_rollback(probe):
    app, _ = probe
    entered = Event()
    def second_write():
        entered.set()
        with postgres.transaction(app, write=True) as connection:
            connection.execute("INSERT INTO foundation_probe (id) VALUES (2)")
    with ThreadPoolExecutor(max_workers=1) as executor:
        with pytest.raises(ValueError, match="rollback"):
            with postgres.transaction(app, write=True) as first:
                first.execute("INSERT INTO foundation_probe (id) VALUES (1)")
                future = executor.submit(second_write)
                assert entered.wait(2)
                # Database proves exclusion without depending on animation or wall-clock delays.
                with postgres.connect(app) as competing, competing.transaction():
                    assert competing.execute("SELECT pg_try_advisory_xact_lock(%s)", (postgres.WRITE_LOCK,)).fetchone() == (False,)
                assert not future.done()
                raise ValueError("rollback")
        future.result(timeout=15)
    with postgres.transaction(app) as connection:
        assert connection.execute("SELECT id FROM foundation_probe ORDER BY id").fetchall() == [(2,)]


def test_nested_calls_share_connection_and_failed_savepoint_preserves_outer_write(probe):
    app, _ = probe
    with postgres.transaction(app, write=True) as outer:
        outer.execute("INSERT INTO foundation_probe (id) VALUES (1)")
        with postgres.transaction(app) as reader:
            assert reader is outer
            assert reader.execute("SELECT count(*) FROM foundation_probe").fetchone() == (1,)
        with pytest.raises(psycopg.errors.UniqueViolation):
            with postgres.transaction(app, write=True) as nested:
                assert nested is outer
                nested.execute("INSERT INTO foundation_probe (id) VALUES (1)")
        outer.execute("INSERT INTO foundation_probe (id) VALUES (2)")
    with postgres.transaction(app) as reader:
        assert reader.execute("SELECT id FROM foundation_probe ORDER BY id").fetchall() == [(1,), (2,)]


def test_read_transaction_keeps_one_snapshot_during_external_write(probe):
    app, _ = probe
    with postgres.transaction(app) as reader:
        assert reader.execute("SELECT count(*) FROM foundation_probe").fetchone() == (0,)
        with postgres.connect(app) as writer:
            writer.execute("INSERT INTO foundation_probe (id) VALUES (1)")
        with postgres.transaction(app) as nested:
            assert nested.execute("SELECT count(*) FROM foundation_probe").fetchone() == (0,)
        with pytest.raises(RuntimeError, match="不能升级"):
            with postgres.transaction(app, write=True):
                pytest.fail("read transaction unexpectedly became writable")
    with postgres.transaction(app) as reader:
        assert reader.execute("SELECT count(*) FROM foundation_probe").fetchone() == (1,)


def test_nested_calls_cannot_switch_database_identity(targets):
    app, migration = targets
    with postgres.transaction(app):
        with pytest.raises(RuntimeError, match="不能切换"):
            with postgres.transaction(migration):
                pytest.fail("nested transaction unexpectedly changed connection")


def test_database_lease_blocks_a_second_service_and_releases_on_failure(targets):
    app, _ = targets
    with pytest.raises(ValueError, match="service failed"):
        with postgres.database_lease(app):
            with pytest.raises(RuntimeError, match="已有服务"):
                with postgres.database_lease(app):
                    pytest.fail("second service unexpectedly acquired the database")
            raise ValueError("service failed")
    with postgres.database_lease(app):
        pass


def test_lost_service_lease_rejects_new_work_until_service_restarts(probe):
    app, _ = probe
    with postgres.database_lease(app) as lease:
        with postgres.connect(app) as terminator:
            assert terminator.execute("SELECT pg_terminate_backend(%s)", (lease.info.backend_pid,)).fetchone() == (True,)
        with pytest.raises(psycopg.OperationalError):
            with postgres.transaction(app, write=True) as db:
                db.execute("INSERT INTO foundation_probe (id) VALUES (1)")
        assert postgres.readiness(app, "test")["database"] == "failed"
    with postgres.database_lease(app), postgres.transaction(app, write=True) as db:
        assert db.execute("SELECT count(*) FROM foundation_probe").fetchone() == (0,)
        db.execute("INSERT INTO foundation_probe (id) VALUES (2)")


def test_lost_service_lease_rolls_back_in_flight_business_write(probe):
    app, _ = probe
    with postgres.database_lease(app) as lease:
        with pytest.raises(psycopg.OperationalError):
            with postgres.transaction(app, write=True) as db:
                db.execute("INSERT INTO foundation_probe (id) VALUES (1)")
                with postgres.connect(app) as terminator:
                    terminator.execute("SELECT pg_terminate_backend(%s)", (lease.info.backend_pid,))
    with postgres.transaction(app) as db:
        assert db.execute("SELECT count(*) FROM foundation_probe").fetchone() == (0,)


def test_lost_service_lease_while_waiting_for_write_lock_cannot_write(probe, monkeypatch):
    app, _ = probe
    connected = Event()
    original_connect = postgres.connect
    def tracked_connect(url=None):
        connection = original_connect(url)
        if current_thread().name.startswith('waiting-write'):
            connected.set()
        return connection
    monkeypatch.setattr(postgres, 'connect', tracked_connect)
    def write():
        with postgres.transaction(app, write=True) as db:
            db.execute("INSERT INTO foundation_probe (id) VALUES (1)")
    with postgres.database_lease(app) as lease, ThreadPoolExecutor(max_workers=1, thread_name_prefix='waiting-write') as pool:
        with postgres.connect(app) as blocker, blocker.transaction():
            blocker.execute('SELECT pg_advisory_xact_lock(%s)', (postgres.WRITE_LOCK,))
            future = pool.submit(write)
            assert connected.wait(5)
            blocker.execute('SELECT pg_terminate_backend(%s)', (lease.info.backend_pid,))
        with pytest.raises(psycopg.OperationalError):
            future.result(timeout=15)
    with postgres.transaction(app) as db:
        assert db.execute('SELECT count(*) FROM foundation_probe').fetchone() == (0,)
