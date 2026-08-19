import sqlite3
from pathlib import Path

from api.database import Database


def test_version_three_partial_migration_recovers_on_startup(tmp_path: Path) -> None:
    database_path = tmp_path / "workbench.db"
    with sqlite3.connect(database_path) as connection:
        connection.executescript(
            """
            CREATE TABLE schema_metadata (
                key TEXT PRIMARY KEY,
                value INTEGER NOT NULL
            );
            INSERT INTO schema_metadata (key, value) VALUES ('schema_version', 3);
            CREATE TABLE projects (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL
            );
            CREATE TABLE conversations (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                project_id TEXT REFERENCES projects(id)
            );
            CREATE TABLE conversation_messages (
                id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL REFERENCES conversations(id),
                mode TEXT NOT NULL CHECK (mode IN ('chat', 'work')),
                content TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            """
        )

    database = Database(database_path)
    database.initialize()

    assert database.schema_version() == 5
    with sqlite3.connect(database_path) as connection:
        table_names = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
    assert {"conversation_messages", "tasks"}.issubset(table_names)


def test_version_four_migration_links_existing_work_messages_to_tasks(tmp_path: Path) -> None:
    database_path = tmp_path / "workbench.db"
    with sqlite3.connect(database_path) as connection:
        connection.executescript(
            """
            CREATE TABLE schema_metadata (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
            INSERT INTO schema_metadata (key, value) VALUES ('schema_version', 4);
            CREATE TABLE projects (id TEXT PRIMARY KEY, title TEXT NOT NULL);
            CREATE TABLE conversations (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                project_id TEXT REFERENCES projects(id)
            );
            CREATE TABLE conversation_messages (
                id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL REFERENCES conversations(id),
                mode TEXT NOT NULL CHECK (mode IN ('chat', 'work')),
                content TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE tasks (
                id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL REFERENCES conversations(id),
                objective TEXT NOT NULL,
                project_id TEXT REFERENCES projects(id),
                status TEXT NOT NULL CHECK (status IN ('created')),
                created_at TEXT NOT NULL
            );
            INSERT INTO conversations (id, title, project_id) VALUES ('conversation-1', '已有工作', NULL);
            INSERT INTO conversation_messages (id, conversation_id, mode, content, created_at)
            VALUES ('message-1', 'conversation-1', 'work', '整理已有材料', '2026-08-18T00:00:00+00:00');
            INSERT INTO tasks (id, conversation_id, objective, project_id, status, created_at)
            VALUES ('task-1', 'conversation-1', '整理已有材料', NULL, 'created', '2026-08-18T00:00:00+00:00');
            """
        )

    database = Database(database_path)
    database.initialize()

    assert database.list_messages("conversation-1") == [
        {
            "id": "message-1",
            "conversation_id": "conversation-1",
            "mode": "work",
            "content": "整理已有材料",
            "created_at": "2026-08-18T00:00:00+00:00",
            "task_id": "task-1",
            "task_status": "created",
        }
    ]
