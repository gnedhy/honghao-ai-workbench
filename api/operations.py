from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
from contextlib import closing, contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Iterator

from api.authorization import AUTHORIZATION_SCHEMA_VERSION, AuthorizationStore
from api.database import SCHEMA_VERSION, Database
from api.identity import IDENTITY_SCHEMA_VERSION, IdentityStore
from api.knowledge import KNOWLEDGE_SCHEMA_VERSION, KnowledgeStore
from api.modules import load_persisted_module_modes
from api.settings import Settings
from api.workbenches import load_persisted_workbench_modes
from scripts.backup_database import backup_database


MANIFEST_NAME = "manifest.json"
SERVICE_PID_NAME = ".service.pid"
_ACTIVE_MARKERS: dict[Path, tuple[str, int]] = {}
_ACTIVE_MARKERS_LOCK = threading.Lock()


def migrate_data(settings: Settings) -> dict[str, int]:
    settings.ensure_directories()
    database = Database(settings.database_path)
    database.initialize()
    _backup_before_access_migration(settings)
    identities = IdentityStore(settings.database_path)
    authorization = AuthorizationStore(settings.database_path)
    knowledge = KnowledgeStore(settings.database_path, settings.data_dir)
    identities.initialize()
    authorization.initialize()
    knowledge.initialize()
    return {
        "core": database.schema_version(),
        "identity": IDENTITY_SCHEMA_VERSION,
        "authorization": AUTHORIZATION_SCHEMA_VERSION,
        "knowledge": knowledge.schema_version(),
    }


def create_snapshot(settings: Settings, destination_root: Path) -> Path:
    if not settings.database_path.is_file():
        raise FileNotFoundError("数据库不存在，请先运行 migrate")
    destination_root = destination_root.resolve()
    destination_root.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S%fZ")
    target = destination_root / f"snapshot-{timestamp}"
    temporary = Path(tempfile.mkdtemp(prefix=".snapshot-", dir=destination_root))
    try:
        backup_database(settings.database_path, temporary / "honghao.db")
        for source in _snapshot_sources(settings):
            relative = source.relative_to(settings.data_dir)
            destination = temporary / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
        files = [_file_record(path, temporary) for path in _snapshot_files(temporary)]
        manifest = {
            "version": 1,
            "created_at": datetime.now(UTC).isoformat(),
            "environment": settings.environment,
            "files": files,
        }
        (temporary / MANIFEST_NAME).write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        verify_snapshot(temporary, expected_environment=settings.environment)
        os.replace(temporary, target)
        return target
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


def verify_snapshot(snapshot: Path, *, expected_environment: str | None = None) -> dict:
    snapshot = snapshot.resolve()
    manifest_path = snapshot / MANIFEST_NAME
    if not manifest_path.is_file():
        raise ValueError("快照缺少 manifest.json")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(manifest, dict) or manifest.get("version") != 1:
        raise ValueError("快照清单版本无效")
    if expected_environment is not None and manifest.get("environment") != expected_environment:
        raise ValueError("快照与当前运行环境不匹配")
    files = manifest.get("files")
    if not isinstance(files, list) or not files:
        raise ValueError("快照清单为空")
    seen: set[str] = set()
    for record in files:
        if not isinstance(record, dict):
            raise ValueError("快照清单记录无效")
        relative = Path(str(record.get("path", "")))
        if (
            relative.is_absolute()
            or ".." in relative.parts
            or relative.as_posix() in seen
            or not _allowed_snapshot_path(relative)
        ):
            raise ValueError("快照清单路径无效")
        seen.add(relative.as_posix())
        source = snapshot / relative
        if source.is_symlink() or not source.is_file():
            raise ValueError(f"快照文件缺失：{relative.as_posix()}")
        if source.stat().st_size != record.get("size") or _sha256(source) != record.get("sha256"):
            raise ValueError(f"快照文件校验失败：{relative.as_posix()}")
    if "honghao.db" not in seen:
        raise ValueError("快照缺少数据库")
    try:
        with closing(sqlite3.connect(snapshot / "honghao.db")) as connection:
            if connection.execute("PRAGMA integrity_check").fetchone() != ("ok",):
                raise ValueError("快照数据库完整性校验失败")
            referenced = {
                f"knowledge/sources/{stored_name}"
                for stored_name, in connection.execute("SELECT stored_name FROM knowledge_sources")
            } | {
                f"knowledge/items/{stored_name}"
                for stored_name, in connection.execute("SELECT stored_name FROM knowledge_versions")
            }
    except sqlite3.DatabaseError as error:
        raise ValueError("快照数据库无法读取") from error
    missing = sorted(referenced - seen)
    if missing:
        raise ValueError(f"快照清单缺少数据库引用文件：{missing[0]}")
    return manifest


