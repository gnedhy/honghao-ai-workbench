from pathlib import Path

import pytest
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
