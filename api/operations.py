from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Iterator

import psycopg
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict

from api.authorization import AUTHORIZATION_SCHEMA_VERSION
from api.database import SCHEMA_VERSION
from api.identity import IDENTITY_SCHEMA_VERSION, SYSTEM_ROLES
from api.knowledge import KNOWLEDGE_SCHEMA_VERSION
from api.modules import load_persisted_module_modes, default_module_modes
from api.postgres import transaction, migrate, readiness, connect, database_lease, WRITE_LOCK, _migration_files, _check_environment, _verify_history
from api.procurement import PROCUREMENT_SCHEMA_VERSION
from api.settings import Settings
from api.workbenches import load_persisted_workbench_modes, default_workbench_modes


MANIFEST_NAME = "manifest.json"
DATABASE_NAME = "postgresql.dump"
SERVICE_PID_NAME = ".service.pid"
RESTORE_MARKER_NAME = ".restore-incomplete"
_ACTIVE_MARKERS: dict[Path, tuple[str, int]] = {}
_ACTIVE_MARKERS_LOCK = threading.Lock()
_SERVICE_LEASES: dict[Path, tuple[str, object, int]] = {}


def migrate_data(settings: Settings, *, include_workbenches: bool = True) -> dict[str, int]:
    # All schema changes are explicit; module visibility never changes which data is preserved.
    settings.ensure_directories()
    migrate(settings.database_url, settings.database_environment)
    return _schema_versions(settings.database_url)


def migrate_procurement_data(settings: Settings, *, backup_before_migration: bool = True) -> int:
    version = _schema_versions(settings.database_url).get("workbench_procurement_schema_version")
    if version != PROCUREMENT_SCHEMA_VERSION:
        raise RuntimeError("采购存储版本不兼容，请先运行 migrate")
    return version


def _pg_program(name: str) -> str:
    configured = os.environ.get("HONGHAO_PG_BIN")
    candidate = Path(configured) / (name + (".exe" if os.name == "nt" else "")) if configured else None
    if candidate is not None:
        if not candidate.is_file():
            raise FileNotFoundError("HONGHAO_PG_BIN 未包含所需 PostgreSQL 工具")
        return str(candidate)
    found = shutil.which(name)
    if found:
        return found
    candidate = Path("C:/Program Files/PostgreSQL/18/bin") / (name + ".exe")
    if os.name == "nt" and candidate.is_file():
        return str(candidate)
    raise FileNotFoundError("缺少 PostgreSQL 备份工具，请配置 HONGHAO_PG_BIN")


def _run_pg(name: str, args: list[str], url: str | None = None) -> str:
    environment = {key: value for key, value in os.environ.items() if not key.startswith("PG")}
    if url is not None:
        parameters = conninfo_to_dict(url)
        for key, variable in (("host", "PGHOST"), ("port", "PGPORT"), ("dbname", "PGDATABASE"), ("user", "PGUSER"),
                              ("password", "PGPASSWORD"), ("sslmode", "PGSSLMODE"), ("sslrootcert", "PGSSLROOTCERT"),
                              ("sslcert", "PGSSLCERT"), ("sslkey", "PGSSLKEY")):
            if key in parameters:
                environment[variable] = parameters[key]
    environment["PGCONNECT_TIMEOUT"] = "5"
    environment["PGCLIENTENCODING"] = "UTF8"
    try:
        result = subprocess.run([_pg_program(name), *args], env=environment, capture_output=True,
                                text=True, encoding="utf-8", errors="replace", timeout=300, check=False)
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"{name} 操作超时；未输出连接凭据或数据库内容") from None
    if result.returncode:
        # Native stderr can contain SQL values or connection credentials.
        raise RuntimeError(f"{name} 操作失败；请检查数据库权限、连接和快照完整性")
    return result.stdout


