from __future__ import annotations

import sqlite3
from pathlib import Path
from uuid import uuid4


SCHEMA_VERSION = 3


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
