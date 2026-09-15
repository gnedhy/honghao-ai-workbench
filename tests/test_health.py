import os
from pathlib import Path

from fastapi.testclient import TestClient

from api.main import create_app
from api.postgres import transaction
from api.settings import Settings


def test_health_reports_database_schema_after_repeated_startup(tmp_path: Path) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")

    with TestClient(create_app(settings)) as first_client:
        first_response = first_client.get("/api/health")

    with TestClient(create_app(settings)) as restarted_client:
        restarted_response = restarted_client.get("/api/health")

    expected = {
        "status": "ok",
        "service": "honghao-ai-api",
        "api_version": "0.1.0",
        "environment": "test",
    }
    assert first_response.status_code == 200
    assert first_response.json() == expected
    assert restarted_response.status_code == 200
    assert restarted_response.json() == expected


def test_readiness_reports_runtime_dependencies_and_detects_missing_database(
    tmp_path: Path,
) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")

    with TestClient(create_app(settings)) as client:
        ready = client.get("/api/readiness")
        with transaction(settings.database_url, write=True) as connection:
            connection.execute(
                "UPDATE schema_metadata SET value = 999 WHERE key = 'schema_version'"
            )
        unavailable = client.get("/api/readiness")
        alive = client.get("/api/health")

    assert ready.status_code == 200
    assert ready.json() == {
        "status": "ready",
        "checks": {
            "data_directory": "ok",
            "database": "ok",
            "database_environment": "ok",
            "application_role": "ok",
            "module_configuration": "ok",
            "runtime_startup": "ok",
            "schema_versions": "ok",
        },
    }
    assert unavailable.status_code == 503
    assert unavailable.json()["status"] == "not_ready"
    assert unavailable.json()["checks"]["database"] == "ok"
    assert unavailable.json()["checks"]["schema_versions"] == "failed"
    assert alive.status_code == 200
    assert alive.json() == {
        "status": "ok",
        "service": "honghao-ai-api",
        "api_version": "0.1.0",
        "environment": "test",
    }


def test_migration_mismatch_starts_degraded_and_reports_not_ready(tmp_path: Path) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")
    with TestClient(create_app(settings)):
        pass
    with transaction(settings.database_url, write=True) as connection:
        connection.execute(
            "UPDATE schema_metadata SET value = 999 WHERE key = 'schema_version'"
        )

    with TestClient(create_app(settings)) as client:
        health = client.get("/api/health")
        readiness = client.get("/api/readiness")
        protected = client.get("/api/modules")

    assert health.status_code == 200
    assert readiness.status_code == 503
    assert readiness.json()["checks"]["schema_versions"] == "failed"
    assert protected.status_code == 503


def test_missing_knowledge_view_blocks_startup_without_implicit_repair(tmp_path: Path) -> None:
    settings = Settings.from_data_dir(tmp_path / "missing-view")
    with transaction(os.environ["HONGHAO_TEST_MIGRATION_URL"], write=True) as connection:
        connection.execute("DROP VIEW knowledge_derived_index")
    with TestClient(create_app(settings)) as client:
        assert client.get("/api/readiness").status_code == 503
        assert client.get("/api/modules").status_code == 503
    with transaction(settings.database_url) as connection:
        assert connection.execute("SELECT to_regclass('public.knowledge_derived_index')").fetchone() == (None,)


def test_startup_failure_cannot_report_ready(tmp_path: Path) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")
    with TestClient(create_app(settings)):
        pass

    marker = settings.data_dir / ".service.pid"
    marker.write_text(f"service:{os.getpid()}", encoding="ascii")
    try:
        with TestClient(create_app(settings)) as client:
            health = client.get("/api/health")
            readiness = client.get("/api/readiness")
            protected = client.get("/api/modules")
    finally:
        marker.unlink(missing_ok=True)

    assert health.status_code == 200
    assert readiness.status_code == 503
    assert readiness.json()["checks"]["runtime_startup"] == "failed"
    assert protected.status_code == 503


def test_production_app_serves_static_assets_and_spa_routes(tmp_path: Path) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<main>宏昊 AI</main>", encoding="utf-8")
    (dist / "assets" / "app.js").write_text("window.ready = true", encoding="utf-8")

    with TestClient(create_app(settings, static_dir=dist)) as client:
        home = client.get("/")
        nested = client.get("/workbenches/procurement")
        asset = client.get("/assets/app.js")
        missing_api = client.get("/api/not-found")

    assert home.status_code == 200
    assert "宏昊 AI" in home.text
    assert nested.status_code == 200
    assert "宏昊 AI" in nested.text
    assert asset.text == "window.ready = true"
    assert missing_api.status_code == 401