def restore_snapshot(settings: Settings, snapshot: Path) -> Path | None:
    settings.ensure_directories()
    with _runtime_marker(settings, "restore"):
        manifest = verify_snapshot(snapshot, expected_environment=settings.environment)
        rollback = (
            create_snapshot(settings, settings.data_dir / "backups")
            if settings.database_path.is_file()
            else None
        )
        staging = Path(tempfile.mkdtemp(prefix=".restore-", dir=settings.data_dir))
        try:
            records = sorted(
                manifest["files"],
                key=lambda record: record["path"] == "honghao.db",
            )
            for record in records:
                relative = Path(record["path"])
                source = snapshot / relative
                target = staging / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, target)
            verify_snapshot(
                _write_staging_manifest(staging, manifest),
                expected_environment=settings.environment,
            )
            snapshot_paths = {record["path"] for record in records}
            for config_name in ("runtime-config.json", "workbench-runtime-config.json"):
                if config_name not in snapshot_paths:
                    (settings.data_dir / config_name).unlink(missing_ok=True)
            for record in records:
                relative = Path(record["path"])
                target = settings.data_dir / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                if relative.as_posix() == "honghao.db":
                    with closing(sqlite3.connect(staging / relative)) as source_connection:
                        with closing(sqlite3.connect(target)) as target_connection:
                            source_connection.backup(target_connection)
                    continue
                temporary_target = target.with_name(f".{target.name}.restore")
                shutil.copy2(staging / relative, temporary_target)
                os.replace(temporary_target, target)
            return rollback
        finally:
            shutil.rmtree(staging, ignore_errors=True)


def doctor(settings: Settings) -> list[tuple[str, str, bool | None]]:
    checks: list[tuple[str, str, bool | None]] = []
    directory_detail, directory_ready = _data_directory_status(settings)
    checks.append(("数据目录", directory_detail, directory_ready))
    try:
        versions = _schema_versions(settings.database_path)
        valid = versions == _expected_schema_versions()
        checks.append(("数据库", json.dumps(versions, ensure_ascii=False), valid))
    except (OSError, sqlite3.Error, RuntimeError) as error:
        checks.append(("数据库", str(error), False))
    checks.append(("模块配置", f"{settings.environment} / 已验证", True))
    try:
        from pypdf import PdfReader  # noqa: F401

        checks.append(("PDF 解析器", "已安装", True))
    except ImportError:
        checks.append(("PDF 解析器", "未安装 pypdf", False))
    antivirus_detail, antivirus_result = _antivirus_status()
    checks.append(("防病毒", antivirus_detail, antivirus_result))
    harness_installed = importlib.util.find_spec("deepseek_harness") is not None
    harness_detail = "依赖已安装" if harness_installed else "预留接口已记录，内核尚未安装"
    checks.append(("Harness", harness_detail, True if harness_installed else None))
    return checks


def readiness_checks(settings: Settings) -> dict[str, str]:
    checks = {
        "data_directory": "failed",
        "database": "failed",
        "module_configuration": "failed",
        "schema_versions": "failed",
    }
    _, directory_ready = _data_directory_status(settings)
    if directory_ready:
        checks["data_directory"] = "ok"
    if settings.database_path.is_file():
        checks["database"] = "ok"
        try:
            versions = _schema_versions(settings.database_path)
            if versions == _expected_schema_versions():
                checks["schema_versions"] = "ok"
        except (OSError, sqlite3.Error, RuntimeError):
            pass
    try:
        load_persisted_module_modes(
            settings.data_dir,
            settings.environment,
            settings.module_modes,
        )
        load_persisted_workbench_modes(
            settings.data_dir,
            settings.environment,
            settings.workbench_modes,
        )
        valid_modes = all(mode in {"off", "prototype", "active"} for mode in settings.module_modes.values())
        valid_workbenches = all(mode in {"off", "prototype", "active"} for mode in settings.workbench_modes.values())
    except (OSError, RuntimeError, ValueError):
        valid_modes = valid_workbenches = False
    if valid_modes and valid_workbenches:
        checks["module_configuration"] = "ok"
    return checks


def _data_directory_status(settings: Settings) -> tuple[str, bool]:
    try:
        settings.ensure_directories()
        with tempfile.NamedTemporaryFile(dir=settings.data_dir):
            pass
        return "可读写", True
    except (OSError, ValueError) as error:
        return str(error), False


def _expected_schema_versions() -> dict[str, int]:
    return {
        "schema_version": SCHEMA_VERSION,
        "identity_schema_version": IDENTITY_SCHEMA_VERSION,
        "authorization_schema_version": AUTHORIZATION_SCHEMA_VERSION,
        "knowledge_schema_version": KNOWLEDGE_SCHEMA_VERSION,
    }


@contextmanager
def service_marker(settings: Settings) -> Iterator[None]:
    with _runtime_marker(settings, "service"):
        yield


