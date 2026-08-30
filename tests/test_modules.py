import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from api.main import create_app
from api.modules import default_module_modes
from api.settings import Settings
from tests.helpers import authenticated_client


def test_module_registry_defaults_to_workbench_only(tmp_path: Path) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")

    with authenticated_client(settings) as client:
        response = client.get("/api/modules")

    assert response.status_code == 200
    assert response.json() == [
        {"id": "chat", "mode": "off"},
        {"id": "knowledge", "mode": "off"},
        {"id": "automation", "mode": "off"},
        {"id": "workbench", "mode": "active"},
        {"id": "tasks", "mode": "off"},
    ]


def test_admin_can_read_environment_and_pending_module_settings(tmp_path: Path) -> None:
    settings = Settings.from_data_dir(tmp_path / "data", environment="test")

    with authenticated_client(settings) as client:
        response = client.get("/api/admin/module-settings")

    assert response.status_code == 200
    assert response.json() == {
        "environment": "test",
        "modules": [
            {"id": "chat", "current_mode": "off", "pending_mode": "off"},
            {"id": "knowledge", "current_mode": "off", "pending_mode": "off"},
            {"id": "automation", "current_mode": "off", "pending_mode": "off"},
            {"id": "workbench", "current_mode": "active", "pending_mode": "active"},
            {"id": "tasks", "current_mode": "off", "pending_mode": "off"},
        ],
        "workbenches": [
            {"id": "management", "current_mode": "prototype", "pending_mode": "prototype"},
            {"id": "procurement", "current_mode": "prototype", "pending_mode": "prototype"},
            {"id": "research", "current_mode": "prototype", "pending_mode": "prototype"},
            {"id": "sales", "current_mode": "prototype", "pending_mode": "prototype"},
        ],
    }


