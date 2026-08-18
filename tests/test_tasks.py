from pathlib import Path

from fastapi.testclient import TestClient

from api.main import create_app
from api.settings import Settings


def test_chat_submission_creates_message_without_task(tmp_path: Path) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")

    with TestClient(create_app(settings)) as client:
        conversation = client.post("/api/conversations", json={"title": "随手讨论"}).json()
        submitted = client.post(
            f"/api/conversations/{conversation['id']}/submissions",
            json={"mode": "chat", "content": "先讨论一下知识库结构"},
        )
        tasks = client.get("/api/tasks")
        messages = client.get(f"/api/conversations/{conversation['id']}/messages")

    assert submitted.status_code == 201
    assert submitted.json()["task"] is None
    assert submitted.json()["message"]["content"] == "先讨论一下知识库结构"
    assert submitted.json()["message"]["mode"] == "chat"
    assert tasks.json() == []
    assert messages.json() == [submitted.json()["message"]]


def test_each_work_submission_creates_an_independent_persistent_task(tmp_path: Path) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")

    with TestClient(create_app(settings)) as client:
        project = client.post("/api/projects", json={"title": "部门需求治理"}).json()
        conversation = client.post(
            "/api/conversations",
            json={"title": "需求讨论", "project_id": project["id"]},
        ).json()

        first = client.post(
            f"/api/conversations/{conversation['id']}/submissions",
            json={"mode": "work", "content": "整理访谈中的事实与缺口"},
        ).json()["task"]
        second = client.post(
            f"/api/conversations/{conversation['id']}/submissions",
            json={"mode": "work", "content": "生成下一轮访谈问题"},
        ).json()["task"]

    assert first["id"] != second["id"]
    assert first["conversation_id"] == conversation["id"]
    assert second["conversation_id"] == conversation["id"]
    assert first["project_id"] == project["id"]
    assert second["project_id"] == project["id"]
    assert first["status"] == "created"
    assert first["latest_run"] is None
    assert first["created_at"]

    with TestClient(create_app(settings)) as restarted_client:
        listed = restarted_client.get("/api/tasks")

    assert listed.status_code == 200
    assert listed.json() == [first, second]


def test_tasks_keep_project_snapshot_when_conversation_project_changes(tmp_path: Path) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")

    with TestClient(create_app(settings)) as client:
        first_project = client.post("/api/projects", json={"title": "原项目"}).json()
        next_project = client.post("/api/projects", json={"title": "新项目"}).json()
        conversation = client.post(
            "/api/conversations",
            json={"title": "持续讨论", "project_id": first_project["id"]},
        ).json()

        first_task = client.post(
            f"/api/conversations/{conversation['id']}/submissions",
            json={"mode": "work", "content": "第一次工作"},
        ).json()["task"]
        client.patch(
            f"/api/conversations/{conversation['id']}",
            json={"project_id": next_project["id"]},
        )
        second_task = client.post(
            f"/api/conversations/{conversation['id']}/submissions",
            json={"mode": "work", "content": "第二次工作"},
        ).json()["task"]
        client.patch(
            f"/api/conversations/{conversation['id']}",
            json={"project_id": None},
        )
        third_task = client.post(
            f"/api/conversations/{conversation['id']}/submissions",
            json={"mode": "work", "content": "无项目工作"},
        ).json()["task"]
        first_detail = client.get(f"/api/tasks/{first_task['id']}")

    assert first_task["project_id"] == first_project["id"]
    assert second_task["project_id"] == next_project["id"]
    assert third_task["project_id"] is None
    assert first_detail.status_code == 200
    assert first_detail.json() == first_task


def test_submission_rejects_unknown_conversation(tmp_path: Path) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")

    with TestClient(create_app(settings)) as client:
        response = client.post(
            "/api/conversations/missing/submissions",
            json={"mode": "work", "content": "不会被创建"},
        )

    assert response.status_code == 404
    assert response.json() == {"detail": "Conversation not found"}
