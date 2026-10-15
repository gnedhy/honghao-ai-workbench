"""Real PostgreSQL release guards and transaction rollback; no formal database is used."""
import hashlib
import json
import os
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4

import pytest
from psycopg import sql

from api.identity import IdentityStore
from api.operations import RESTORE_MARKER_NAME, _sha256, _table_evidence
from api.postgres import connect, database_lease, migrate, transaction
from api.settings import Settings
from scripts import release_research_import as release
from scripts.import_research_candidate import apply_candidate
from tests.conftest import _grant_app


@pytest.fixture
def release_case(tmp_path, pg_targets, monkeypatch):
    app, migration = pg_targets
    names = ['honghao_acceptance_erp_release_' + uuid4().hex for _ in range(2)]
    def target(url, name):
        return urlunsplit(urlsplit(url)._replace(path='/' + name))
    with connect(os.environ['HONGHAO_TEST_CLUSTER_URL']) as db:
        for name in names:
            db.execute(sql.SQL("CREATE DATABASE {} OWNER honghao_test_migration TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'").format(sql.Identifier(name)))
            db.execute(sql.SQL('REVOKE ALL ON DATABASE {} FROM PUBLIC').format(sql.Identifier(name)))
            db.execute(sql.SQL('GRANT CONNECT ON DATABASE {} TO honghao_test_app').format(sql.Identifier(name)))
    try:
        for name in names:
            migrate(target(migration, name), 'production')
            with transaction(target(migration, name), write=True) as db:
                _grant_app(db)
        settings = Settings.from_data_dir(tmp_path / 'source', environment='production',
            database_environment='production', database_url=target(app, names[0]))
        settings.ensure_directories()
        restore = Settings.from_data_dir(tmp_path / 'restore', environment='production',
            database_environment='production', database_url=target(migration, names[1]))
        admin = IdentityStore(settings.database_url).create_user(username='release-admin', display_name='发布管理员',
            department=None, password='Release-Test-Password', is_system_admin=True)['id']
        with transaction(settings.database_url, write=True) as db:
            db.execute("INSERT INTO research_meta(id,payload) VALUES(1,'{}')")
        active = tmp_path / 'active.json'
        active.write_text(json.dumps({'release_dir': str(tmp_path), 'data_dir': str(settings.data_dir),
            'database_profile': 'production', 'database_name': names[0], 'database_app_role': 'honghao_test_app'}), encoding='utf-8')
        candidate = tmp_path / 'candidate'
        candidate.mkdir()
        (candidate / '成本试算输入.json').write_text('{}', encoding='utf-8')
        digest = _sha256(candidate / '成本试算输入.json')
        monkeypatch.setattr(release, 'program_files', lambda: {'test-program': 'pinned'})
        monkeypatch.setattr(release, 'configure', lambda *args: [])
        def importer(db, path, data_dir, expected, actor, **kwargs):
            content = b'new immutable ERP original'
            archive = data_dir / 'controlled-work/procurement-sources'
            archive.mkdir(parents=True, exist_ok=True)
            (archive / (hashlib.sha256(content).hexdigest() + '.xlsx')).write_bytes(content)
            db.execute('UPDATE identity_users SET display_name=%s WHERE id=%s', ('导入修改', actor))
            db.execute('UPDATE research_meta SET payload=%s WHERE id=1', (json.dumps({'erp_import': {'inputs_sha256': expected}}),))
            return {'candidate': path.name, 'input_sha256': expected, 'dual_cost_checks': 0}
        monkeypatch.setattr(release, '_apply_candidate', importer)
        plan = release.prepare(settings, active, candidate, digest, admin, tmp_path / 'backups')
        plan_path = tmp_path / 'plan.json'
        plan_path.write_text(json.dumps(plan), encoding='utf-8')
        yield settings, restore, plan_path, plan, _sha256(plan_path)
    finally:
        with connect(os.environ['HONGHAO_TEST_CLUSTER_URL']) as db:
            for name in names:
                # Let PostgreSQL finish disconnecting app sessions without granting signal privileges.
                db.execute(sql.SQL('DROP DATABASE {}').format(sql.Identifier(name)))


def test_guarded_release_restores_before_commit_and_rejects_duplicate(release_case):
    settings, restore, path, plan, digest = release_case
    receipt = release.apply(settings, path, digest, restore)
    assert receipt['restored_tables'] == len(json.loads((Path(plan['snapshot']) / 'manifest.json').read_text())['tables'])
    assert not (settings.data_dir / RESTORE_MARKER_NAME).exists()
    with transaction(restore.database_url) as db:
        assert db.execute('SELECT display_name FROM identity_users WHERE id=%s', (plan['actor'],)).fetchone() == ('发布管理员',)
    with transaction(settings.database_url) as db:
        assert db.execute('SELECT display_name FROM identity_users WHERE id=%s', (plan['actor'],)).fetchone() == ('导入修改',)
        assert json.loads(db.execute('SELECT payload FROM research_meta').fetchone()[0])['erp_import_batches'][plan['input_sha256']]['plan_sha256'] == digest
        before = _table_evidence(db)
    with pytest.raises(ValueError, match='本批已导入'):
        release.apply(settings, path, digest, restore)
    with transaction(settings.database_url) as db:
        assert _table_evidence(db) == before


