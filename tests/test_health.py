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
        "schema_version": 4,
    }
    assert first_response.status_code == 200
    assert first_response.json() == expected
    assert restarted_response.status_code == 200
    assert restarted_response.json() == expected
