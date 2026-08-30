import sqlite3
from contextlib import closing
from pathlib import Path

from fastapi.testclient import TestClient

from api.main import create_app
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
        "schema_version": 5,
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
        with closing(sqlite3.connect(settings.database_path)) as connection:
            connection.execute(
                "UPDATE schema_metadata SET value = 999 WHERE key = 'schema_version'"
            )
            connection.commit()
        unavailable = client.get("/api/readiness")

    assert ready.status_code == 200
    assert ready.json() == {
        "status": "ready",
        "checks": {
            "data_directory": "ok",
            "database": "ok",
            "module_configuration": "ok",
            "schema_versions": "ok",
        },
    }
    assert unavailable.status_code == 503
    assert unavailable.json()["status"] == "not_ready"
    assert unavailable.json()["checks"]["database"] == "ok"
    assert unavailable.json()["checks"]["schema_versions"] == "failed"


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