def _private_directory(parent: Path, prefix: str) -> Path:
    parent.mkdir(parents=True, exist_ok=True)
    directory = Path(tempfile.mkdtemp(prefix=prefix, dir=parent)).resolve()
    if os.name == "nt":
        user = os.environ["USERDOMAIN"] + "\\" + os.environ["USERNAME"]
        result = subprocess.run(["icacls", str(directory), "/inheritance:r", "/grant:r",
            f"{user}:(OI)(CI)F", "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"],
            capture_output=True, check=False)
        if result.returncode:
            directory.rmdir()
            raise RuntimeError("无法保护快照暂存目录")
    else:
        directory.chmod(0o700)
    return directory


def _remove_temporary(directory: Path, parent: Path) -> None:
    if directory.resolve().parent != parent.resolve() or directory.is_symlink() or directory.is_junction():
        raise RuntimeError("暂存目录边界发生变化，保留现场")
    shutil.rmtree(directory)


def _database_header(db, environment: str) -> list[list]:
    _check_environment(db, environment)
    files = _migration_files()
    if _verify_history(db, files) != len(files):
        raise RuntimeError("数据库尚未完成当前迁移")
    return [list(item[:3]) for item in files]


def _table_names(db) -> list[str]:
    return [row[0] for row in db.execute("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name")]


def _table_evidence(db, source_path_map: dict[str, str] | None = None) -> dict:
    result = {}
    for table in _table_names(db):
        cursor = db.execute(sql.SQL('SELECT * FROM public.{} ORDER BY _order').format(sql.Identifier(table)))
        digest = hashlib.sha256()
        count = 0
        for row in cursor:
            if table == "procurement_source_imports" and source_path_map:
                values = list(row)
                index = [c.name for c in cursor.description].index("stored_path")
                values[index] = source_path_map.get(values[index], values[index])
                row = values
            encoded = json.dumps(row, ensure_ascii=False, separators=(',', ':'),
                                 default=lambda value: {"bytes": bytes(value).hex()}).encode('utf-8')
            digest.update(encoded + b'\n')
            count += 1
        result[table] = {"count": count, "sha256": digest.hexdigest(), "columns": [c.name for c in cursor.description]}
    return result


def _references(db, data_dir: Path) -> tuple[list[str], list[dict]]:
    referenced = {f"knowledge/sources/{row[0]}" for row in db.execute('SELECT stored_name FROM knowledge_sources')}
    referenced |= {f"knowledge/items/{row[0]}" for row in db.execute('SELECT stored_name FROM knowledge_versions')}
    source_paths = []
    for digest, stored_path in db.execute('SELECT sha256,stored_path FROM procurement_source_imports ORDER BY sha256'):
        source = Path(stored_path)
        try:
            relative = source.resolve().relative_to(data_dir.resolve()).as_posix()
        except ValueError:
            raise ValueError("采购来源文件位于数据目录之外，须先完成受控路径迁移") from None
        if not relative.startswith('controlled-work/procurement-sources/') or not _allowed_snapshot_path(Path(relative)):
            raise ValueError("采购来源文件路径不符合受控目录约定")
        referenced.add(relative)
        source_paths.append({"sha256": digest, "stored_path": stored_path, "path": relative})
    return sorted(referenced), source_paths


def create_snapshot(settings: Settings, destination_root: Path) -> Path:
    settings.ensure_directories()
    destination_root = destination_root.resolve()
    timestamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S%fZ")
    target = destination_root / f"snapshot-{timestamp}"
    temporary = _private_directory(destination_root, ".snapshot-")
    try:
        # The same business-write lock covers the exported DB snapshot and its immutable attachments.
        with transaction(settings.database_url, write=True) as db:
            migrations = _database_header(db, settings.database_environment)
            exported = db.execute('SELECT pg_export_snapshot()').fetchone()[0]
            tables = _table_evidence(db)
            referenced, source_paths = _references(db, settings.data_dir)
            _run_pg('pg_dump', ['--no-password', '--format=custom', '--data-only', '--schema=public',
                '--no-owner', '--no-privileges', '--snapshot=' + exported, '--file=' + str(temporary / DATABASE_NAME)], settings.database_url)
            for source in _snapshot_sources(settings):
                relative = source.relative_to(settings.data_dir)
                destination = temporary / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, destination)
            manifest = {"version": 2, "engine": "postgresql", "created_at": datetime.now(UTC).isoformat(),
                "environment": settings.environment, "database_environment": settings.database_environment,
                "migrations": migrations, "tables": tables, "references": referenced, "source_paths": source_paths,
                "files": [_file_record(path, temporary) for path in _snapshot_files(temporary)]}
        _write_staging_manifest(temporary, manifest)
        verify_snapshot(temporary, expected_environment=settings.environment,
                        expected_database_environment=settings.database_environment)
        os.replace(temporary, target)
        return target
    finally:
        if temporary.exists():
            _remove_temporary(temporary, destination_root)


