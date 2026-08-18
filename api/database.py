from __future__ import annotations

import sqlite3
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4


SCHEMA_VERSION = 4


class Database:
    def __init__(self, path: Path) -> None:
        self.path = path

    def initialize(self) -> None:
        with sqlite3.connect(self.path) as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS schema_metadata (
                    key TEXT PRIMARY KEY,
                    value INTEGER NOT NULL
                )
                """
            )
            connection.execute(
                "INSERT OR IGNORE INTO schema_metadata (key, value) VALUES (?, ?)",
                ("schema_version", 1),
            )

            row = connection.execute(
                "SELECT value FROM schema_metadata WHERE key = ?",
                ("schema_version",),
            ).fetchone()
            if row is None:
                raise RuntimeError("Database schema is not initialized")

            version = int(row[0])
            if version == 1:
                connection.execute(
                    """
                    CREATE TABLE projects (
                        id TEXT PRIMARY KEY,
                        title TEXT NOT NULL
                    )
                    """
                )
                connection.execute(
                    "UPDATE schema_metadata SET value = ? WHERE key = ?",
                    (2, "schema_version"),
                )
                version = 2

            if version == 2:
                connection.execute(
                    """
                    CREATE TABLE conversations (
                        id TEXT PRIMARY KEY,
                        title TEXT NOT NULL,
                        project_id TEXT REFERENCES projects(id)
                    )
                    """
                )
                connection.execute(
                    "UPDATE schema_metadata SET value = ? WHERE key = ?",
                    (3, "schema_version"),
                )
                version = 3

            if version == 3:
                connection.executescript(
                    """
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
                    """
                )
                connection.execute(
                    "UPDATE schema_metadata SET value = ? WHERE key = ?",
                    (4, "schema_version"),
                )

        if self.schema_version() != SCHEMA_VERSION:
            raise RuntimeError("Unsupported database schema version")

    def schema_version(self) -> int:
        with sqlite3.connect(self.path) as connection:
            row = connection.execute(
                "SELECT value FROM schema_metadata WHERE key = ?",
                ("schema_version",),
            ).fetchone()

        if row is None:
            raise RuntimeError("Database schema is not initialized")
        return int(row[0])

    def create_project(self, title: str) -> dict[str, str]:
        project = {"id": str(uuid4()), "title": title}
        with sqlite3.connect(self.path) as connection:
            connection.execute(
                "INSERT INTO projects (id, title) VALUES (?, ?)",
                (project["id"], project["title"]),
            )
        return project

    def list_projects(self) -> list[dict[str, str]]:
        with sqlite3.connect(self.path) as connection:
            rows = connection.execute(
                "SELECT id, title FROM projects ORDER BY rowid"
            ).fetchall()
        return [{"id": str(row[0]), "title": str(row[1])} for row in rows]

    def rename_project(self, project_id: str, title: str) -> dict[str, str] | None:
        with sqlite3.connect(self.path) as connection:
            updated = connection.execute(
                "UPDATE projects SET title = ? WHERE id = ?",
                (title, project_id),
            )
        if updated.rowcount == 0:
            return None
        return {"id": project_id, "title": title}

    def create_conversation(self, title: str, project_id: str | None = None) -> dict[str, str | None] | None:
        conversation = {"id": str(uuid4()), "title": title, "project_id": project_id}
        with sqlite3.connect(self.path) as connection:
            if project_id is not None:
                project = connection.execute(
                    "SELECT 1 FROM projects WHERE id = ?",
                    (project_id,),
                ).fetchone()
                if project is None:
                    return None
            connection.execute(
                "INSERT INTO conversations (id, title, project_id) VALUES (?, ?, ?)",
                (conversation["id"], conversation["title"], conversation["project_id"]),
            )
        return conversation

    def list_conversations(self, project_id: str | None = None) -> list[dict[str, str | None]]:
        with sqlite3.connect(self.path) as connection:
            if project_id is None:
                rows = connection.execute(
                    "SELECT id, title, project_id FROM conversations ORDER BY rowid"
                ).fetchall()
            else:
                rows = connection.execute(
                    "SELECT id, title, project_id FROM conversations WHERE project_id = ? ORDER BY rowid",
                    (project_id,),
                ).fetchall()
        return [
            {"id": str(row[0]), "title": str(row[1]), "project_id": str(row[2]) if row[2] is not None else None}
            for row in rows
        ]

    def set_conversation_project(
        self,
        conversation_id: str,
        project_id: str | None,
    ) -> dict[str, str | None] | None:
        with sqlite3.connect(self.path) as connection:
            if project_id is not None:
                project = connection.execute(
                    "SELECT 1 FROM projects WHERE id = ?",
                    (project_id,),
                ).fetchone()
                if project is None:
                    return None

            updated = connection.execute(
                "UPDATE conversations SET project_id = ? WHERE id = ?",
                (project_id, conversation_id),
            )
            if updated.rowcount == 0:
                return None
            row = connection.execute(
                "SELECT id, title, project_id FROM conversations WHERE id = ?",
                (conversation_id,),
            ).fetchone()

        if row is None:
            return None
        return {
            "id": str(row[0]),
            "title": str(row[1]),
            "project_id": str(row[2]) if row[2] is not None else None,
        }

    def submit_conversation(self, conversation_id: str, mode: str, content: str) -> dict[str, Any] | None:
        created_at = datetime.now(UTC).isoformat()
        message = {
            "id": str(uuid4()),
            "conversation_id": conversation_id,
            "mode": mode,
            "content": content,
            "created_at": created_at,
        }

        with sqlite3.connect(self.path) as connection:
            conversation = connection.execute(
                "SELECT project_id FROM conversations WHERE id = ?",
                (conversation_id,),
            ).fetchone()
            if conversation is None:
                return None

            connection.execute(
                "INSERT INTO conversation_messages (id, conversation_id, mode, content, created_at) VALUES (?, ?, ?, ?, ?)",
                (message["id"], conversation_id, mode, content, created_at),
            )

            task = None
            if mode == "work":
                task = {
                    "id": str(uuid4()),
                    "conversation_id": conversation_id,
                    "objective": content,
                    "project_id": str(conversation[0]) if conversation[0] is not None else None,
                    "status": "created",
                    "created_at": created_at,
                    "latest_run": None,
                }
                connection.execute(
                    "INSERT INTO tasks (id, conversation_id, objective, project_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                    (
                        task["id"],
                        conversation_id,
                        content,
                        task["project_id"],
                        task["status"],
                        created_at,
                    ),
                )

        return {"message": message, "task": task}

    def list_messages(self, conversation_id: str) -> list[dict[str, str]]:
        with sqlite3.connect(self.path) as connection:
            rows = connection.execute(
                "SELECT id, conversation_id, mode, content, created_at FROM conversation_messages WHERE conversation_id = ? ORDER BY rowid",
                (conversation_id,),
            ).fetchall()
        return [
            {
                "id": str(row[0]),
                "conversation_id": str(row[1]),
                "mode": str(row[2]),
                "content": str(row[3]),
                "created_at": str(row[4]),
            }
            for row in rows
        ]

    @staticmethod
    def _task_from_row(row: sqlite3.Row | tuple[Any, ...]) -> dict[str, Any]:
        return {
            "id": str(row[0]),
            "conversation_id": str(row[1]),
            "objective": str(row[2]),
            "project_id": str(row[3]) if row[3] is not None else None,
            "status": str(row[4]),
            "created_at": str(row[5]),
            "latest_run": None,
        }

    def list_tasks(self) -> list[dict[str, Any]]:
        with sqlite3.connect(self.path) as connection:
            rows = connection.execute(
                "SELECT id, conversation_id, objective, project_id, status, created_at FROM tasks ORDER BY rowid"
            ).fetchall()
        return [self._task_from_row(row) for row in rows]

    def get_task(self, task_id: str) -> dict[str, Any] | None:
        with sqlite3.connect(self.path) as connection:
            row = connection.execute(
                "SELECT id, conversation_id, objective, project_id, status, created_at FROM tasks WHERE id = ?",
                (task_id,),
            ).fetchone()
        return self._task_from_row(row) if row is not None else None
