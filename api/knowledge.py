from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, BinaryIO
from uuid import uuid4


KNOWLEDGE_SCHEMA_VERSION = 6
MAX_SOURCE_BYTES = 50 * 1024 * 1024


class InvalidKnowledgeSourceError(ValueError):
    pass


class KnowledgeStore:
    def __init__(self, database_path: Path, data_dir: Path) -> None:
        self.database_path = database_path
        self.sources_dir = data_dir / "knowledge" / "sources"
        self.items_dir = data_dir / "knowledge" / "items"

    def initialize(self) -> None:
        self.sources_dir.mkdir(parents=True, exist_ok=True)
        self.items_dir.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(self.database_path) as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS knowledge_sources (
                    id TEXT PRIMARY KEY,
                    filename TEXT NOT NULL,
                    mime_type TEXT NOT NULL,
                    size_bytes INTEGER NOT NULL,
                    sha256 TEXT NOT NULL,
                    stored_name TEXT NOT NULL UNIQUE,
                    legacy_storage_status TEXT NOT NULL DEFAULT 'quarantined' CHECK (legacy_storage_status IN ('quarantined')),
                    safety_status TEXT NOT NULL DEFAULT 'quarantined' CHECK (safety_status IN ('quarantined', 'confirmed')),
                    processing_status TEXT NOT NULL DEFAULT 'not_started',
                    processing_error TEXT,
                    duplicate_of TEXT REFERENCES knowledge_sources(id),
                    created_by_user_id TEXT NOT NULL REFERENCES identity_users(id),
                    read_min_level INTEGER NOT NULL DEFAULT 4,
                    read_scope_ids TEXT NOT NULL DEFAULT '[]',
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS knowledge_source_read_roles (
                    source_id TEXT NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
                    role_id TEXT NOT NULL REFERENCES identity_roles(id),
                    PRIMARY KEY (source_id, role_id)
                );
                """
            )
            connection.execute(
                "INSERT OR IGNORE INTO schema_metadata (key, value) VALUES (?, ?)",
                ("knowledge_schema_version", 1),
            )
            version = connection.execute(
                "SELECT value FROM schema_metadata WHERE key = ?",
                ("knowledge_schema_version",),
            ).fetchone()
            if version is None:
                raise RuntimeError("Knowledge schema is not initialized")
            version_number = int(version[0])
            if version_number == 1:
                columns = {
                    str(row[1])
                    for row in connection.execute("PRAGMA table_info(knowledge_sources)")
                }
                if "processing_status" not in columns:
                    connection.execute(
                        "ALTER TABLE knowledge_sources ADD COLUMN processing_status TEXT NOT NULL DEFAULT 'quarantined'"
                    )
                if "processing_error" not in columns:
                    connection.execute(
                        "ALTER TABLE knowledge_sources ADD COLUMN processing_error TEXT"
                    )
                connection.execute(
                    """
                    CREATE TABLE IF NOT EXISTS knowledge_versions (
                        id TEXT PRIMARY KEY,
                        source_id TEXT NOT NULL REFERENCES knowledge_sources(id),
                        stored_name TEXT NOT NULL UNIQUE,
                        status TEXT NOT NULL CHECK (status IN ('draft')),
                        created_by_user_id TEXT NOT NULL REFERENCES identity_users(id),
                        created_at TEXT NOT NULL
                    )
                    """
                )
                connection.execute(
                    "UPDATE schema_metadata SET value = ? WHERE key = ?",
                    (2, "knowledge_schema_version"),
                )
                version_number = 2
            if version_number == 2:
                connection.executescript(
                    """
                    CREATE TABLE IF NOT EXISTS knowledge_version_sources (
                        version_id TEXT NOT NULL REFERENCES knowledge_versions(id) ON DELETE CASCADE,
                        source_id TEXT NOT NULL REFERENCES knowledge_sources(id),
                        PRIMARY KEY (version_id, source_id)
                    );
                    INSERT OR IGNORE INTO knowledge_version_sources (version_id, source_id)
                    SELECT id, source_id FROM knowledge_versions;
                    """
                )
                connection.execute(
                    "UPDATE schema_metadata SET value = ? WHERE key = ?",
                    (3, "knowledge_schema_version"),
                )
                version_number = 3
            if version_number == 3:
                columns = {
                    str(row[1])
                    for row in connection.execute("PRAGMA table_info(knowledge_sources)")
                }
                if "safety_status" not in columns:
                    connection.execute(
                        "ALTER TABLE knowledge_sources ADD COLUMN safety_status TEXT NOT NULL DEFAULT 'quarantined'"
                    )
                if "status" in columns:
                    connection.execute(
                        "ALTER TABLE knowledge_sources RENAME COLUMN status TO legacy_storage_status"
                    )
                connection.execute(
                    "UPDATE knowledge_sources SET safety_status = 'confirmed' WHERE processing_status <> 'quarantined'"
                )
                connection.execute(
                    "UPDATE knowledge_sources SET processing_status = 'not_started' WHERE processing_status = 'quarantined'"
                )
                connection.execute(
                    "UPDATE schema_metadata SET value = ? WHERE key = ?",
                    (4, "knowledge_schema_version"),
                )
                version_number = 4
            if version_number == 4:
                columns = {
                    str(row[1])
                    for row in connection.execute("PRAGMA table_info(knowledge_sources)")
                }
                if "read_min_level" not in columns:
                    connection.execute(
                        "ALTER TABLE knowledge_sources ADD COLUMN read_min_level INTEGER NOT NULL DEFAULT 4"
                    )
                    connection.execute(
                        "ALTER TABLE knowledge_sources ADD COLUMN read_scope_ids TEXT NOT NULL DEFAULT '[]'"
                    )
                for source_id, in connection.execute("SELECT id FROM knowledge_sources").fetchall():
                    roles = [
                        str(row[0])
                        for row in connection.execute(
                            "SELECT role_id FROM knowledge_source_read_roles WHERE source_id = ?",
                            (source_id,),
                        )
                    ]
                    minimum_level, scopes = _legacy_source_policy(roles)
                    connection.execute(
                        "UPDATE knowledge_sources SET read_min_level = ?, read_scope_ids = ? WHERE id = ?",
                        (minimum_level, json.dumps(scopes), source_id),
                    )
                connection.execute(
                    "UPDATE schema_metadata SET value = ? WHERE key = ?",
                    (5, "knowledge_schema_version"),
                )
                version_number = 5
            if version_number == 5:
                connection.execute(
                    "UPDATE knowledge_sources SET read_min_level = 2 WHERE read_min_level = 1"
                )
                connection.execute(
                    "UPDATE knowledge_sources SET read_min_level = 4, read_scope_ids = '[]' WHERE read_min_level = 5"
                )
                connection.execute(
                    "UPDATE schema_metadata SET value = ? WHERE key = ?",
                    (KNOWLEDGE_SCHEMA_VERSION, "knowledge_schema_version"),
                )
            connection.execute(
                "CREATE VIEW IF NOT EXISTS knowledge_derived_index AS SELECT versions.id AS version_id, links.source_id, sources.filename, sources.sha256 FROM knowledge_versions AS versions JOIN knowledge_version_sources AS links ON links.version_id = versions.id JOIN knowledge_sources AS sources ON sources.id = links.source_id"
            )
            connection.execute(
                "UPDATE knowledge_sources SET processing_status = 'parse_failed', processing_error = 'interrupted' WHERE processing_status = 'processing'"
            )
        if self.schema_version() != KNOWLEDGE_SCHEMA_VERSION:
            raise RuntimeError("Unsupported knowledge schema version")

    def schema_version(self) -> int:
        with sqlite3.connect(self.database_path) as connection:
            row = connection.execute(
                "SELECT value FROM schema_metadata WHERE key = ?",
                ("knowledge_schema_version",),
            ).fetchone()
        if row is None:
            raise RuntimeError("Knowledge schema is not initialized")
        return int(row[0])

    def create_source(
        self,
        stream: BinaryIO,
        *,
        filename: str,
        mime_type: str,
        created_by_user_id: str,
        read_min_level: int,
        read_scope_ids: list[str],
    ) -> dict[str, Any]:
        if mime_type != "application/pdf" or not filename.lower().endswith(".pdf"):
            raise InvalidKnowledgeSourceError("Only PDF sources are accepted")

        source_id = str(uuid4())
        stored_name = f"{source_id}.pdf"
        target = self.sources_dir / stored_name
        temporary_path: Path | None = None
        size = 0
        digest = hashlib.sha256()
        try:
            with tempfile.NamedTemporaryFile(dir=self.sources_dir, delete=False) as temporary:
                temporary_path = Path(temporary.name)
                while chunk := stream.read(1024 * 1024):
                    size += len(chunk)
                    if size > MAX_SOURCE_BYTES:
                        raise InvalidKnowledgeSourceError("PDF source exceeds 50 MB")
                    digest.update(chunk)
                    temporary.write(chunk)
                temporary.flush()
                os.fsync(temporary.fileno())

            with temporary_path.open("rb") as uploaded:
                if uploaded.read(5) != b"%PDF-":
                    raise InvalidKnowledgeSourceError("File content is not a PDF")
            os.replace(temporary_path, target)
            temporary_path = None

            created_at = datetime.now(UTC).isoformat()
            with sqlite3.connect(self.database_path) as connection:
                duplicate = connection.execute(
                    "SELECT id FROM knowledge_sources WHERE sha256 = ? ORDER BY rowid LIMIT 1",
                    (digest.hexdigest(),),
                ).fetchone()
                connection.execute("BEGIN IMMEDIATE")
                connection.execute(
                    "INSERT INTO knowledge_sources (id, filename, mime_type, size_bytes, sha256, stored_name, legacy_storage_status, duplicate_of, created_by_user_id, read_min_level, read_scope_ids, created_at) VALUES (?, ?, ?, ?, ?, ?, 'quarantined', ?, ?, ?, ?, ?)",
                    (
                        source_id,
                        Path(filename).name,
                        mime_type,
                        size,
                        digest.hexdigest(),
                        stored_name,
                        str(duplicate[0]) if duplicate else None,
                        created_by_user_id,
                        read_min_level,
                        json.dumps(list(dict.fromkeys(read_scope_ids))),
                        created_at,
                    ),
                )
        except Exception:
            target.unlink(missing_ok=True)
            raise
        finally:
            if temporary_path is not None:
                temporary_path.unlink(missing_ok=True)

        source = self.get_source(source_id)
        if source is None:
            raise RuntimeError("Created knowledge source is unavailable")
        return source

    def get_source(self, source_id: str) -> dict[str, Any] | None:
        with sqlite3.connect(self.database_path) as connection:
            row = connection.execute(
                "SELECT id, filename, mime_type, size_bytes, sha256, stored_name, safety_status, processing_status, duplicate_of, created_at, processing_error, read_min_level, read_scope_ids FROM knowledge_sources WHERE id = ?",
                (source_id,),
            ).fetchone()
            if row is None:
                return None
        return {
            "id": str(row[0]),
            "filename": str(row[1]),
            "mime_type": str(row[2]),
            "size_bytes": int(row[3]),
            "sha256": str(row[4]),
            "stored_name": str(row[5]),
            "safety_status": str(row[6]),
            "processing_status": str(row[7]),
            "duplicate_of": str(row[8]) if row[8] is not None else None,
            "created_at": str(row[9]),
            "failure_reason": str(row[10]) if row[10] is not None else None,
            "read_min_level": int(row[11]),
            "read_scope_ids": json.loads(str(row[12])),
        }

    def source_path(self, source: dict[str, Any]) -> Path:
        path = (self.sources_dir / str(source["stored_name"])).resolve()
        if not path.is_relative_to(self.sources_dir.resolve()):
            raise RuntimeError("Knowledge source path escaped its storage boundary")
        return path

    def confirm_safe(self, source_id: str, confirmed_by_user_id: str) -> dict[str, Any] | None:
        source = self.get_source(source_id)
        if source is None:
            return None
        with sqlite3.connect(self.database_path) as connection:
            connection.execute("BEGIN IMMEDIATE")
            claimed = connection.execute(
                "UPDATE knowledge_sources SET safety_status = 'confirmed', processing_status = 'processing', processing_error = NULL WHERE id = ? AND safety_status = 'quarantined'",
                (source_id,),
            ).rowcount
        if claimed == 0:
            return self.get_source(source_id)

        result = self._run_parser(source)

        status = str(result.get("status"))
        if status == "parsed":
            try:
                self._create_markdown_version([source], str(result["text"]), confirmed_by_user_id)
            except Exception:
                self._set_processing_result(source_id, "parse_failed", "version_write_failed")
                raise
        elif status not in {"awaiting_ocr", "encrypted", "parse_failed"}:
            status = "parse_failed"
            result = {"reason": "parser_failed"}

        self._set_processing_result(
            source_id,
            status,
            str(result["reason"]) if result.get("reason") is not None else None,
        )
        return self.get_source(source_id)

    def _run_parser(self, source: dict[str, Any]) -> dict[str, Any]:
        try:
            completed = subprocess.run(
                [sys.executable, "-m", "api.pdf_extract", str(self.source_path(source))],
                capture_output=True,
                check=True,
                text=True,
                timeout=30,
            )
            return json.loads(completed.stdout)
        except (subprocess.SubprocessError, json.JSONDecodeError):
            return {"status": "parse_failed", "reason": "parser_failed"}

    def _set_processing_result(self, source_id: str, status: str, reason: str | None) -> None:
        with sqlite3.connect(self.database_path) as connection:
            connection.execute(
                "UPDATE knowledge_sources SET processing_status = ?, processing_error = ? WHERE id = ?",
                (status, reason, source_id),
            )

    def create_version_from_sources(
        self,
        source_ids: list[str],
        created_by_user_id: str,
    ) -> dict[str, Any]:
        unique_ids = list(dict.fromkeys(source_ids))
        if len(unique_ids) < 2:
            raise InvalidKnowledgeSourceError("At least two distinct sources are required")
        sources = [self.get_source(source_id) for source_id in unique_ids]
        if any(source is None for source in sources):
            raise InvalidKnowledgeSourceError("Knowledge source not found")
        confirmed_sources = [source for source in sources if source is not None]
        if any(
            source["safety_status"] != "confirmed" or source["processing_status"] != "parsed"
            for source in confirmed_sources
        ):
            raise InvalidKnowledgeSourceError("All sources must be confirmed and parsed")

        sections = []
        for source in confirmed_sources:
            result = self._run_parser(source)
            if result.get("status") != "parsed":
                raise InvalidKnowledgeSourceError("Source can no longer be parsed")
            sections.append(f"## {source['filename']}\n\n{str(result['text']).strip()}")
        return self._create_markdown_version(
            confirmed_sources,
            "\n\n".join(sections),
            created_by_user_id,
        )

    def list_versions(self, source_id: str) -> list[dict[str, Any]]:
        with sqlite3.connect(self.database_path) as connection:
            rows = connection.execute(
                "SELECT versions.id, versions.status, versions.created_at FROM knowledge_versions AS versions JOIN knowledge_derived_index AS derived ON derived.version_id = versions.id WHERE derived.source_id = ? ORDER BY versions.rowid",
                (source_id,),
            ).fetchall()
            return [
                {
                    "id": str(row[0]),
                    "status": str(row[1]),
                    "created_at": str(row[2]),
                    "source_ids": [
                        str(source[0])
                        for source in connection.execute(
                            "SELECT source_id FROM knowledge_version_sources WHERE version_id = ? ORDER BY rowid",
                            (row[0],),
                        )
                    ],
                }
                for row in rows
            ]

    def version_path(self, source_id: str, version_id: str) -> Path | None:
        with sqlite3.connect(self.database_path) as connection:
            row = connection.execute(
                "SELECT versions.stored_name FROM knowledge_versions AS versions JOIN knowledge_version_sources AS links ON links.version_id = versions.id WHERE versions.id = ? AND links.source_id = ?",
                (version_id, source_id),
            ).fetchone()
        if row is None:
            return None
        path = (self.items_dir / str(row[0])).resolve()
        if not path.is_relative_to(self.items_dir.resolve()):
            raise RuntimeError("Knowledge version path escaped its storage boundary")
        return path

    def _create_markdown_version(
        self,
        sources: list[dict[str, Any]],
        text: str,
        created_by_user_id: str,
    ) -> dict[str, Any]:
        source = sources[0]
        version_id = str(uuid4())
        stored_name = f"{source['id']}/{version_id}.md"
        target = self.items_dir / stored_name
        target.parent.mkdir(parents=True, exist_ok=True)
        provenance = "\n".join(
            f"> - ID：{item['id']}｜文件：{item['filename']}｜SHA-256：{item['sha256']}"
            for item in sources
        )
        title = Path(str(source["filename"])).stem if len(sources) == 1 else "合并知识版本"
        markdown = f"# {title}\n\n> 来源：\n{provenance}\n\n{text.strip()}\n"
        with target.open("x", encoding="utf-8") as output:
            output.write(markdown)
        try:
            with sqlite3.connect(self.database_path) as connection:
                connection.execute(
                    "INSERT INTO knowledge_versions (id, source_id, stored_name, status, created_by_user_id, created_at) VALUES (?, ?, ?, 'draft', ?, ?)",
                    (version_id, source["id"], stored_name, created_by_user_id, datetime.now(UTC).isoformat()),
                )
                connection.executemany(
                    "INSERT INTO knowledge_version_sources (version_id, source_id) VALUES (?, ?)",
                    [(version_id, item["id"]) for item in sources],
                )
        except Exception:
            target.unlink(missing_ok=True)
            raise
        return next(version for version in self.list_versions(source["id"]) if version["id"] == version_id)


def _legacy_source_policy(role_ids: list[str]) -> tuple[int, list[str]]:
    if "employee" in role_ids:
        return 2, ["knowledge"]
    if "knowledge-admin" in role_ids:
        return 4, ["knowledge"]
    scopes = [
        scope_id
        for scope_id in ("management", "procurement", "research", "sales")
        if scope_id in role_ids
    ]
    return (2 if scopes else 4, scopes)