def verify_snapshot(snapshot: Path, *, expected_environment: str | None = None,
                    expected_database_environment: str | None = None) -> dict:
    snapshot = snapshot.resolve()
    manifest_path = snapshot / MANIFEST_NAME
    if not manifest_path.is_file():
        raise ValueError("快照缺少 manifest.json")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(manifest, dict) or manifest.get("version") != 2 or manifest.get("engine") != 'postgresql':
        raise ValueError("快照清单版本无效；旧 SQLite 快照仅供离线迁移")
    if expected_environment is not None and manifest.get("environment") != expected_environment:
        raise ValueError("快照与当前运行环境不匹配")
    if expected_database_environment is not None and manifest.get("database_environment") != expected_database_environment:
        raise ValueError("快照与目标数据库环境不匹配")
    if manifest.get('migrations') != [list(item[:3]) for item in _migration_files()]:
        raise ValueError("快照迁移版本与当前代码不匹配")
    files, tables = manifest.get("files"), manifest.get('tables')
    if not isinstance(files, list) or not files or not isinstance(tables, dict) or not tables:
        raise ValueError("快照清单为空")
    seen: set[str] = set()
    for record in files:
        if not isinstance(record, dict):
            raise ValueError("快照清单记录无效")
        relative = Path(str(record.get("path", "")))
        if relative.is_absolute() or '..' in relative.parts or relative.as_posix() in seen or not _allowed_snapshot_path(relative):
            raise ValueError("快照清单路径无效")
        seen.add(relative.as_posix())
        source = snapshot / relative
        _validate_local_file(source, snapshot)
        if source.stat().st_size != record.get("size") or _sha256(source) != record.get("sha256"):
            raise ValueError(f"快照文件校验失败：{relative.as_posix()}")
    if DATABASE_NAME not in seen:
        raise ValueError("快照缺少数据库")
    environment = manifest.get('environment')
    if environment not in {'test', 'production'}:
        raise ValueError('快照运行环境无效')
    environment_file = snapshot / 'environment'
    if environment_file.is_file() and environment_file.read_text(encoding='utf-8').strip() != environment:
        raise ValueError('快照环境标记与清单不一致')
    load_persisted_module_modes(snapshot, environment, default_module_modes(environment))
    load_persisted_workbench_modes(snapshot, environment, default_workbench_modes())
    references = manifest.get('references')
    if not isinstance(references, list) or any(not isinstance(item, str) for item in references):
        raise ValueError('快照引用清单无效')
    missing = sorted(set(references) - seen)
    if missing:
        raise ValueError(f"快照清单缺少数据库引用文件：{missing[0]}")
    source_paths = manifest.get('source_paths')
    if not isinstance(source_paths, list):
        raise ValueError('采购来源映射无效')
    for source in source_paths:
        if not isinstance(source, dict) or not all(isinstance(source.get(key), str) for key in ('path','stored_path','sha256')) or source.get('path') not in references or not str(source.get('path')).startswith('controlled-work/procurement-sources/'):
            raise ValueError('采购来源映射无效')
        if _sha256(snapshot / source['path']) != source.get('sha256'):
            raise ValueError('采购来源原件校验失败')
    for table, evidence in tables.items():
        if not re.fullmatch(r'[a-z_][a-z0-9_]*', table) or not isinstance(evidence, dict) or not isinstance(evidence.get('count'), int) or evidence['count'] < 0 or not re.fullmatch(r'[0-9a-f]{64}', str(evidence.get('sha256'))) or not isinstance(evidence.get('columns'), list) or not all(isinstance(column, str) for column in evidence['columns']):
            raise ValueError('数据库表清单无效')
    toc = _run_pg('pg_restore', ['--list', str(snapshot / DATABASE_NAME)])
    archived_tables = {match[1] for line in toc.splitlines() if (match := re.search(r' TABLE DATA public (\S+) ', line))}
    if any(match[1] != 'public' for line in toc.splitlines() if (match := re.search(r' (?:TABLE DATA|SEQUENCE SET) (\S+) ', line))):
        raise ValueError('数据库转储包含业务范围之外的对象')
    if archived_tables != set(tables):
        raise ValueError('数据库转储与表清单不一致')
    # Read and decompress the entire custom archive; --list alone cannot detect damaged payload blocks.
    _run_pg('pg_restore', ['--data-only', '--schema=public', '--no-owner', '--no-privileges', '--file=' + os.devnull, str(snapshot / DATABASE_NAME)])
    return manifest


