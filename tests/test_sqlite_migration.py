"""Synthetic legacy files against the real PostgreSQL constraints; no business fixture data."""
import json
import sqlite3

import psycopg
import pytest

from api import operations as ops, postgres
from api.settings import Settings
from scripts import migrate_sqlite_to_postgres as migration


@pytest.fixture
def legacy(tmp_path, pg_targets):
    root = tmp_path / 'frozen'
    snapshot = root / 'snapshot'
    snapshot.mkdir(parents=True)
    path = snapshot / 'honghao.db'
    with sqlite3.connect(path) as source, postgres.transaction(pg_targets[0]) as target:
        for table in ops._table_names(target):
            columns = target.execute("SELECT column_name,data_type FROM information_schema.columns WHERE table_schema='public' AND table_name=%s AND column_name!='_order' ORDER BY ordinal_position", (table,)).fetchall()
            declarations = [migration._quote(name) + (' INTEGER PRIMARY KEY AUTOINCREMENT' if table == 'research_cost_records' and name == 'sequence' else ' ' + ('INTEGER' if kind in {'integer','bigint'} else 'BLOB' if kind == 'bytea' else 'TEXT')) for name, kind in columns]
            source.execute(f'CREATE TABLE {migration._quote(table)} ({",".join(declarations)})')
            names = ','.join(migration._quote(name) for name, _ in columns)
            rows = target.execute(f'SELECT {names},_order FROM public.{migration._quote(table)} ORDER BY _order').fetchall()
            source.executemany(f'INSERT INTO {migration._quote(table)} ({names},rowid) VALUES ({",".join("?" for _ in range(len(columns)+1))})', rows)
        source.execute("INSERT INTO identity_users(id,username,display_name,password_salt,password_hash,is_active,created_at,access_level,rowid) VALUES(?,?,?,?,?,1,'2026-09-14T01:02:03+00:00',1,19)", ('u1', 'MixedCase', '长姓名·测试', b'\x00\x01\xff', b'\x00secret-hash\xfe'))
        source.execute("INSERT INTO identity_user_roles VALUES('u1','employee')")
        source.execute("INSERT INTO identity_user_scopes VALUES('u1','workbench-research',3)")
        source.execute("INSERT INTO organization_departments VALUES('child','子部门','parent')")
        source.execute("INSERT INTO organization_departments VALUES('parent','根部门',NULL)")
        source.execute("INSERT INTO procurement_materials(id,code,name,unit,latest_price,inventory_price,updated_at) VALUES('m','M1','测试','kg','0.00000000000000100','0','2026-09-14')")
        source.execute("INSERT INTO research_cost_records VALUES(31,'event','product','signature','{\"price\":\"0.00000\"}')")
        source.execute("UPDATE sqlite_sequence SET seq=80 WHERE name='research_cost_records'")
    (snapshot / 'environment').write_text('test')
    (snapshot / 'release.json').write_text('{"version":"fixture"}')
    file = snapshot / 'controlled-work/procurement-sources/original.xlsx'
    file.parent.mkdir(parents=True)
    file.write_bytes(b'synthetic original file')
    digest = ops._sha256(file)
    pdf = snapshot / 'knowledge/sources/source.pdf'
    pdf.parent.mkdir(parents=True)
    pdf.write_bytes(b'%PDF synthetic original')
    markdown = snapshot / 'knowledge/items/version.md'
    markdown.parent.mkdir(parents=True)
    markdown.write_text('# Synthetic knowledge', encoding='utf-8')
    with sqlite3.connect(path) as source:
        source.execute("INSERT INTO procurement_source_imports VALUES(?,?,?,?,?)", (digest, 'original.xlsx', 'C:/old-host/original.xlsx', 'u1', '2026-09-14'))
        source.execute("INSERT INTO knowledge_sources(id,filename,mime_type,size_bytes,sha256,stored_name,legacy_storage_status,created_by_user_id,created_at) VALUES('source','source.pdf','application/pdf',?,?,'source.pdf','quarantined','u1','now')", (pdf.stat().st_size, ops._sha256(pdf)))
        source.execute("INSERT INTO knowledge_versions VALUES('version','source','version.md','draft','u1','now')")
        source.execute("INSERT INTO knowledge_version_sources VALUES('version','source')")
        source.execute("INSERT INTO feedback(id,owner_id,owner_name,kind,text,context,version,created_at,status,result,revision,result_revision,image,image_mime) VALUES('feedback','u1','测试','问题','synthetic','{}','test','now','待处理','',1,0,?,'image/png')", (b'\x89PNG\x00\xff',))
        # Native defaults are reflected here because the synthetic SQLite fixture has no defaults.
        source.execute("UPDATE knowledge_sources SET processing_status='not_started',safety_status='quarantined',read_min_level=4,read_scope_ids='[]'")
    baseline = root / 'baseline.json'

    def refresh():
        with sqlite3.connect(path) as source:
            tables = [r[0] for r in source.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
            rows = sum(source.execute(f'SELECT count(*) FROM {migration._quote(t)}').fetchone()[0] for t in tables)
        baseline.write_text(json.dumps({'snapshot': str(snapshot), 'tables': len(tables), 'rows': rows,
            'source_files': [{'sha256': digest, 'original_stored_path': 'C:/old-host/original.xlsx', 'relative_path': 'controlled-work/procurement-sources/original.xlsx'}],
            'files': {p.relative_to(root).as_posix(): {'size': p.stat().st_size, 'sha256': ops._sha256(p)} for p in snapshot.rglob('*') if p.is_file()}}), encoding='utf-8')
    refresh()
    settings = Settings.from_data_dir(tmp_path / 'target', database_url=pg_targets[1], database_environment='test')
    return baseline, path, settings, refresh


def test_complete_import_preserves_order_bytes_precision_paths_sequences_and_constraints(legacy, pg_targets):
    baseline, path, settings, _ = legacy
    before = ops._sha256(path)
    result = migration.import_baseline(settings, baseline, apply=True)
    assert len(result['tables']) == 58
    assert ops._sha256(path) == before
    with postgres.transaction(pg_targets[0]) as db:
        assert db.execute('SELECT password_salt,password_hash,_order FROM identity_users').fetchone() == (b'\x00\x01\xff', b'\x00secret-hash\xfe', 19)
        assert db.execute('SELECT latest_price,inventory_price FROM procurement_materials').fetchone() == ('0.00000000000000100','0')
        assert db.execute("SELECT stored_path FROM procurement_source_imports").fetchone()[0] == str(settings.data_dir / 'controlled-work/procurement-sources/original.xlsx')
        assert db.execute('SELECT id FROM organization_departments ORDER BY _order').fetchall() == [('child',),('parent',)]
        assert db.execute('SELECT image FROM feedback').fetchone() == (b'\x89PNG\x00\xff',)
    with postgres.transaction(pg_targets[0], write=True) as db:
        assert db.execute("INSERT INTO research_cost_records(event_id,product_id,signature,payload) VALUES('next','p','s','{}') RETURNING sequence,_order").fetchone() == (81,32)
        assert db.execute("INSERT INTO identity_users(id,username,display_name,password_salt,password_hash,is_active,created_at) VALUES('u2','next','next',%s,%s,1,'now') RETURNING _order", (b'x',b'y')).fetchone() == (20,)
    with pytest.raises(psycopg.errors.UniqueViolation), postgres.transaction(pg_targets[0], write=True) as db:
        db.execute("INSERT INTO identity_users(id,username,display_name,password_salt,password_hash,is_active,created_at) VALUES('u3','MIXEDCASE','case',%s,%s,1,'now')", (b'x',b'y'))
    assert (settings.data_dir / 'release.json').read_text() == '{"version":"fixture"}'
    assert (settings.data_dir / 'knowledge/sources/source.pdf').read_bytes() == b'%PDF synthetic original'
    assert (settings.data_dir / 'knowledge/items/version.md').read_text() == '# Synthetic knowledge'
    assert not (settings.data_dir / ops.RESTORE_MARKER_NAME).exists()


def test_dry_run_does_not_write_database_or_target_directory(legacy):
    baseline, _, settings, _ = legacy
    result = migration.import_baseline(settings, baseline)
    assert not result['applied'] and not settings.data_dir.exists()
    with postgres.transaction(settings.database_url) as db:
        assert ops._empty_restore_target(db)


@pytest.mark.parametrize('damage', ['hash', 'missing-file', 'outside-path', 'missing-map', 'version', 'extra-table', 'extra-column', 'environment', 'knowledge-hash', 'missing-knowledge'])
def test_reject_bad_baseline_before_writes(legacy, damage):
    baseline, path, settings, refresh = legacy
    record = json.loads(baseline.read_text())
    if damage == 'hash':
        record['files']['snapshot/honghao.db']['sha256'] = '0' * 64
    elif damage == 'missing-file':
        (path.parent / 'controlled-work/procurement-sources/original.xlsx').unlink()
    elif damage == 'outside-path':
        record['source_files'][0]['relative_path'] = '../original.xlsx'
    elif damage == 'missing-map':
        record['source_files'] = []
    elif damage == 'environment':
        (path.parent / 'environment').write_text('production')
        refresh()
        record = json.loads(baseline.read_text())
    elif damage in {'knowledge-hash', 'missing-knowledge'}:
        if damage == 'missing-knowledge':
            (path.parent / 'knowledge/items/version.md').unlink()
        else:
            with sqlite3.connect(path) as source:
                source.execute("UPDATE knowledge_sources SET sha256='incorrect'")
        refresh()
        record = json.loads(baseline.read_text())
    else:
        with sqlite3.connect(path) as source:
            source.execute({'version': 'UPDATE schema_metadata SET value=999', 'extra-table': 'CREATE TABLE unsupported(id TEXT)', 'extra-column': 'ALTER TABLE projects ADD COLUMN unsupported TEXT'}[damage])
        refresh()
        record = json.loads(baseline.read_text())
    baseline.write_text(json.dumps(record))
    with pytest.raises(ValueError):
        migration.import_baseline(settings, baseline, apply=True)
    with postgres.transaction(settings.database_url) as db:
        assert ops._empty_restore_target(db)
    assert not settings.data_dir.exists()


def test_existing_data_and_application_account_rejected(legacy, pg_targets):
    baseline, _, settings, _ = legacy
    from dataclasses import replace
    with pytest.raises(PermissionError):
        migration.import_baseline(replace(settings, database_url=pg_targets[0]), baseline, apply=True)
    with postgres.transaction(settings.database_url, write=True) as db:
        db.execute("INSERT INTO projects(id,title) VALUES('existing','keep')")
    with pytest.raises(ValueError, match='空业务数据库'):
        migration.import_baseline(settings, baseline, apply=True)
    with postgres.transaction(settings.database_url) as db:
        assert db.execute('SELECT title FROM projects').fetchall() == [('keep',)]


def test_live_service_and_nonempty_directory_rejected(legacy):
    baseline, _, settings, _ = legacy
    with postgres.database_lease(settings.database_url), pytest.raises(RuntimeError, match='已有服务'):
        migration.import_baseline(settings, baseline, apply=True)
    file = settings.data_dir / 'keep.txt'
    file.write_text('keep')
    with pytest.raises(ValueError, match='空数据目录'):
        migration.import_baseline(settings, baseline, apply=True)
    assert file.read_text() == 'keep'


def test_native_fk_failure_rolls_back_all_rows_and_copied_files(legacy):
    baseline, path, settings, refresh = legacy
    with sqlite3.connect(path) as source:
        source.execute("UPDATE identity_user_roles SET user_id='missing'")
    refresh()
    with pytest.raises(psycopg.errors.ForeignKeyViolation):
        migration.import_baseline(settings, baseline, apply=True)
    with postgres.transaction(settings.database_url) as db:
        assert ops._empty_restore_target(db)
    assert not (settings.data_dir / ops.RESTORE_MARKER_NAME).exists()
    assert not list(settings.data_dir.rglob('*.xlsx'))


def test_post_commit_verification_failure_keeps_marker_and_files(legacy, monkeypatch):
    baseline, _, settings, _ = legacy
    monkeypatch.setattr(ops, '_references', lambda *_: (_ for _ in ()).throw(ValueError('post-commit check')))
    with pytest.raises(ValueError, match='post-commit'):
        migration.import_baseline(settings, baseline, apply=True)
    assert (settings.data_dir / ops.RESTORE_MARKER_NAME).exists()
    assert list(settings.data_dir.rglob('*.xlsx'))
    with pytest.raises(RuntimeError, match='未完成'), ops.service_marker(settings):
        pass


def test_repeated_import_preserves_successful_target(legacy):
    baseline, _, settings, _ = legacy
    migration.import_baseline(settings, baseline, apply=True)
    with postgres.transaction(settings.database_url) as db:
        before = ops._table_evidence(db)
    with pytest.raises(ValueError, match='空数据目录'):
        migration.import_baseline(settings, baseline, apply=True)
    with postgres.transaction(settings.database_url) as db:
        assert ops._table_evidence(db) == before


def test_attachment_failure_rolls_back_and_does_not_overwrite_competing_file(legacy, monkeypatch):
    baseline, _, settings, _ = legacy
    original = migration.os.link
    calls = []
    def competing_file(source, target):
        calls.append(target)
        if len(calls) == 2:
            target.write_text('created concurrently')
        original(source, target)
    monkeypatch.setattr(migration.os, 'link', competing_file)
    with pytest.raises(FileExistsError):
        migration.import_baseline(settings, baseline, apply=True)
    assert calls[1].read_text() == 'created concurrently'
    assert not calls[0].exists()
    with postgres.transaction(settings.database_url) as db:
        assert ops._empty_restore_target(db)


def test_lost_database_lease_prevents_import_commit(legacy, monkeypatch):
    baseline, _, settings, _ = legacy
    copy_rows = migration._copy_rows
    def lose_lease(*args):
        result = copy_rows(*args)
        postgres._LEASES[settings.database_url].close()
        return result
    monkeypatch.setattr(migration, '_copy_rows', lose_lease)
    with pytest.raises(psycopg.OperationalError):
        migration.import_baseline(settings, baseline, apply=True)
    with postgres.transaction(settings.database_url) as db:
        assert ops._empty_restore_target(db)
    assert not (settings.data_dir / ops.RESTORE_MARKER_NAME).exists()
    assert not list(settings.data_dir.rglob('*.xlsx'))
