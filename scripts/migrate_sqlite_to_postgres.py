"""Offline import of the frozen SQLite baseline; never used by the application."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sqlite3
import sys
from contextlib import closing
from graphlib import TopologicalSorter
from pathlib import Path

import psycopg
from psycopg import sql

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from api import operations as ops
from api.postgres import database_lease, transaction
from api.settings import Settings


def _quote(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _prepare(baseline: Path, staging: Path, environment: str) -> tuple[dict, list[str]]:
    """Use the step-one hash manifest, including its supplemental original files."""
    root = baseline.resolve().parent
    record = json.loads(baseline.read_text(encoding='utf-8'))
    snapshot = Path(record['snapshot']).resolve()
    if not snapshot.is_relative_to(root):
        raise ValueError('冻结快照必须位于基线目录内')
    prefix = snapshot.relative_to(root).as_posix() + '/'
    selected = {}
    for name, evidence in record['files'].items():
        if name.startswith(prefix):
            relative = name[len(prefix):]
        elif name.startswith('supplemental/'):
            relative = name[len('supplemental/'):]
        else:
            continue
        path = Path(relative)
        if path.is_absolute() or '..' in path.parts:
            raise ValueError('基线包含无效文件路径')
        if not (relative in {'honghao.db', 'release.json'} or ops._allowed_snapshot_path(path)):
            continue
        source = root / name
        ops._validate_local_file(source, root)
        if source.stat().st_size != evidence['size'] or ops._sha256(source) != evidence['sha256']:
            raise ValueError('冻结文件校验失败')
        if relative in selected and selected[relative] != evidence:
            raise ValueError('快照与补充原件内容冲突')
        selected[relative] = evidence
        target = staging / path
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        if ops._sha256(target) != evidence['sha256']:
            raise ValueError('暂存文件校验失败')
    if not {'honghao.db', 'environment'} <= selected.keys():
        raise ValueError('冻结基线缺少数据库或环境标记')
    if (staging / 'environment').read_text(encoding='utf-8').strip() != environment:
        raise ValueError('冻结副本与目标运行环境不一致')
    Settings.from_data_dir(staging, environment=environment,
        database_url='postgresql://validation@localhost/validation', database_environment='acceptance')
    return record, sorted(set(selected) - {'honghao.db', 'environment'})


def _source_evidence(source: sqlite3.Connection) -> dict:
    if source.execute('PRAGMA integrity_check').fetchall() != [('ok',)] or source.execute('PRAGMA foreign_key_check').fetchall():
        raise ValueError('SQLite 完整性或外键校验失败')
    if dict(source.execute('SELECT key,value FROM schema_metadata')) != ops._expected_schema_versions():
        raise ValueError('SQLite 业务版本与迁移工具不兼容')
    tables = {}
    for (table,) in source.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").fetchall():
        cursor = source.execute(f'SELECT *,rowid AS _order FROM {_quote(table)} ORDER BY rowid')
        columns = [c[0] for c in cursor.description]
        if columns.count('_order') != 1:
            raise ValueError('源数据已有保留的排序字段')
        digest, count = hashlib.sha256(), 0
        for row in cursor:
            digest.update(json.dumps(row, ensure_ascii=False, separators=(',', ':'),
                default=lambda value: {'bytes': bytes(value).hex()}).encode('utf-8') + b'\n')
            count += 1
        tables[table] = {'columns': columns, 'count': count, 'sha256': digest.hexdigest()}
    return tables


def _source_paths(source: sqlite3.Connection, staging: Path, target: Path, record: dict) -> dict[str, str]:
    mappings = {}
    for digest, stored in source.execute('SELECT sha256,stored_path FROM procurement_source_imports'):
        candidates = [r for r in record['source_files'] if r['sha256'] == digest and r['original_stored_path'] == stored]
        if len(candidates) != 1:
            raise ValueError('采购原件缺少明确的路径映射')
        relative = Path(candidates[0]['relative_path'])
        if not ops._allowed_snapshot_path(relative) or relative.parts[:2] != ('controlled-work', 'procurement-sources'):
            raise ValueError('采购原件映射超出受控目录')
        ops._validate_local_file(staging / relative, staging)
        if ops._sha256(staging / relative) != digest:
            raise ValueError('采购原件与数据库记录不一致')
        mappings[stored] = str(target / relative)
    for table, directory in (('knowledge_sources', 'sources'), ('knowledge_versions', 'items')):
        for stored, in source.execute(f'SELECT stored_name FROM {table}'):
            path = Path('knowledge') / directory / stored
            if not ops._allowed_snapshot_path(path):
                raise ValueError('知识文件引用超出受控目录')
            ops._validate_local_file(staging / path, staging)
    for stored, digest, size in source.execute('SELECT stored_name,sha256,size_bytes FROM knowledge_sources'):
        path = staging / 'knowledge/sources' / stored
        if path.stat().st_size != size or ops._sha256(path) != digest:
            raise ValueError('知识原件与数据库记录不一致')
    return mappings


def _target_check(db, settings: Settings, tables: dict) -> None:
    ops._database_header(db, settings.database_environment)
    if not db.execute("SELECT has_table_privilege(current_user,'honghao_meta.schema_migrations','INSERT')").fetchone()[0]:
        raise PermissionError('迁入须使用迁移账号')
    if not ops._empty_restore_target(db):
        raise ValueError('迁入仅允许空业务数据库；现有数据保持不变')
    target = ops._table_evidence(db)
    if target.keys() != tables.keys() or any(target[name]['columns'] != item['columns'] for name, item in tables.items()):
        raise ValueError('源与目标的表或字段不一致')


def _copy_rows(source: sqlite3.Connection, db, tables: dict, mappings: dict[str, str]) -> dict:
    graph = {table: set() for table in tables}
    for table, parent in db.execute("SELECT child.relname,parent.relname FROM pg_constraint c "
            "JOIN pg_class child ON child.oid=c.conrelid JOIN pg_class parent ON parent.oid=c.confrelid "
            "JOIN pg_namespace n ON n.oid=child.relnamespace WHERE c.contype='f' AND n.nspname='public'"):
        if table != parent:
            graph[table].add(parent)
    order = tuple(TopologicalSorter(graph).static_order())
    db.execute(sql.SQL('TRUNCATE {} RESTART IDENTITY').format(sql.SQL(',').join(sql.Identifier('public', name) for name in tables)))
    for table in order:
        columns = tables[table]['columns']
        command = sql.SQL('COPY public.{} ({}) FROM STDIN').format(sql.Identifier(table), sql.SQL(',').join(map(sql.Identifier, columns)))
        with db.cursor().copy(command) as copier:
            for row in source.execute(f'SELECT *,rowid FROM {_quote(table)} ORDER BY rowid'):
                if table == 'procurement_source_imports':
                    row = list(row)
                    index = columns.index('stored_path')
                    row[index] = mappings[row[index]]
                copier.write_row(row)
    # COPY checks native FKs (including self references) at statement end. No constraints are disabled.
    actual = ops._table_evidence(db, {new: old for old, new in mappings.items()})
    if actual != tables:
        raise ValueError('迁入后的内容、主键或行顺序不一致，事务已撤回')
    original_sequences = dict(source.execute('SELECT name,seq FROM sqlite_sequence')) if source.execute("SELECT 1 FROM sqlite_master WHERE name='sqlite_sequence'").fetchone() else {}
    sequences = {}
    for table, column, sequence in db.execute("SELECT table_name,column_name,pg_get_serial_sequence('public.'||quote_ident(table_name),column_name) "
            "FROM information_schema.columns WHERE table_schema='public' AND is_identity='YES' ORDER BY table_name,column_name").fetchall():
        highest = db.execute(sql.SQL('SELECT max({}) FROM public.{}').format(sql.Identifier(column), sql.Identifier(table))).fetchone()[0] or 0
        # SQLite AUTOINCREMENT high water can exceed the surviving maximum after deletions.
        next_value = max(highest, original_sequences.get(table, 0) if column != '_order' else 0, 0) + 1
        db.execute(sql.SQL('ALTER SEQUENCE {} RESTART WITH {}').format(sql.Identifier(*sequence.split('.')), sql.Literal(next_value)))
        sequences[f'{table}.{column}'] = next_value
    return sequences


def import_baseline(settings: Settings, baseline: Path, *, apply: bool = False) -> dict:
    ops._empty_restore_directory(settings)
    staging = ops._private_directory(settings.data_dir.parent, '.sqlite-import-')
    marker = settings.data_dir / ops.RESTORE_MARKER_NAME
    installed = []
    committed = False
    started = False
    try:
        record, files = _prepare(baseline, staging, settings.environment)
        with closing(sqlite3.connect((staging / 'honghao.db').as_uri() + '?mode=ro', uri=True)) as source:
            source.execute('BEGIN')
            tables = _source_evidence(source)
            if len(tables) != record['tables'] or sum(t['count'] for t in tables.values()) != record['rows']:
                raise ValueError('源数据库数量与冻结基线不一致')
            mappings = _source_paths(source, staging, settings.data_dir, record)
            with transaction(settings.database_url) as db:
                _target_check(db, settings, tables)
            result = {'applied': apply, 'tables': tables, 'rows': record['rows'],
                'source_sha256': ops._sha256(staging / 'honghao.db'), 'source_path_map': mappings,
                'files': [ops._file_record(staging / name, staging) for name in files],
                'database_environment': settings.database_environment, 'runtime_environment': settings.environment}
            if not apply:
                return result
            settings.ensure_directories()
            with ops._runtime_marker(settings, 'sqlite-import'), database_lease(settings.database_url):
                with transaction(settings.database_url, write=True) as db:
                    _target_check(db, settings, tables)
                    with marker.open('x', encoding='utf-8') as output:
                        output.write('迁入未完成；禁止启动，保留数据库与附件供核验。')
                    started = True
                    for name in files:
                        target = settings.data_dir / name
                        target.parent.mkdir(parents=True, exist_ok=True)
                        os.link(staging / name, target)
                        installed.append(target)
                    result['next_sequences'] = _copy_rows(source, db, tables, mappings)
                committed = True
                with transaction(settings.database_url) as db:
                    if ops._table_evidence(db, {new: old for old, new in mappings.items()}) != tables:
                        raise RuntimeError('提交后核验失败；保留现场，禁止启动')
                    ops._references(db, settings.data_dir)
                marker.unlink()
            return result
    except BaseException:
        safe = not committed
        if started and safe:
            try:
                with transaction(settings.database_url) as db:
                    safe = ops._empty_restore_target(db)
            except (psycopg.Error, RuntimeError, ValueError):
                safe = False
        if safe:
            for target in reversed(installed):
                ops._validate_local_file(target, settings.data_dir)
                target.unlink()
            if started:
                marker.unlink(missing_ok=True)
        raise
    finally:
        ops._remove_temporary(staging, settings.data_dir.parent)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', type=Path, required=True)
    parser.add_argument('--apply', action='store_true', help='默认仅核验；明确指定才迁入空库')
    args = parser.parse_args()
    try:
        result = import_baseline(Settings.from_environment(), args.baseline, apply=args.apply)
    except (ValueError, RuntimeError, OSError, sqlite3.Error, psycopg.Error):
        # A driver's error can include a full row or a credential. Keep CLI output data-free.
        parser.exit(1, '迁入未完成；检查冻结文件、版本、空目标和账号权限，保留现场后核验。\n')
    print(json.dumps({'applied': result['applied'], 'tables': len(result['tables']), 'rows': result['rows'],
        'files': len(result['files']), 'database_environment': result['database_environment']}, ensure_ascii=False))


if __name__ == '__main__':
    main()