def _empty_restore_target(db) -> bool:
    for table in _table_names(db):
        if table not in {'schema_metadata', 'identity_roles', 'procurement_working_state'} and db.execute(sql.SQL('SELECT 1 FROM public.{} LIMIT 1').format(sql.Identifier(table))).fetchone():
            return False
    roles = db.execute('SELECT id,name,system FROM identity_roles ORDER BY id').fetchall()
    versions = dict(db.execute('SELECT key,value FROM schema_metadata').fetchall())
    expected = {**_expected_schema_versions(), 'organization_schema_version': 1,
                'workbench_procurement_schema_version': PROCUREMENT_SCHEMA_VERSION, 'workbench_research_schema_version': 2}
    working = db.execute('SELECT id,latest_import_id,submitted_by,submitted_at FROM procurement_working_state').fetchall()
    return roles == sorted((key, name, 1) for key, name in SYSTEM_ROLES) and versions == expected and working == [(1,None,None,None)]


def _empty_restore_directory(settings: Settings) -> None:
    if not settings.data_dir.exists():
        return
    for path in settings.data_dir.rglob('*'):
        if path.is_symlink() or path.is_junction():
            raise ValueError('恢复目标目录不能包含链接')
        if path.is_file() and (path.name != 'environment' or path.parent != settings.data_dir or path.read_text(encoding='utf-8').strip() != settings.environment):
            raise ValueError('恢复仅允许空数据目录；现有文件保持不变')