def service_is_running(settings: Settings) -> bool:
    marker = settings.data_dir / SERVICE_PID_NAME
    if not marker.is_file():
        return False
    try:
        pid = int(marker.read_text(encoding="ascii").strip().split(":", 1)[-1])
        if pid == os.getpid():
            return True
        os.kill(pid, 0)
        return True
    except (ValueError, ProcessLookupError):
        marker.unlink(missing_ok=True)
        return False
    except PermissionError:
        return True
    except OSError:
        marker.unlink(missing_ok=True)
        return False


@contextmanager
def _runtime_marker(settings: Settings, owner: str) -> Iterator[None]:
    marker = settings.data_dir / SERVICE_PID_NAME
    key = marker.resolve()
    with _ACTIVE_MARKERS_LOCK:
        active = _ACTIVE_MARKERS.get(key)
        if active is not None:
            active_owner, count = active
            if owner != "service" or active_owner != "service":
                raise RuntimeError("当前数据目录已有服务或恢复操作运行")
            _ACTIVE_MARKERS[key] = (owner, count + 1)
        else:
            if service_is_running(settings):
                raise RuntimeError("当前数据目录已有服务或恢复操作运行")
            try:
                with marker.open("x", encoding="ascii") as output:
                    output.write(f"{owner}:{os.getpid()}")
            except FileExistsError as error:
                raise RuntimeError("当前数据目录已被占用") from error
            _ACTIVE_MARKERS[key] = (owner, 1)
    try:
        yield
    finally:
        with _ACTIVE_MARKERS_LOCK:
            _, count = _ACTIVE_MARKERS[key]
            if count > 1:
                _ACTIVE_MARKERS[key] = (owner, count - 1)
            else:
                del _ACTIVE_MARKERS[key]
                expected = f"{owner}:{os.getpid()}"
                if marker.exists() and marker.read_text(encoding="ascii").strip() == expected:
                    marker.unlink()


def _backup_before_access_migration(settings: Settings) -> Path | None:
    targets = {
        "identity_schema_version": IDENTITY_SCHEMA_VERSION,
        "authorization_schema_version": AUTHORIZATION_SCHEMA_VERSION,
        "knowledge_schema_version": KNOWLEDGE_SCHEMA_VERSION,
    }
    versions = _schema_versions(settings.database_path)
    if not any(key in versions and versions[key] < target for key, target in targets.items()):
        return None
    timestamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S%fZ")
    destination = settings.data_dir / "backups" / f"pre-access-level-migration-{timestamp}.db"
    backup_database(settings.database_path, destination)
    return destination


def _schema_versions(database_path: Path) -> dict[str, int]:
    if not database_path.is_file():
        raise FileNotFoundError(database_path)
    keys = (
        "schema_version",
        "identity_schema_version",
        "authorization_schema_version",
        "knowledge_schema_version",
    )
    with closing(sqlite3.connect(database_path)) as connection:
        return {
            str(key): int(value)
            for key, value in connection.execute(
                "SELECT key, value FROM schema_metadata WHERE key IN (?, ?, ?, ?)",
                keys,
            )
        }


def _snapshot_sources(settings: Settings) -> list[Path]:
    files = [
        path
        for path in (
            settings.data_dir / "environment",
            settings.data_dir / "runtime-config.json",
            settings.data_dir / "workbench-runtime-config.json",
        )
        if path.is_file()
    ]
    knowledge = settings.data_dir / "knowledge"
    if knowledge.is_dir():
        for path in knowledge.rglob("*"):
            if path.is_symlink():
                raise ValueError(f"知识文件不能是符号链接：{path}")
            if path.is_file() and path.suffix.lower() in {".pdf", ".md"}:
                files.append(path)
    return sorted(files)


def _snapshot_files(root: Path) -> list[Path]:
    return sorted(path for path in root.rglob("*") if path.is_file() and path.name != MANIFEST_NAME)


def _file_record(path: Path, root: Path) -> dict[str, str | int]:
    return {
        "path": path.relative_to(root).as_posix(),
        "size": path.stat().st_size,
        "sha256": _sha256(path),
    }


def _allowed_snapshot_path(path: Path) -> bool:
    if path.as_posix() in {"honghao.db", "environment", "runtime-config.json", "workbench-runtime-config.json"}:
        return True
    if len(path.parts) < 3:
        return False
    return (
        path.parts[:2] == ("knowledge", "sources") and path.suffix.lower() == ".pdf"
    ) or (
        path.parts[:2] == ("knowledge", "items") and path.suffix.lower() == ".md"
    )


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _write_staging_manifest(staging: Path, manifest: dict) -> Path:
    (staging / MANIFEST_NAME).write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return staging


def _antivirus_status() -> tuple[str, bool | None]:
    if sys.platform != "win32":
        return "非 Windows 环境，请人工确认", None
    try:
        result = subprocess.run(
            [
                "powershell.exe",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "$s=Get-MpComputerStatus; \"$($s.AntivirusEnabled),$($s.RealTimeProtectionEnabled)\"",
            ],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return "无法自动读取，请人工确认", None
    if result.returncode == 0 and result.stdout.strip() == "True,True":
        return "已启用", True
    return "未确认，请人工检查", None
