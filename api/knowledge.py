from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, BinaryIO
from uuid import uuid4

from api.identity import IdentityStore
from api.postgres import transaction


KNOWLEDGE_SCHEMA_VERSION = 6
MAX_SOURCE_BYTES = 50 * 1024 * 1024


class InvalidKnowledgeSourceError(ValueError):
    pass


class KnowledgeStore:
    def __init__(self, database_url: str, data_dir: Path) -> None:
        self.database_url = database_url
        self.sources_dir = data_dir / "knowledge" / "sources"
        self.items_dir = data_dir / "knowledge" / "items"

    def initialize(self) -> None:
        self.sources_dir.mkdir(parents=True, exist_ok=True)
        self.items_dir.mkdir(parents=True, exist_ok=True)
        if self.schema_version() != KNOWLEDGE_SCHEMA_VERSION:
            raise RuntimeError("Unsupported knowledge schema version")
        with transaction(self.database_url, write=True) as connection:
            connection.execute(
                "UPDATE knowledge_sources SET processing_status = 'parse_failed', processing_error = 'interrupted' WHERE processing_status = 'processing'"
            )

    def schema_version(self) -> int:
        with transaction(self.database_url) as connection:
            row = connection.execute(
                "SELECT value FROM schema_metadata WHERE key = %s",
                ("knowledge_schema_version",),
            ).fetchone()
        if row is None:
            raise RuntimeError("Knowledge schema is not initialized")
        return int(row[0])

    def _require_writer(self, actor_id: str, *, administrator: bool = False) -> None:
        user = IdentityStore(self.database_url).get_user(actor_id)
        if user is None or not user["is_active"]:
            raise PermissionError("账号已失效，请重新登录")
        if not user["is_system_admin"] and (administrator or user["scope_levels"].get("knowledge", 0) < 3):
            raise PermissionError("知识操作权限已变化，请刷新后重试")

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
            with transaction(self.database_url, write=True) as connection:
                self._require_writer(created_by_user_id)
                duplicate = connection.execute(
                    "SELECT id FROM knowledge_sources WHERE sha256 = %s ORDER BY _order LIMIT 1",
                    (digest.hexdigest(),),
                ).fetchone()
                connection.execute(
                    "INSERT INTO knowledge_sources (id, filename, mime_type, size_bytes, sha256, stored_name, legacy_storage_status, duplicate_of, created_by_user_id, read_min_level, read_scope_ids, created_at) VALUES (%s, %s, %s, %s, %s, %s, 'quarantined', %s, %s, %s, %s, %s)",
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
        with transaction(self.database_url) as connection:
            row = connection.execute(
                "SELECT id, filename, mime_type, size_bytes, sha256, stored_name, safety_status, processing_status, duplicate_of, created_at, processing_error, read_min_level, read_scope_ids FROM knowledge_sources WHERE id = %s",
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
        with transaction(self.database_url, write=True) as connection:
            self._require_writer(confirmed_by_user_id, administrator=True)
            claimed = connection.execute(
                "UPDATE knowledge_sources SET safety_status = 'confirmed', processing_status = 'processing', processing_error = NULL WHERE id = %s AND safety_status = 'quarantined'",
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
        with transaction(self.database_url, write=True) as connection:
            connection.execute(
                "UPDATE knowledge_sources SET processing_status = %s, processing_error = %s WHERE id = %s",
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
        with transaction(self.database_url) as connection:
            rows = connection.execute(
                "SELECT versions.id, versions.status, versions.created_at FROM knowledge_versions AS versions JOIN knowledge_derived_index AS derived ON derived.version_id = versions.id WHERE derived.source_id = %s ORDER BY versions._order",
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
                            "SELECT source_id FROM knowledge_version_sources WHERE version_id = %s ORDER BY _order",
                            (row[0],),
                        )
                    ],
                }
                for row in rows
            ]

    def version_path(self, source_id: str, version_id: str) -> Path | None:
        with transaction(self.database_url) as connection:
            row = connection.execute(
                "SELECT versions.stored_name FROM knowledge_versions AS versions JOIN knowledge_version_sources AS links ON links.version_id = versions.id WHERE versions.id = %s AND links.source_id = %s",
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
            with transaction(self.database_url, write=True) as connection:
                self._require_writer(created_by_user_id, administrator=True)
                connection.execute(
                    "INSERT INTO knowledge_versions (id, source_id, stored_name, status, created_by_user_id, created_at) VALUES (%s, %s, %s, 'draft', %s, %s)",
                    (version_id, source["id"], stored_name, created_by_user_id, datetime.now(UTC).isoformat()),
                )
                with connection.cursor() as cursor:
                    cursor.executemany(
                        "INSERT INTO knowledge_version_sources (version_id, source_id) VALUES (%s, %s)",
                        [(version_id, item["id"]) for item in sources],
                    )
        except Exception:
            target.unlink(missing_ok=True)
            raise
        return next(version for version in self.list_versions(source["id"]) if version["id"] == version_id)