def restore_snapshot(settings: Settings, snapshot: Path) -> None:
    manifest = verify_snapshot(snapshot, expected_environment=settings.environment,
                               expected_database_environment=settings.database_environment)
    if service_is_running(settings):
        raise RuntimeError('当前数据目录已有服务或恢复操作运行')
    _empty_restore_directory(settings)
    settings.ensure_directories()
    staging = _private_directory(settings.data_dir.parent, '.restore-')
    installed: list[Path] = []
    marker = settings.data_dir / RESTORE_MARKER_NAME
    restored = False
    try:
        with _runtime_marker(settings, 'restore'), database_lease(settings.database_url) as lease, connect(settings.database_url) as db:
            # A session lock survives preflight's statements without retaining table read locks.
            db.execute('SELECT pg_advisory_lock(%s)', (WRITE_LOCK,))
            _database_header(db, settings.database_environment)
            if not db.execute("SELECT has_table_privilege(current_user,'honghao_meta.schema_migrations','INSERT')").fetchone()[0]:
                raise PermissionError('恢复须使用迁移账号')
            if not _empty_restore_target(db):
                raise ValueError('恢复仅允许空业务数据库；现有数据保持不变')
            if set(_table_evidence(db)) != set(manifest['tables']):
                raise ValueError('目标数据库表结构与快照不一致')
            for record in manifest['files']:
                relative = Path(record['path'])
                target = staging / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(snapshot / relative, target)
            _write_staging_manifest(staging, manifest)
            verify_snapshot(staging, expected_environment=settings.environment,
                            expected_database_environment=settings.database_environment)
            restore_sql = staging / 'restore.sql'
            _run_pg('pg_restore', ['--data-only', '--schema=public', '--no-owner', '--no-privileges', '--file=' + str(restore_sql), str(staging / DATABASE_NAME)])
            tables = sql.SQL(',').join(sql.Identifier('public', table) for table in sorted(manifest['tables']))
            (staging / 'before.sql').write_text(sql.SQL('TRUNCATE {} RESTART IDENTITY;').format(tables).as_string(db), encoding='utf-8')
            mappings = [sql.SQL('UPDATE public.procurement_source_imports SET stored_path={} WHERE sha256={} AND stored_path={};').format(
                sql.Literal(str(settings.data_dir / source['path'])), sql.Literal(source['sha256']), sql.Literal(source['stored_path'])).as_string(db)
                for source in manifest.get('source_paths', [])]
            (staging / 'after.sql').write_text('\n'.join(mappings), encoding='utf-8')
            marker.write_text('恢复未完成；禁止启动。请核验数据库与附件后处理。', encoding='utf-8')
            for record in manifest['files']:
                relative = Path(record['path'])
                if relative.as_posix() in {DATABASE_NAME, 'environment'}:
                    continue
                target = settings.data_dir / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                if target.exists():
                    raise ValueError('恢复目标已出现文件，停止覆盖')
                # Creating the destination link is atomic and cannot replace a file appearing after preflight.
                os.link(staging / relative, target)
                installed.append(target)
            # Native PostgreSQL SQL is restored unchanged; only the explicit source-file mapping is appended.
            # psql keeps seed removal, COPY, sequence restoration and path relocation in one transaction.
            lease.execute('SELECT 1')
            _run_pg('psql', ['-X', '--no-password', '--quiet', '--set=ON_ERROR_STOP=1', '--single-transaction',
                '--file=' + str(staging / 'before.sql'), '--file=' + str(restore_sql), '--file=' + str(staging / 'after.sql')], settings.database_url)
            restored = True
            _database_header(db, settings.database_environment)
            restored_tables = _table_evidence(db, {str(settings.data_dir / source['path']): source['stored_path'] for source in manifest['source_paths']})
            for table, expected in manifest['tables'].items():
                if restored_tables.get(table) != expected:
                    raise RuntimeError('恢复后的数据库内容与快照不一致，保留现场供核验')
            references, source_paths = _references(db, settings.data_dir)
            if references != sorted(manifest['references']) or [(s['sha256'],s['path']) for s in source_paths] != [(s['sha256'],s['path']) for s in manifest.get('source_paths', [])]:
                raise RuntimeError('恢复后的引用文件与快照不一致，保留现场供核验')
            lease.execute('SELECT 1')
            marker.unlink()
    except BaseException:
        # A failed native transaction leaves original seed rows intact. If its outcome is uncertain,
        # retain both attachments and the persistent marker instead of allowing an incomplete service to start.
        safe_to_remove = not restored
        if marker.exists() and safe_to_remove:
            try:
                with transaction(settings.database_url) as db:
                    safe_to_remove = _empty_restore_target(db)
            except (psycopg.Error, RuntimeError, ValueError):
                safe_to_remove = False
        if safe_to_remove:
            for target in reversed(installed):
                _validate_local_file(target, settings.data_dir)
                target.unlink()
            marker.unlink(missing_ok=True)
        raise
    finally:
        _remove_temporary(staging, settings.data_dir.parent)


def doctor(settings: Settings) -> list[tuple[str, str, bool | None]]:
    result = readiness_checks(settings)
    checks = [('数据目录', '可读写' if result['data_directory'] == 'ok' else '不可用或恢复未完成', result['data_directory'] == 'ok'),
              ('数据库', json.dumps({k:v for k,v in result.items() if k != 'data_directory'}, ensure_ascii=False), all(v == 'ok' for v in result.values())),
              ('模块配置', f'{settings.environment} / 已验证', result['module_configuration'] == 'ok')]
    try:
        from pypdf import PdfReader  # noqa: F401
        checks.append(('PDF 解析器', '已安装', True))
    except ImportError:
        checks.append(('PDF 解析器', '未安装 pypdf', False))
    detail, passed = _antivirus_status()
    checks.append(('防病毒', detail, passed))
    installed = importlib.util.find_spec('deepseek_harness') is not None
    checks.append(('Harness', '依赖已安装' if installed else '预留接口已记录，内核尚未安装', True if installed else None))
    return checks


