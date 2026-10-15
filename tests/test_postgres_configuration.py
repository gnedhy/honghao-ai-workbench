import pytest
from fastapi.testclient import TestClient

from api import postgres
from api.cli import main
from api.settings import Settings


@pytest.mark.parametrize("value", ["", "sqlite:///local.db", "postgresql:///db", "postgresql://user@localhost/", "password=do-not-print"])
def test_postgres_requires_an_explicit_target_without_leaking_input(value):
    with pytest.raises(ValueError) as error:
        postgres.database_url(value)
    assert "do-not-print" not in str(error.value)


def test_postgres_missing_connection_does_not_use_platform_defaults(monkeypatch, capsys):
    monkeypatch.delenv("HONGHAO_DATABASE_URL", raising=False)
    assert postgres.main(["doctor", "--environment", "test"]) == 1
    assert "未使用 SQLite" in capsys.readouterr().out


def test_connection_failure_stays_unready_and_does_not_expose_credentials(monkeypatch):
    def unavailable(*args, **kwargs):
        raise postgres.psycopg.OperationalError("private-connection-details")
    monkeypatch.setattr(postgres, "connect", unavailable)
    checks = postgres.readiness("postgresql://app@127.0.0.1/honghao_test", "test")
    assert set(checks.values()) == {"failed"}
    assert "private-connection-details" not in str(checks)


@pytest.mark.parametrize("url", ["", "postgresql://app@127.0.0.1:1/honghao_test"])
def test_unavailable_postgres_never_creates_sqlite(tmp_path, monkeypatch, url):
    monkeypatch.setenv("HONGHAO_DATABASE_URL", url)
    monkeypatch.setenv("HONGHAO_DATA_DIR", str(tmp_path / "data"))
    assert main(["migrate"]) == 1
    assert not (tmp_path / "data" / "honghao.db").exists()


def test_selected_postgres_failure_keeps_http_service_unready(tmp_path, monkeypatch):
    monkeypatch.setenv("HONGHAO_DATABASE_URL", "postgresql://app@127.0.0.1:1/honghao_test")
    monkeypatch.setenv("HONGHAO_DATA_DIR", str(tmp_path / "data"))
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("preview", encoding="utf-8")
    started = {}
    monkeypatch.setattr("uvicorn.run", lambda app, **_: started.update(app=app))
    assert main(["serve", "--dist", str(dist)]) == 0
    with TestClient(started["app"]) as client:
        assert client.get("/api/health").status_code == 200
        assert client.get("/api/readiness").status_code == 503
        assert client.post("/api/login", json={"username": "any", "password": "any"}).status_code == 503
    assert not (tmp_path / "data" / "honghao.db").exists()


def test_service_connections_reuse_backends_without_leaking_session_settings(pg_targets):
    url = pg_targets[0]
    with postgres.connect(url) as db:
        baseline = db.execute("SELECT current_user, current_setting('timezone'), current_setting('search_path'), current_setting('statement_timeout'), current_setting('lock_timeout'), current_setting('idle_in_transaction_session_timeout'), current_setting('application_name')").fetchone()
    with postgres.database_lease(url, pooled=True):
        pool = postgres._POOLS[url]
        pool.resize(1, 1)
        backends = set()
        for _ in range(20):
            with postgres.transaction(url) as db:
                backends.add(db.info.backend_pid)
                assert db.execute("SELECT current_user, current_setting('timezone'), current_setting('search_path'), current_setting('statement_timeout'), current_setting('lock_timeout'), current_setting('idle_in_transaction_session_timeout'), current_setting('application_name')").fetchone() == baseline
        assert len(backends) == 1
        with postgres.transaction(url, write=True) as db:
            db.execute("SET application_name='must-not-leak'")
            db.execute("SET timezone='America/New_York'")
            db.execute('SET search_path=pg_catalog')
            db.execute('SET statement_timeout=12345')
            db.execute('SELECT pg_advisory_lock(8123571)')
        with postgres.transaction(url) as db:
            assert db.info.backend_pid in backends
            assert db.execute("SELECT current_user, current_setting('timezone'), current_setting('search_path'), current_setting('statement_timeout'), current_setting('lock_timeout'), current_setting('idle_in_transaction_session_timeout'), current_setting('application_name')").fetchone() == baseline
        with postgres.connect(url) as db:
            assert db.execute('SELECT pg_try_advisory_lock(8123571)').fetchone() == (True,)
    assert pool.closed and url not in postgres._POOLS and url not in postgres._LEASES
    with postgres.database_lease(url):
        assert url not in postgres._POOLS


