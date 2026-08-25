from pathlib import Path

from api.modules import default_module_modes
from api.settings import Settings
from tests.helpers import authenticated_client


def chat_settings(data_dir: Path) -> Settings:
    module_modes = default_module_modes()
    module_modes["chat"] = "active"
    return Settings.from_data_dir(data_dir, module_modes=module_modes)


def test_project_can_be_created_and_read_after_restart(tmp_path: Path) -> None:
    settings = chat_settings(tmp_path / "data")

    with authenticated_client(settings) as client:
        created = client.post("/api/projects", json={"title": "宏昊 AI 中台"})

    assert created.status_code == 201
    project = created.json()
    assert project["title"] == "宏昊 AI 中台"
    assert isinstance(project["id"], str)
    assert project["id"]

    with authenticated_client(settings) as restarted_client:
        listed = restarted_client.get("/api/projects")

    assert listed.status_code == 200
    assert listed.json() == [project]


def test_conversation_without_project_persists_after_restart(tmp_path: Path) -> None:
    settings = chat_settings(tmp_path / "data")

    with authenticated_client(settings) as client:
        created = client.post("/api/conversations", json={"title": "未归类的想法"})

    assert created.status_code == 201
    conversation = created.json()
    assert conversation["title"] == "未归类的想法"
    assert conversation["project_id"] is None
    assert isinstance(conversation["id"], str)
    assert conversation["id"]

    with authenticated_client(settings) as restarted_client:
        listed = restarted_client.get("/api/conversations")

    assert listed.status_code == 200
    assert listed.json() == [conversation]


def test_conversation_project_association_survives_rename_and_duplicate_titles(tmp_path: Path) -> None:
    settings = chat_settings(tmp_path / "data")

    with authenticated_client(settings) as client:
        original_project = client.post("/api/projects", json={"title": "原项目"}).json()
        conversation = client.post("/api/conversations", json={"title": "需求讨论"}).json()

        associated = client.patch(
            f"/api/conversations/{conversation['id']}",
            json={"project_id": original_project["id"]},
        )
        renamed = client.patch(
            f"/api/projects/{original_project['id']}",
            json={"title": "同名项目"},
        )
        duplicate_project = client.post("/api/projects", json={"title": "同名项目"}).json()
        listed = client.get("/api/conversations")
        unassociated = client.patch(
            f"/api/conversations/{conversation['id']}",
            json={"project_id": None},
        )

    assert associated.status_code == 200
    assert associated.json()["project_id"] == original_project["id"]
    assert renamed.status_code == 200
    assert renamed.json() == {"id": original_project["id"], "title": "同名项目"}
    assert duplicate_project["id"] != original_project["id"]
    assert listed.json()[0]["project_id"] == original_project["id"]
    assert unassociated.status_code == 200
    assert unassociated.json()["project_id"] is None


def test_current_project_context_filters_without_changing_conversation_associations(tmp_path: Path) -> None:
    settings = chat_settings(tmp_path / "data")

    with authenticated_client(settings) as client:
        project = client.post("/api/projects", json={"title": "部门需求治理"}).json()
        related = client.post(
            "/api/conversations",
            json={"title": "部门访谈整理", "project_id": project["id"]},
        ).json()
        unassigned = client.post("/api/conversations", json={"title": "临时想法"}).json()

        filtered = client.get("/api/conversations", params={"project_id": project["id"]})
        all_conversations = client.get("/api/conversations")

    assert filtered.status_code == 200
    assert filtered.json() == [related]
    assert all_conversations.json() == [related, unassigned]


def test_conversation_rejects_unknown_project_id(tmp_path: Path) -> None:
    settings = chat_settings(tmp_path / "data")

    with authenticated_client(settings) as client:
        response = client.post(
            "/api/conversations",
            json={"title": "错误关联", "project_id": "missing-project"},
        )

    assert response.status_code == 404
    assert response.json() == {"detail": "Project not found"}