def readiness_checks(settings: Settings) -> dict[str, str]:
    checks = {**readiness(settings.database_url, settings.database_environment),
              'data_directory': 'failed', 'module_configuration': 'failed'}
    try:
        versions = _schema_versions(settings.database_url)
        with transaction(settings.database_url) as db:
            required = {name.strip('"') for _, _, _, content in _migration_files() for name in
                        re.findall(r'CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|VIEW)\s+([\w."]+)', content, re.IGNORECASE)}
            names = [name if '.' in name else 'public.' + name for name in required]
            objects_ready = db.execute('SELECT bool_and(to_regclass(name) IS NOT NULL) FROM unnest(%s::text[]) AS object(name)', (names,)).fetchone()[0]
        if not _core_schema_versions_valid(versions) or not objects_ready:
            checks['schema_versions'] = 'failed'
    except (psycopg.Error, OSError, RuntimeError, ValueError):
        checks['schema_versions'] = 'failed'
    _, directory_ready = _data_directory_status(settings)
    if directory_ready:
        checks['data_directory'] = 'ok'
    try:
        load_persisted_module_modes(settings.data_dir, settings.environment, settings.module_modes)
        load_persisted_workbench_modes(settings.data_dir, settings.environment, settings.workbench_modes)
        if all(mode in {'off', 'prototype', 'active'} for mode in [*settings.module_modes.values(), *settings.workbench_modes.values()]):
            checks['module_configuration'] = 'ok'
    except (OSError, RuntimeError, ValueError):
        pass
    return checks


def _data_directory_status(settings: Settings) -> tuple[str, bool]:
    try:
        if (settings.data_dir / RESTORE_MARKER_NAME).exists():
            raise ValueError('恢复尚未完成，禁止启动')
        settings.ensure_directories()
        with tempfile.NamedTemporaryFile(dir=settings.data_dir):
            pass
        return '可读写', True
    except (OSError, ValueError) as error:
        return str(error), False


def _expected_schema_versions() -> dict[str, int]:
    return {'schema_version': SCHEMA_VERSION, 'identity_schema_version': IDENTITY_SCHEMA_VERSION,
            'authorization_schema_version': AUTHORIZATION_SCHEMA_VERSION, 'knowledge_schema_version': KNOWLEDGE_SCHEMA_VERSION,
            'organization_schema_version': 1, 'workbench_procurement_schema_version': PROCUREMENT_SCHEMA_VERSION, 'workbench_research_schema_version': 2}


def _core_schema_versions_valid(versions: dict[str, int]) -> bool:
    return all(versions.get(key) == value for key, value in _expected_schema_versions().items())


def _schema_versions(url: str) -> dict[str, int]:
    with transaction(url) as db:
        return {str(key): int(value) for key,value in db.execute('SELECT key,value FROM schema_metadata')}


@contextmanager
def service_marker(settings: Settings) -> Iterator[None]:
    if (settings.data_dir / RESTORE_MARKER_NAME).exists():
        raise RuntimeError("恢复尚未完成，禁止启动")
    key = settings.data_dir.resolve()
    with _runtime_marker(settings, "service"):
        with _ACTIVE_MARKERS_LOCK:
            active = _SERVICE_LEASES.get(key)
            if active is not None:
                url, lease, count = active
                if url != settings.database_url:
                    raise RuntimeError("同一服务目录不能切换数据库")
                _SERVICE_LEASES[key] = (url, lease, count + 1)
            else:
                lease = database_lease(settings.database_url)
                lease.__enter__()
                _SERVICE_LEASES[key] = (settings.database_url, lease, 1)
        try:
            yield
        finally:
            with _ACTIVE_MARKERS_LOCK:
                url, lease, count = _SERVICE_LEASES[key]
                if count > 1:
                    _SERVICE_LEASES[key] = (url, lease, count - 1)
                else:
                    del _SERVICE_LEASES[key]
                    lease.__exit__(None, None, None)