def test_reused_connections_preserve_rollback_savepoints_and_read_only(pg_targets):
    url = pg_targets[1]
    with postgres.database_lease(url, pooled=True):
        postgres._POOLS[url].resize(1, 1)
        with postgres.transaction(url, write=True) as db:
            db.execute('CREATE TABLE pool_rollback_probe (value integer)')
        with pytest.raises(postgres.psycopg.errors.DivisionByZero):
            with postgres.transaction(url, write=True) as db:
                db.execute('INSERT INTO pool_rollback_probe VALUES (1)')
                db.execute('SELECT 1/0')
        with postgres.transaction(url, write=True) as db:
            assert db.execute('SELECT * FROM pool_rollback_probe').fetchall() == []
            with pytest.raises(postgres.psycopg.errors.DivisionByZero):
                with postgres.transaction(url, write=True) as nested:
                    nested.execute('INSERT INTO pool_rollback_probe VALUES (2)')
                    nested.execute('SELECT 1/0')
            db.execute('INSERT INTO pool_rollback_probe VALUES (3)')
            db.execute('CREATE TEMP TABLE pool_temp_probe (value integer)')
        with postgres.transaction(url) as db:
            assert db.execute('SELECT * FROM pool_rollback_probe').fetchall() == [(3,)]
            assert db.execute("SELECT to_regclass('pg_temp.pool_temp_probe')").fetchone() == (None,)
            with pytest.raises(RuntimeError, match='只读'):
                with postgres.transaction(url, write=True):
                    pass
        with pytest.raises(postgres.psycopg.errors.ReadOnlySqlTransaction):
            with postgres.transaction(url) as db:
                db.execute('INSERT INTO pool_rollback_probe VALUES (4)')


def test_reusable_connections_do_not_bypass_a_lost_service_lease(pg_targets):
    url = pg_targets[1]
    with postgres.database_lease(url, pooled=True) as lease:
        with postgres.transaction(url) as db:
            assert db.execute('SELECT 1').fetchone() == (1,)
        with postgres.connect(url) as terminator:
            assert terminator.execute('SELECT pg_terminate_backend(%s)', (lease.info.backend_pid,)).fetchone() == (True,)
        with pytest.raises(postgres.psycopg.Error):
            with postgres.transaction(url):
                pytest.fail('Lost service lease must fail closed before borrowing a connection')
    assert url not in postgres._POOLS and url not in postgres._LEASES


def test_fixture_connections_reuse_backends_across_schema_changes_and_rollback(pg_targets):
    app, migration = pg_targets
    with postgres.transaction(migration, write=True) as db:
        owner_pid = db.info.backend_pid
        db.execute('CREATE TABLE fixture_pool_probe (value integer)')
        db.execute('INSERT INTO fixture_pool_probe VALUES (1)')
    with postgres.transaction(app) as db:
        app_pid = db.info.backend_pid
        assert db.execute('SELECT value FROM fixture_pool_probe').fetchall() == [(1,)]
        assert db.execute('SHOW transaction_read_only').fetchone() == ('on',)
    with postgres.transaction(migration, write=True) as db:
        db.execute('DROP TABLE fixture_pool_probe')
        db.execute('CREATE TABLE fixture_pool_probe (value text)')
        db.execute("INSERT INTO fixture_pool_probe VALUES ('new schema')")
    with pytest.raises(postgres.psycopg.errors.DivisionByZero):
        with postgres.transaction(migration, write=True) as db:
            db.execute('DELETE FROM fixture_pool_probe')
            db.execute('SELECT 1/0')
    with postgres.transaction(app) as db:
        assert db.execute('SELECT value FROM fixture_pool_probe').fetchall() == [('new schema',)]
    for url, backends in ((app, {app_pid}), (migration, {owner_pid})):
        for _ in range(20):
            with postgres.transaction(url) as db:
                backends.add(db.info.backend_pid)
                assert db.execute('SELECT value FROM fixture_pool_probe').fetchall() == [('new schema',)]
        assert len(backends) <= 2
    assert app not in postgres._LEASES and migration not in postgres._LEASES
