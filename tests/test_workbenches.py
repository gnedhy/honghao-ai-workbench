import json
import sqlite3
from pathlib import Path

import pytest
from api.database import Database
from api.modules import default_module_modes
from api.settings import Settings
from tests.helpers import authenticated_client


def test_workbench_registry_defaults_to_prototypes(tmp_path: Path) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")

    with authenticated_client(settings) as client:
        response = client.get("/api/workbenches")

    assert response.status_code == 200
    assert response.json() == [
        {"id": "management", "mode": "prototype"},
        {"id": "procurement", "mode": "prototype"},
        {"id": "research", "mode": "prototype"},
        {"id": "sales", "mode": "prototype"},
    ]


def test_workbench_registry_reads_independent_environment_modes(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("HONGHAO_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("HONGHAO_WORKBENCH_PROCUREMENT_MODE", "active")
    monkeypatch.setenv("HONGHAO_WORKBENCH_SALES_MODE", "off")
    settings = Settings.from_environment()

    with authenticated_client(settings) as client:
        response = client.get("/api/workbenches")

    assert response.status_code == 200
    assert response.json() == [
        {"id": "management", "mode": "prototype"},
        {"id": "procurement", "mode": "active"},
        {"id": "research", "mode": "prototype"},
        {"id": "sales", "mode": "off"},
    ]


def test_invalid_workbench_mode_stops_startup(monkeypatch) -> None:
    monkeypatch.setenv("HONGHAO_WORKBENCH_RESEARCH_MODE", "enabled")

    with pytest.raises(
        ValueError,
        match="HONGHAO_WORKBENCH_RESEARCH_MODE must be prototype, active, or off",
    ):
        Settings.from_environment()


def test_production_rejects_workbench_mode_environment_override(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("HONGHAO_ENVIRONMENT", "production")
    monkeypatch.setenv("HONGHAO_DATA_DIR", str(tmp_path / "production"))
    monkeypatch.setenv("HONGHAO_WORKBENCH_PROCUREMENT_MODE", "active")

    with pytest.raises(ValueError, match="Production workbench modes must be changed through admin settings"):
        Settings.from_environment()


def test_production_workbench_activation_requires_and_records_reviews(tmp_path: Path) -> None:
    data_dir = tmp_path / "production"
    settings = Settings.from_data_dir(data_dir, environment="production")
    evidence = {
        "issue_url": "https://github.com/gnedhy/honghao-ai-workbench/issues/23",
        "pull_request_url": "https://github.com/gnedhy/honghao-ai-workbench/pull/57",
    }

    with authenticated_client(settings) as client:
        blocked = client.put(
            "/api/admin/workbench-settings/procurement",
            json={"mode": "active", "reviews": ["business", "security", "code"], **evidence},
        )
        allowed = client.put(
            "/api/admin/workbench-settings/procurement",
            json={
                "mode": "active",
                "reviews": ["business", "security", "code", "rollback"],
                **evidence,
            },
        )

    assert blocked.status_code == 422
    assert allowed.status_code == 200
    assert allowed.json()["pending_mode"] == "active"
    config = json.loads((data_dir / "workbench-runtime-config.json").read_text(encoding="utf-8"))
    record = config["activation_reviews"]["procurement"]
    assert record["checks"] == ["business", "code", "rollback", "security"]
    assert record["reviewed_by"]
    assert record["reviewed_at"]
    assert record["issue_url"].endswith("/issues/23")
    assert record["pull_request_url"].endswith("/pull/57")

    restarted_settings = Settings.from_data_dir(data_dir, environment="production")
    assert restarted_settings.workbench_modes["procurement"] == "active"


def test_core_schema_ignores_additive_workbench_tables(tmp_path: Path) -> None:
    module_modes = default_module_modes()
    module_modes["chat"] = "active"
    settings = Settings.from_data_dir(tmp_path / "data", module_modes=module_modes)
    with authenticated_client(settings):
        pass

    with sqlite3.connect(settings.database_path) as connection:
        connection.execute(
            "INSERT INTO schema_metadata (key, value) VALUES (?, ?)",
            ("workbench_procurement_schema_version", 1),
        )
        connection.execute(
            "CREATE TABLE procurement_cost_baselines (id TEXT PRIMARY KEY, version INTEGER NOT NULL)"
        )

    with authenticated_client(settings) as client:
        health = client.get("/api/health")
        project = client.post("/api/projects", json={"title": "采购成本验证"})

    assert health.status_code == 200
    assert Database(settings.database_path).schema_version() == 5
    assert project.status_code == 201
