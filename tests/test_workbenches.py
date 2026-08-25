import sqlite3
from pathlib import Path

import pytest
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
    assert health.json()["schema_version"] == 5
    assert project.status_code == 201
