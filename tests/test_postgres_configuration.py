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
