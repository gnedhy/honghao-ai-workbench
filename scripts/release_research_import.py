"""Prepare a pinned backup, then restore-check and atomically import the approved ERP batch.

Schema migration and service switching remain separate, explicitly authorized operations.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path

import psycopg
from psycopg.conninfo import conninfo_to_dict

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from api.identity import IdentityStore
from api.operations import (DATABASE_NAME, RESTORE_MARKER_NAME, _runtime_marker, _sha256,
                            _snapshot_sources, _table_evidence, create_snapshot,
                            restore_snapshot, verify_snapshot)
from api.postgres import database_lease, database_url, readiness, transaction
from api.research import ResearchStore, now, packed
from api.settings import Settings
from scripts.configure_research_accounts import configure
from scripts.import_research_candidate import _apply_candidate, read_json


def files(root: Path) -> dict[str, str]:
    if root.is_symlink() or root.is_junction():
        raise ValueError('导入输入不能包含链接')
    result = {}
    for path in sorted(root.rglob('*')):
        if path.is_symlink() or path.is_junction():
            raise ValueError('导入输入不能包含链接')
        if path.is_file() and '__pycache__' not in path.parts:
            result[path.relative_to(root).as_posix()] = _sha256(path)
    if not result:
        raise ValueError('导入输入为空')
    return result


def program_files() -> dict:
    return {**{name: files(ROOT / name) for name in ('api', 'scripts', 'dist')},
            **{name: _sha256(ROOT / name) for name in ('pyproject.toml', 'uv.lock', 'package-lock.json')}}


def target_identity(settings: Settings, active_path: Path, actor: str) -> dict:
    active = read_json(active_path)
    if (settings.environment != 'production' or settings.database_environment != 'production'
            or active.get('database_profile') != 'production'
            or Path(active['data_dir']).resolve() != settings.data_dir.resolve()
            or not Path(active['release_dir']).is_dir()):
        raise ValueError('正式服务配置、数据目录或数据库环境不匹配')
    if (settings.data_dir / RESTORE_MARKER_NAME).exists():
        raise ValueError('存在未完成恢复或导入标记，须先核对现场')
    if not all(value == 'ok' for value in readiness(settings.database_url, 'production').values()):
        raise ValueError('正式库身份、迁移版本或应用账号权限检查失败')
    user = IdentityStore(settings.database_url).get_user(actor)
    if not user or not user['is_active'] or not user['is_system_admin']:
        raise PermissionError('导入操作人必须是有效系统管理员')
    parameters = conninfo_to_dict(settings.database_url)
    with transaction(settings.database_url) as db:
        database, environment, role = db.execute(
            'SELECT current_database(),environment,current_user FROM honghao_meta.database_identity').fetchone()
    if (database != active.get('database_name', 'honghao_production')
            or role != active.get('database_app_role', 'honghao_production_app')):
        raise ValueError('连接的数据库或应用账号与正式配置不一致')
    return {'database': database, 'environment': environment, 'role': role,
            'host': parameters['host'], 'port': parameters.get('port', '5432'),
            'data_dir': str(settings.data_dir.resolve()), 'active_sha256': _sha256(active_path)}


def check_batch(db, digest: str) -> None:
    metadata = json.loads(db.execute('SELECT payload FROM research_meta WHERE id=1').fetchone()[0])
    if digest in metadata.get('erp_import_batches', {}) or metadata.get('erp_import', {}).get('inputs_sha256') == digest:
        raise ValueError('本批已导入，拒绝重复执行；请读取既有导入记录')
    if db.execute('SELECT 1 FROM research_drafts LIMIT 1').fetchone() or db.execute(
            "SELECT 1 FROM research_events WHERE status!='done' LIMIT 1").fetchone():
        raise ValueError('现有草稿或核算队列待处理，拒绝覆盖')


def check_baseline(db, settings: Settings, snapshot: Path, manifest: dict) -> None:
    if _table_evidence(db) != manifest['tables']:
        raise ValueError('正式数据已变更，须重新备份并审阅导入计划')
    expected = {row['path']: row['sha256'] for row in manifest['files'] if row['path'] != DATABASE_NAME}
    actual = {str(path.relative_to(settings.data_dir).as_posix()): _sha256(path)
              for path in _snapshot_sources(settings)}
    if actual != expected:
        raise ValueError('数据附件或运行配置已变更，须重新备份')


def prepare(settings: Settings, active_path: Path, candidate: Path, digest: str,
            actor: str, destination: Path) -> dict:
    identity = target_identity(settings, active_path, actor)
    if _sha256(candidate / '成本试算输入.json') != digest:
        raise ValueError('候选计算输入哈希不匹配')
    candidate_hashes = files(candidate)
    program = program_files()
    with _runtime_marker(settings, 'erp-import'), database_lease(settings.database_url):
        with transaction(settings.database_url) as db:
            check_batch(db, digest)
        accounts = configure(settings.database_url, actor)
        snapshot = create_snapshot(settings, destination)
    return {'version': 1, 'created_at': now(), 'target': identity, 'actor': actor,
            'candidate': str(candidate.resolve()), 'input_sha256': digest,
            'candidate_files': candidate_hashes, 'program_files': program,
            'active_path': str(active_path.resolve()), 'snapshot': str(snapshot),
            'snapshot_sha256': _sha256(snapshot / 'manifest.json'), 'account_plan': accounts}


def apply(settings: Settings, plan_path: Path, plan_sha256: str,
          restore_settings: Settings) -> dict:
    if _sha256(plan_path) != plan_sha256:
        raise ValueError('导入计划哈希不匹配')
    plan = read_json(plan_path)
    if plan.get('version') != 1:
        raise ValueError('导入计划版本无效')
    active_path, candidate, snapshot = map(Path, (plan['active_path'], plan['candidate'], plan['snapshot']))
    if target_identity(settings, active_path, plan['actor']) != plan['target']:
        raise ValueError('正式服务身份与已审阅计划不一致')
    if files(candidate) != plan['candidate_files'] or program_files() != plan['program_files']:
        raise ValueError('候选文件或程序发生变化，须重新验收')
    if _sha256(snapshot / 'manifest.json') != plan['snapshot_sha256']:
        raise ValueError('备份清单哈希不匹配')
    manifest = verify_snapshot(snapshot, expected_environment='production', expected_database_environment='production')
    source = conninfo_to_dict(settings.database_url)
    restore = conninfo_to_dict(restore_settings.database_url)
    if (not restore['dbname'].startswith('honghao_acceptance_erp_release_')
            or restore['dbname'] == source['dbname']
            or restore_settings.data_dir.resolve() == settings.data_dir.resolve()
            or settings.data_dir.resolve() in restore_settings.data_dir.resolve().parents
            or restore_settings.data_dir.resolve() in settings.data_dir.resolve().parents
            or restore_settings.environment != 'production' or restore_settings.database_environment != 'production'):
        raise ValueError('恢复演练必须使用独立空库及独立目录')
    with _runtime_marker(settings, 'erp-import'), database_lease(settings.database_url):
        with transaction(settings.database_url) as db:
            check_batch(db, plan['input_sha256'])
            check_baseline(db, settings, snapshot, manifest)
        # A real native restore, including table fingerprints and attachment relocation, precedes any target write.
        restore_snapshot(restore_settings, snapshot)
        marker = settings.data_dir / RESTORE_MARKER_NAME
        with marker.open('x', encoding='utf-8') as output:
            output.write('ERP 导入未完成；禁止启动。计划 SHA256=' + plan_sha256)
        archive = settings.controlled_work_dir / 'procurement-sources'
        originals = {path: _sha256(path) for path in archive.glob('*') if path.is_file()}
        committed = False
        try:
            with transaction(settings.database_url, write=True) as db:
                check_batch(db, plan['input_sha256'])
                check_baseline(db, settings, snapshot, manifest)
                receipt = _apply_candidate(db, candidate, settings.data_dir, plan['input_sha256'],
                                           plan['actor'], reason='ERP统一导入')
                ResearchStore(settings.database_url).process_events()
                accounts = configure(settings.database_url, plan['actor'], True)
                if accounts != plan['account_plan']:
                    raise ValueError('账号配置与已审阅计划不一致')
                if (files(candidate) != plan['candidate_files'] or program_files() != plan['program_files']
                        or _sha256(active_path) != plan['target']['active_sha256']):
                    raise ValueError('执行期间候选、程序或正式配置发生变化，已回滚')
                receipt.update(plan_sha256=plan_sha256, actor=plan['actor'], target=plan['target'],
                               backup=str(snapshot), backup_sha256=plan['snapshot_sha256'],
                               restored_tables=len(manifest['tables']), account_plan=accounts, imported_at=now())
                metadata = json.loads(db.execute('SELECT payload FROM research_meta WHERE id=1').fetchone()[0])
                metadata.setdefault('erp_import_batches', {})[plan['input_sha256']] = {
                    key: value for key, value in receipt.items() if key not in {'formulas', 'inventory'}}
                db.execute('UPDATE research_meta SET payload=%s WHERE id=1', (packed(metadata),))
            committed = True
            marker.unlink()
            return receipt
        except BaseException:
            if not committed:
                # Remove only this attempt's hash-named originals after proving the DB transaction rolled back.
                with transaction(settings.database_url) as db:
                    if _table_evidence(db) != manifest['tables']:
                        raise RuntimeError('回滚内容未通过核对，保留禁止启动标记') from None
                for path in archive.glob('*'):
                    if path not in originals:
                        if path.is_symlink() or not path.is_file() or _sha256(path) != path.stem:
                            raise RuntimeError('来源归档状态异常，保留禁止启动标记') from None
                        path.unlink()
                if any(not path.is_file() or _sha256(path) != digest for path, digest in originals.items()):
                    raise RuntimeError('原归档发生变化，保留禁止启动标记') from None
                marker.unlink()
            raise


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    prepare_parser = commands.add_parser('prepare')
    prepare_parser.add_argument('--active', required=True, type=Path)
    prepare_parser.add_argument('--candidate', required=True, type=Path)
    prepare_parser.add_argument('--input-sha256', required=True)
    prepare_parser.add_argument('--actor', required=True)
    prepare_parser.add_argument('--backup-destination', required=True, type=Path)
    prepare_parser.add_argument('--plan', required=True, type=Path)
    apply_parser = commands.add_parser('apply')
    apply_parser.add_argument('--plan', required=True, type=Path)
    apply_parser.add_argument('--plan-sha256', required=True)
    apply_parser.add_argument('--restore-data-dir', required=True, type=Path)
    apply_parser.add_argument('--receipt', required=True, type=Path)
    apply_parser.add_argument('--confirm', required=True, choices=('IMPORT',))
    args = parser.parse_args(argv)
    try:
        output = args.plan if args.command == 'prepare' else args.receipt
        # Reserve the result path before doing work; an existing result is never overwritten.
        with output.open('x', encoding='utf-8') as stream:
            settings = Settings.from_environment()
            if args.command == 'prepare':
                result = prepare(settings, args.active, args.candidate, args.input_sha256, args.actor, args.backup_destination)
            else:
                restore = Settings.from_data_dir(args.restore_data_dir, environment='production', database_environment='production',
                    database_url=database_url(os.environ.get('HONGHAO_IMPORT_RESTORE_URL', '')))
                result = apply(settings, args.plan, args.plan_sha256, restore)
            json.dump(result, stream, ensure_ascii=False, indent=2)
        print(json.dumps({'result': str(output), 'sha256': _sha256(output)}, ensure_ascii=False))
        return 0
    except (psycopg.Error, OSError, ValueError, RuntimeError, PermissionError, KeyError):
        print('导入未完成；请核对目标身份、计划、备份、恢复空库及禁止启动标记。连接凭据未输出。')
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