def test_module_mode_change_is_pending_until_restart(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    settings = Settings.from_data_dir(data_dir, environment="test")

    with authenticated_client(settings) as client:
        changed = client.put(
            "/api/admin/module-settings/knowledge",
            json={"mode": "active", "reviews": []},
        )
        running = client.get("/api/modules")

    assert changed.status_code == 200
    assert changed.json() == {
        "id": "knowledge",
        "current_mode": "off",
        "pending_mode": "active",
    }
    assert next(item for item in running.json() if item["id"] == "knowledge")["mode"] == "off"

    restarted_settings = Settings.from_data_dir(data_dir, environment="test")
    with authenticated_client(restarted_settings) as restarted_client:
        restarted = restarted_client.get("/api/modules")
        applied = restarted_client.get("/api/admin/module-settings")

    assert next(item for item in restarted.json() if item["id"] == "knowledge")["mode"] == "active"
    assert next(item for item in applied.json()["modules"] if item["id"] == "knowledge") == {
        "id": "knowledge",
        "current_mode": "active",
        "pending_mode": "active",
    }


def test_production_activation_requires_and_records_all_four_reviews(tmp_path: Path) -> None:
    data_dir = tmp_path / "production"
    settings = Settings.from_data_dir(data_dir, environment="production")

    with authenticated_client(settings) as client:
        blocked = client.put(
            "/api/admin/module-settings/knowledge",
            json={
                "mode": "active",
                "reviews": ["business", "security", "code"],
                "issue_url": "https://github.com/gnedhy/honghao-ai-workbench/issues/43",
                "pull_request_url": "https://github.com/gnedhy/honghao-ai-workbench/pull/56",
            },
        )
        allowed = client.put(
            "/api/admin/module-settings/knowledge",
            json={
                "mode": "active",
                "reviews": ["business", "security", "code", "rollback"],
                "issue_url": "https://github.com/gnedhy/honghao-ai-workbench/issues/43",
                "pull_request_url": "https://github.com/gnedhy/honghao-ai-workbench/pull/56",
            },
        )

    assert blocked.status_code == 422
    assert blocked.json() == {
        "detail": "Production activation requires business, security, code, and rollback reviews"
    }
    assert allowed.status_code == 200
    assert allowed.json()["pending_mode"] == "active"
    config = json.loads((data_dir / "runtime-config.json").read_text(encoding="utf-8"))
    record = config["activation_reviews"]["knowledge"]
    assert record["checks"] == [
        "business",
        "code",
        "rollback",
        "security",
    ]
    assert record["issue_url"].endswith("/issues/43")
    assert record["pull_request_url"].endswith("/pull/56")
    assert record["reviewed_by"]
    assert record["reviewed_at"]

    restarted_settings = Settings.from_data_dir(data_dir, environment="production")
    with authenticated_client(restarted_settings) as restarted_client:
        restarted = restarted_client.get("/api/modules")

    assert next(item for item in restarted.json() if item["id"] == "knowledge")["mode"] == "active"

    with authenticated_client(restarted_settings) as restarted_client:
        downgraded = restarted_client.put(
            "/api/admin/module-settings/knowledge",
            json={"mode": "prototype", "reviews": []},
        )
        audit = restarted_client.get("/api/admin/audit-events")

    assert downgraded.status_code == 200
    config = json.loads((data_dir / "runtime-config.json").read_text(encoding="utf-8"))
    assert config["activation_reviews"]["knowledge"] == record
    assert [entry["mode"] for entry in config["activation_history"]] == ["active", "prototype"]
    assert audit.json()[0]["action"] == "module.mode.prototype"


def test_fresh_production_starts_with_every_module_off(tmp_path: Path) -> None:
    settings = Settings.from_data_dir(tmp_path / "production", environment="production")

    with authenticated_client(settings) as client:
        response = client.get("/api/modules")

    assert response.status_code == 200
    assert all(item["mode"] == "off" for item in response.json())


def test_fresh_production_from_environment_starts_with_every_module_off(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setenv("HONGHAO_DATA_DIR", str(tmp_path / "production"))
    monkeypatch.setenv("HONGHAO_ENVIRONMENT", "production")

    settings = Settings.from_environment()

    assert all(mode == "off" for mode in settings.module_modes.values())


def test_production_rejects_active_module_without_recorded_reviews(tmp_path: Path) -> None:
    data_dir = tmp_path / "production"
    data_dir.mkdir()
    (data_dir / "runtime-config.json").write_text(
        json.dumps({
            "version": 1,
            "environment": "production",
            "module_modes": {**default_module_modes("production"), "knowledge": "active"},
        }),
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="require recorded reviews"):
        Settings.from_data_dir(data_dir, environment="production")


def test_production_rejects_malformed_activation_reviews_as_configuration_error(
    tmp_path: Path,
) -> None:
    data_dir = tmp_path / "production"
    data_dir.mkdir()
    (data_dir / "runtime-config.json").write_text(
        json.dumps({
            "version": 1,
            "environment": "production",
            "module_modes": {**default_module_modes("production"), "knowledge": "active"},
            "reviewed_active_modules": ["knowledge"],
            "activation_reviews": {
                "knowledge": {
                    "checks": ["business", "code", "rollback", "security"],
                    "reviewed_by": "not-a-user-id",
                    "reviewed_at": "not-a-date",
                    "issue_url": "x",
                    "pull_request_url": "y",
                }
            },
        }),
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="activation_reviews"):
        Settings.from_data_dir(data_dir, environment="production")


def test_non_admin_cannot_read_or_change_module_settings(tmp_path: Path) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")
    app = create_app(settings)

    with authenticated_client(settings) as admin, TestClient(app) as employee:
        created = admin.post(
            "/api/users",
            json={
                "username": "employee",
                "display_name": "普通员工",
                "department": None,
                "password": "Employee-Password-2026",
            },
        )
        assert created.status_code == 201
        login = employee.post(
            "/api/login",
            json={"username": "employee", "password": "Employee-Password-2026"},
        )
        assert login.status_code == 200

        read = employee.get("/api/admin/module-settings")
        write = employee.put(
            "/api/admin/module-settings/knowledge",
            json={"mode": "active", "reviews": []},
        )

    assert read.status_code == 403
    assert write.status_code == 403
    assert not (settings.data_dir / "runtime-config.json").exists()


def test_runtime_configuration_cannot_be_reused_by_another_environment(tmp_path: Path) -> None:
    data_dir = tmp_path / "shared-by-mistake"
    settings = Settings.from_data_dir(data_dir, environment="test")

    with authenticated_client(settings) as client:
        response = client.put(
            "/api/admin/module-settings/knowledge",
            json={"mode": "prototype", "reviews": []},
        )

    assert response.status_code == 200
    with pytest.raises(ValueError, match="different environment"):
        Settings.from_data_dir(data_dir, environment="production")


def test_started_data_directory_is_bound_to_its_environment(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    settings = Settings.from_data_dir(data_dir, environment="test")

    with TestClient(create_app(settings)) as client:
        assert client.get("/api/health").status_code == 200

    assert (data_dir / "environment").read_text(encoding="utf-8") == "test"
    with pytest.raises(ValueError, match="different environment"):
        Settings.from_data_dir(data_dir, environment="production")


def test_unregistered_module_cannot_be_enabled(tmp_path: Path) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")

    with authenticated_client(settings) as client:
        response = client.put(
            "/api/admin/module-settings/not-installed",
            json={"mode": "active", "reviews": []},
        )

    assert response.status_code == 404
    assert response.json() == {"detail": "Module not found"}


def test_module_mode_change_audit_distinguishes_target_mode(tmp_path: Path) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")

    with authenticated_client(settings) as client:
        changed = client.put(
            "/api/admin/module-settings/knowledge",
            json={"mode": "prototype", "reviews": []},
        )
        events = client.get("/api/admin/audit-events")

    assert changed.status_code == 200
    event = next(item for item in events.json() if item["action"] == "module.mode.prototype")
    assert event["target_type"] == "module"
    assert event["target_id"] == "knowledge"


def test_module_registry_reads_environment_modes(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("HONGHAO_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("HONGHAO_MODULE_KNOWLEDGE_MODE", "prototype")
    monkeypatch.setenv("HONGHAO_MODULE_WORKBENCH_MODE", "off")
    settings = Settings.from_environment()

    with authenticated_client(settings) as client:
        response = client.get("/api/modules")

    assert response.status_code == 200
    assert response.json() == [
        {"id": "chat", "mode": "off"},
        {"id": "knowledge", "mode": "prototype"},
        {"id": "automation", "mode": "off"},
        {"id": "workbench", "mode": "off"},
        {"id": "tasks", "mode": "off"},
    ]


def test_invalid_module_mode_stops_startup(monkeypatch) -> None:
    monkeypatch.setenv("HONGHAO_MODULE_CHAT_MODE", "enabled")

    with pytest.raises(
        ValueError,
        match="HONGHAO_MODULE_CHAT_MODE must be off, prototype, or active",
    ):
        Settings.from_environment()


def test_production_cannot_bypass_review_gate_with_module_environment_variables(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setenv("HONGHAO_DATA_DIR", str(tmp_path / "production"))
    monkeypatch.setenv("HONGHAO_ENVIRONMENT", "production")
    monkeypatch.setenv("HONGHAO_MODULE_KNOWLEDGE_MODE", "active")

    with pytest.raises(
        ValueError,
        match="Production module modes must be changed through admin settings",
    ):
        Settings.from_environment()


@pytest.mark.parametrize(
    ("module_id", "path"),
    [
        ("chat", "/api/projects"),
        ("knowledge", "/api/knowledge"),
        ("automation", "/api/skills"),
        ("workbench", "/api/workbenches"),
        ("tasks", "/api/tasks"),
    ],
)
def test_off_module_business_routes_are_not_available(
    tmp_path: Path,
    module_id: str,
    path: str,
) -> None:
    module_modes = default_module_modes()
    module_modes[module_id] = "off"
    settings = Settings.from_data_dir(tmp_path / module_id, module_modes=module_modes)

    with authenticated_client(settings) as client:
        response = client.get(path)

    assert response.status_code == 404
    assert response.json() == {"detail": "Module not available"}


@pytest.mark.parametrize("module_id", ["chat", "knowledge", "automation", "workbench", "tasks"])
@pytest.mark.parametrize("mode", ["off", "prototype", "active"])
def test_module_registry_reports_every_module_mode(
    tmp_path: Path,
    module_id: str,
    mode: str,
) -> None:
    module_modes = default_module_modes()
    module_modes[module_id] = mode
    settings = Settings.from_data_dir(tmp_path / f"{module_id}-{mode}", module_modes=module_modes)

    with authenticated_client(settings) as client:
        response = client.get("/api/modules")

    assert response.status_code == 200
    assert next(item for item in response.json() if item["id"] == module_id)["mode"] == mode


def test_work_submission_is_blocked_when_tasks_are_off(tmp_path: Path) -> None:
    module_modes = default_module_modes()
    module_modes["chat"] = "active"
    settings = Settings.from_data_dir(tmp_path / "tasks-off", module_modes=module_modes)

    with authenticated_client(settings) as client:
        conversation = client.post("/api/conversations", json={"title": "只聊天"}).json()
        response = client.post(
            f"/api/conversations/{conversation['id']}/submissions",
            json={
                "mode": "work",
                "content": "不应创建任务",
                "submission_key": "cbb9fd0e-d44a-4e1b-b56d-63021f88e907",
            },
        )
        messages = client.get(f"/api/conversations/{conversation['id']}/messages")

    assert response.status_code == 404
    assert response.json() == {"detail": "Module not available"}
    assert messages.json() == []


def test_initial_work_submission_is_blocked_when_tasks_are_off(tmp_path: Path) -> None:
    module_modes = default_module_modes()
    module_modes["chat"] = "active"
    settings = Settings.from_data_dir(tmp_path / "initial-tasks-off", module_modes=module_modes)

    with authenticated_client(settings) as client:
        response = client.post(
            "/api/conversation-submissions",
            json={
                "title": "不应创建会话",
                "project_id": None,
                "mode": "work",
                "content": "不应创建任务",
                "submission_key": "26240e3f-8d84-4b73-9b68-64364558af12",
            },
        )
        conversations = client.get("/api/conversations")

    assert response.status_code == 404
    assert response.json() == {"detail": "Module not available"}
    assert conversations.json() == []
