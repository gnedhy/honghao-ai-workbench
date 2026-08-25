from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from api.modules import default_module_modes
from api.settings import Settings
from tests.helpers import authenticated_client


def chat_and_task_settings(data_dir: Path) -> Settings:
    module_modes = default_module_modes()
    module_modes["chat"] = "active"
    module_modes["tasks"] = "active"
    return Settings.from_data_dir(data_dir, module_modes=module_modes)


def test_chat_submission_creates_message_without_task(tmp_path: Path) -> None:
    settings = chat_and_task_settings(tmp_path / "data")

    with authenticated_client(settings) as client:
        conversation = client.post("/api/conversations", json={"title": "随手讨论"}).json()
        submitted = client.post(
            f"/api/conversations/{conversation['id']}/submissions",
            json={"mode": "chat", "content": "先讨论一下知识库结构", "submission_key": "742415c8-c455-4d64-b8aa-4bd5f50f1a0f"},
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
    settings = chat_and_task_settings(tmp_path / "data")

    with authenticated_client(settings) as client:
        project = client.post("/api/projects", json={"title": "部门需求治理"}).json()
        conversation = client.post(
            "/api/conversations",
            json={"title": "需求讨论", "project_id": project["id"]},
        ).json()

        first = client.post(
            f"/api/conversations/{conversation['id']}/submissions",
            json={"mode": "work", "content": "整理访谈中的事实与缺口", "submission_key": "39d1978c-8f61-4e14-a1ac-ce8d04132b52"},
        ).json()["task"]
        second = client.post(
            f"/api/conversations/{conversation['id']}/submissions",
            json={"mode": "work", "content": "生成下一轮访谈问题", "submission_key": "bfb2c77e-b960-431f-b2c7-7aa9ac721b45"},
        ).json()["task"]

    assert first["id"] != second["id"]
    assert first["conversation_id"] == conversation["id"]
    assert second["conversation_id"] == conversation["id"]
    assert first["project_id"] == project["id"]
    assert second["project_id"] == project["id"]
    assert first["status"] == "created"
    assert first["latest_run"] is None
    assert first["created_at"]

    with authenticated_client(settings) as restarted_client:
        listed = restarted_client.get("/api/tasks")

    assert listed.status_code == 200
    assert listed.json() == [first, second]


def test_tasks_keep_project_snapshot_when_conversation_project_changes(tmp_path: Path) -> None:
    settings = chat_and_task_settings(tmp_path / "data")

    with authenticated_client(settings) as client:
        first_project = client.post("/api/projects", json={"title": "原项目"}).json()
        next_project = client.post("/api/projects", json={"title": "新项目"}).json()
        conversation = client.post(
            "/api/conversations",
            json={"title": "持续讨论", "project_id": first_project["id"]},
        ).json()

        first_task = client.post(
            f"/api/conversations/{conversation['id']}/submissions",
            json={"mode": "work", "content": "第一次工作", "submission_key": "6242d04f-0091-4312-a840-a77ff81d3d80"},
        ).json()["task"]
        client.patch(
            f"/api/conversations/{conversation['id']}",
            json={"project_id": next_project["id"]},
        )
        second_task = client.post(
            f"/api/conversations/{conversation['id']}/submissions",
            json={"mode": "work", "content": "第二次工作", "submission_key": "c9068947-4063-475a-8bc0-207ab19f9080"},
        ).json()["task"]
        client.patch(
            f"/api/conversations/{conversation['id']}",
            json={"project_id": None},
        )
        third_task = client.post(
            f"/api/conversations/{conversation['id']}/submissions",
            json={"mode": "work", "content": "无项目工作", "submission_key": "8134094a-7254-4f7d-8c0e-28afcf7fe7c5"},
        ).json()["task"]
        first_detail = client.get(f"/api/tasks/{first_task['id']}")

    assert first_task["project_id"] == first_project["id"]
    assert second_task["project_id"] == next_project["id"]
    assert third_task["project_id"] is None
    assert first_detail.status_code == 200
    assert first_detail.json() == first_task


def test_submission_rejects_unknown_conversation(tmp_path: Path) -> None:
    settings = chat_and_task_settings(tmp_path / "data")

    with authenticated_client(settings) as client:
        response = client.post(
            "/api/conversations/missing/submissions",
            json={"mode": "work", "content": "不会被创建", "submission_key": "0bd5fe7a-a644-4b58-870e-e6a3c77d14e8"},
        )

    assert response.status_code == 404
    assert response.json() == {"detail": "Conversation not found"}


def test_first_submission_creates_conversation_message_and_task_atomically(tmp_path: Path) -> None:
    settings = chat_and_task_settings(tmp_path / "data")
    submission_key = "757c2ca9-2781-4dbf-b383-25d83695cc4b"

    with authenticated_client(settings) as client:
        response = client.post(
            "/api/conversation-submissions",
            json={
                "title": "整理首轮需求",
                "project_id": None,
                "mode": "work",
                "content": "整理访谈事实与缺口",
                "submission_key": submission_key,
            },
        )
        conversations = client.get("/api/conversations")
        tasks = client.get("/api/tasks")

    assert response.status_code == 201
    result = response.json()
    assert conversations.json() == [result["conversation"]]
    assert result["message"]["conversation_id"] == result["conversation"]["id"]
    assert result["task"]["conversation_id"] == result["conversation"]["id"]
    assert result["message"]["task_id"] == result["task"]["id"]
    assert result["message"]["task_status"] == "created"
    assert tasks.json() == [result["task"]]


def test_retrying_first_submission_returns_the_original_result(tmp_path: Path) -> None:
    settings = chat_and_task_settings(tmp_path / "data")
    payload = {
        "title": "只创建一次",
        "project_id": None,
        "mode": "work",
        "content": "生成任务",
        "submission_key": "656ab08f-ee20-41b8-8859-764160e2b362",
    }

    with authenticated_client(settings) as client:
        first = client.post("/api/conversation-submissions", json=payload)
        retried = client.post("/api/conversation-submissions", json=payload)
        conversations = client.get("/api/conversations")
        tasks = client.get("/api/tasks")

    assert first.status_code == 201
    assert retried.status_code == 201
    assert retried.json() == first.json()
    assert len(conversations.json()) == 1
    assert len(tasks.json()) == 1


def test_retrying_existing_conversation_submission_does_not_duplicate_task(tmp_path: Path) -> None:
    settings = chat_and_task_settings(tmp_path / "data")
    payload = {
        "mode": "work",
        "content": "只执行一次",
        "submission_key": "70b23fb9-60c8-4977-b932-c206210cdc59",
    }

    with authenticated_client(settings) as client:
        conversation = client.post("/api/conversations", json={"title": "重试测试"}).json()
        first = client.post(
            f"/api/conversations/{conversation['id']}/submissions",
            json=payload,
        )
        retried = client.post(
            f"/api/conversations/{conversation['id']}/submissions",
            json=payload,
        )
        tasks = client.get("/api/tasks")

    assert first.status_code == 201
    assert retried.status_code == 201
    assert retried.json() == first.json()
    assert len(tasks.json()) == 1


def test_concurrent_retries_create_one_task(tmp_path: Path) -> None:
    settings = chat_and_task_settings(tmp_path / "data")
    payload = {
        "mode": "work",
        "content": "并发请求也只创建一次",
        "submission_key": "7480d5aa-286e-4815-81af-2b378c062c80",
    }

    with authenticated_client(settings) as client:
        conversation = client.post("/api/conversations", json={"title": "并发重试"}).json()

        def submit() -> tuple[int, str]:
            response = client.post(
                f"/api/conversations/{conversation['id']}/submissions",
                json=payload,
            )
            return response.status_code, response.json()["task"]["id"]

        with ThreadPoolExecutor(max_workers=8) as executor:
            results = list(executor.map(lambda _: submit(), range(8)))
        tasks = client.get("/api/tasks").json()

    assert {status for status, _ in results} == {201}
    assert len({task_id for _, task_id in results}) == 1
    assert len(tasks) == 1


def test_submission_rejects_blank_and_oversized_content(tmp_path: Path) -> None:
    settings = chat_and_task_settings(tmp_path / "data")

    with authenticated_client(settings) as client:
        conversation = client.post("/api/conversations", json={"title": "内容校验"}).json()
        blank = client.post(
            f"/api/conversations/{conversation['id']}/submissions",
            json={
                "mode": "work",
                "content": "   ",
                "submission_key": "0163acbf-9a47-481e-9368-d027b612959a",
            },
        )
        oversized = client.post(
            f"/api/conversations/{conversation['id']}/submissions",
            json={
                "mode": "work",
                "content": "字" * 10_001,
                "submission_key": "ec4ab37f-1d61-4be4-9449-bd2c5149fdb3",
            },
        )

    assert blank.status_code == 422
    assert oversized.status_code == 422


def test_messages_reject_unknown_conversation(tmp_path: Path) -> None:
    settings = chat_and_task_settings(tmp_path / "data")

    with authenticated_client(settings) as client:
        response = client.get("/api/conversations/missing/messages")

    assert response.status_code == 404
    assert response.json() == {"detail": "Conversation not found"}
