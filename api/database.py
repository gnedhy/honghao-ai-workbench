from __future__ import annotations

import sqlite3
from pathlib import Path


SCHEMA_VERSION = 1


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
                ("schema_version", SCHEMA_VERSION),
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