def service_is_running(settings: Settings) -> bool:
    marker = settings.data_dir / SERVICE_PID_NAME
    if not marker.is_file():
        return False
    try:
        pid = int(marker.read_text(encoding="ascii").strip().split(":", 1)[-1])
        if pid <= 0:
            return True
        if pid == os.getpid():
            return True
        if os.name == "nt":
            # Windows os.kill(pid, 0) is not a portable liveness probe.
            import ctypes
            from ctypes import wintypes
            kernel = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
            kernel.OpenProcess.restype = wintypes.HANDLE
            kernel.WaitForSingleObject.argtypes = (wintypes.HANDLE, wintypes.DWORD)
            kernel.WaitForSingleObject.restype = wintypes.DWORD
            kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
            handle = kernel.OpenProcess(0x00100000, False, pid)  # SYNCHRONIZE only
            if not handle:
                if ctypes.get_last_error() == 87:  # PID no longer exists
                    marker.unlink(missing_ok=True)
                    return False
                return True  # Cannot inspect: keep the directory locked.
            try:
                if kernel.WaitForSingleObject(handle, 0) != 0:
                    return True
                marker.unlink(missing_ok=True)
                return False
            finally:
                kernel.CloseHandle(handle)
        os.kill(pid, 0)
        return True
    except ValueError:
        return True  # Another owner may have created but not finished writing it.
    except ProcessLookupError:
        marker.unlink(missing_ok=True)
        return False
    except PermissionError:
        return True
    except OSError:
        return True  # Unknown query/read failure must not unlock a live service.


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


def _validate_local_file(path: Path, root: Path) -> None:
    resolved_root = root.resolve()
    if not path.is_file() or not path.resolve().is_relative_to(resolved_root):
        raise ValueError('快照文件缺失或超出受控目录')
    for candidate in [path, *path.parents]:
        if candidate == root.parent:
            break
        if candidate.is_symlink() or candidate.is_junction():
            raise ValueError('快照文件不能通过链接访问')


def _snapshot_sources(settings: Settings) -> list[Path]:
    files = [settings.data_dir / name for name in ('environment', 'runtime-config.json', 'workbench-runtime-config.json')
             if (settings.data_dir / name).is_file()]
    for directory in ('knowledge', 'controlled-work/procurement-sources'):
        root = settings.data_dir / directory
        if root.is_symlink() or root.is_junction():
            raise ValueError('快照来源不能是链接')
        if root.is_dir():
            for path in root.rglob('*'):
                if path.is_symlink() or path.is_junction():
                    raise ValueError('快照来源不能是链接')
                if path.is_file() and _allowed_snapshot_path(path.relative_to(settings.data_dir)):
                    files.append(path)
    for path in files:
        _validate_local_file(path, settings.data_dir)
    return sorted(files)


def _snapshot_files(root: Path) -> list[Path]:
    return sorted(path for path in root.rglob('*') if path.is_file() and path.name != MANIFEST_NAME)


def _file_record(path: Path, root: Path) -> dict:
    return {'path': path.relative_to(root).as_posix(), 'size': path.stat().st_size, 'sha256': _sha256(path)}


def _allowed_snapshot_path(path: Path) -> bool:
    if path.as_posix() in {DATABASE_NAME, 'environment', 'runtime-config.json', 'workbench-runtime-config.json'}:
        return True
    return len(path.parts) == 3 and ((path.parts[:2] == ('knowledge', 'sources') and path.suffix.lower() == '.pdf') or
        (path.parts[:2] == ('knowledge', 'items') and path.suffix.lower() == '.md') or
        (path.parts[:2] == ('controlled-work', 'procurement-sources') and path.suffix.lower() == '.xlsx'))


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _write_staging_manifest(staging: Path, manifest: dict) -> Path:
    (staging / MANIFEST_NAME).write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
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