def test_guarded_release_account_failure_rolls_back_database_and_new_files(release_case, monkeypatch):
    settings, restore, path, plan, digest = release_case
    def fail(url, actor, apply=False):
        assert apply
        with transaction(url, write=True) as db:
            db.execute('UPDATE identity_users SET is_active=0 WHERE id=%s', (actor,))
        raise ValueError('模拟账号配置失败')
    monkeypatch.setattr(release, 'configure', fail)
    with pytest.raises(ValueError, match='模拟账号配置失败'):
        release.apply(settings, path, digest, restore)
    expected = json.loads((Path(plan['snapshot']) / 'manifest.json').read_text())['tables']
    with transaction(settings.database_url) as db:
        assert _table_evidence(db) == expected
    assert list((settings.controlled_work_dir / 'procurement-sources').glob('*')) == []
    assert not (settings.data_dir / RESTORE_MARKER_NAME).exists()


@pytest.mark.parametrize('change, message', [
    ('plan', '计划哈希'), ('candidate', '候选文件'), ('program', '候选文件'),
    ('active', '身份与'), ('backup', '备份清单'), ('baseline', '正式数据已变更'),
    ('attachment', '数据附件'), ('restore', '独立空库'),
])
def test_guarded_release_rejects_drift_before_any_target_write(release_case, monkeypatch, change, message):
    settings, restore, path, plan, digest = release_case
    if change == 'plan': path.write_text(path.read_text() + ' ')
    elif change == 'candidate': (Path(plan['candidate']) / '成本试算输入.json').write_text('{"changed":true}')
    elif change == 'program': monkeypatch.setattr(release, 'program_files', lambda: {'changed': True})
    elif change == 'active': Path(plan['active_path']).write_text(Path(plan['active_path']).read_text() + ' ')
    elif change == 'backup': (Path(plan['snapshot']) / 'manifest.json').write_text('{}')
    elif change == 'baseline':
        with transaction(settings.database_url, write=True) as db:
            db.execute('UPDATE identity_users SET display_name=%s WHERE id=%s', ('另行修改', plan['actor']))
    elif change == 'attachment': (settings.data_dir / 'environment').write_text('production\n')
    elif change == 'restore': restore = settings
    with transaction(settings.database_url) as db:
        before = _table_evidence(db)
    with pytest.raises(ValueError, match=message):
        release.apply(settings, path, digest, restore)
    with transaction(settings.database_url) as db:
        assert _table_evidence(db) == before
    assert not (settings.data_dir / RESTORE_MARKER_NAME).exists()


def test_guarded_release_blocks_live_service_invalid_actor_and_old_import_entry(release_case):
    settings, restore, path, plan, digest = release_case
    with database_lease(settings.database_url):
        with pytest.raises(RuntimeError, match='当前数据库已有'):
            release.apply(settings, path, digest, restore)
    with pytest.raises(PermissionError, match='系统管理员'):
        release.target_identity(settings, Path(plan['active_path']), 'unknown-user')
    with pytest.raises(ValueError, match='仅允许本轮独立验收库'):
        apply_candidate(settings.database_url, Path(plan['candidate']), settings.data_dir, plan['input_sha256'])


def test_guarded_release_remembers_an_older_batch_after_a_later_import(release_case):
    settings, _, _, plan, _ = release_case
    with transaction(settings.database_url, write=True) as db:
        db.execute('UPDATE research_meta SET payload=%s WHERE id=1', (json.dumps({
            'erp_import': {'inputs_sha256': 'newer-batch'}, 'erp_import_batches': {plan['input_sha256']: {}}}),))
    with transaction(settings.database_url) as db:
        with pytest.raises(ValueError, match='本批已导入'):
            release.check_batch(db, plan['input_sha256'])


def test_guarded_release_restore_failure_prevents_any_import(release_case, monkeypatch):
    settings, restore, path, plan, digest = release_case
    def fail(*args):
        raise RuntimeError('恢复演练失败')
    monkeypatch.setattr(release, 'restore_snapshot', fail)
    with pytest.raises(RuntimeError, match='恢复演练失败'):
        release.apply(settings, path, digest, restore)
    with transaction(settings.database_url) as db:
        assert _table_evidence(db) == json.loads((Path(plan['snapshot']) / 'manifest.json').read_text())['tables']
    assert not list(settings.controlled_work_dir.rglob('*.xlsx'))


def test_guarded_release_input_change_during_import_rolls_back(release_case, monkeypatch):
    settings, restore, path, plan, digest = release_case
    def change(*args):
        (Path(plan['candidate']) / '成本试算输入.json').write_text('{"changed":true}')
        return []
    monkeypatch.setattr(release, 'configure', change)
    with pytest.raises(ValueError, match='执行期间'):
        release.apply(settings, path, digest, restore)
    with transaction(settings.database_url) as db:
        assert _table_evidence(db) == json.loads((Path(plan['snapshot']) / 'manifest.json').read_text())['tables']
    assert not list(settings.controlled_work_dir.rglob('*.xlsx'))


def test_guarded_import_rejects_wrong_candidate_cardinality(tmp_path):
    import sqlite3
    from scripts.import_research_candidate import _apply_candidate
    (tmp_path / '成本试算输入.json').write_text('{"prices":{}}')
    (tmp_path / '拟导入范围.json').write_text('{"ERP_product_codes":[]}')
    (tmp_path / '业务确认-20261007.json').write_text('{}')
    with sqlite3.connect(tmp_path / '研发数据分析.db') as db:
        db.executescript('CREATE TABLE sources(kind,filename,sha256,sheet);'
            'CREATE TABLE material_candidates(code,unit,quantity,erp_inventory_price,evidence_json);'
            'CREATE TABLE trial_costs(product,policy,cost);')
    with pytest.raises(ValueError, match='2371个ERP产品'):
        _apply_candidate(None, tmp_path, tmp_path / 'unused', _sha256(tmp_path / '成本试算输入.json'), 'actor', reason='核对')
    assert not (tmp_path / 'unused').exists()
