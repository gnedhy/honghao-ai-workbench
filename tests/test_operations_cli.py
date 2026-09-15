import hashlib
import json
import os
from dataclasses import replace
from pathlib import Path

from api.cli import main
from api.identity import IdentityStore
from api.postgres import transaction, readiness
from api.operations import DATABASE_NAME, RESTORE_MARKER_NAME, _table_evidence
from api.main import create_app
from api.settings import Settings
from fastapi.testclient import TestClient


def _ready_data(settings: Settings) -> None:
    migration_settings = replace(settings, database_url=os.environ["HONGHAO_TEST_MIGRATION_URL"])
    assert main(["migrate"], settings=migration_settings) == 0
    (settings.data_dir / "runtime-config.json").write_text(
        json.dumps(
            {
                "version": 1,
                "environment": "test",
                "module_modes": {
                    "chat": "off",
                    "knowledge": "off",
                    "automation": "off",
                    "workbench": "active",
                    "tasks": "off",
                },
                "reviewed_active_modules": [],
            }
        ),
        encoding="utf-8",
    )
    (settings.data_dir / "workbench-runtime-config.json").write_text(
        json.dumps(
            {
                "version": 1,
                "environment": "test",
                "workbench_modes": {
                    "management": "prototype",
                    "procurement": "prototype",
                    "research": "prototype",
                    "sales": "prototype",
                },
                "activation_reviews": {},
            }
        ),
        encoding="utf-8",
    )
    sources = settings.data_dir / "knowledge" / "sources"
    items = settings.data_dir / "knowledge" / "items"
    sources.mkdir(parents=True, exist_ok=True)
    items.mkdir(parents=True, exist_ok=True)
    (sources / "产品说明书.pdf").write_bytes(b"%PDF-1.4\nbackup")
    (items / "产品说明书.md").write_text("# 产品说明书", encoding="utf-8")
    user = IdentityStore(settings.database_url).create_user(username='snapshot-user', display_name='快照用户',
        department=None, password='Snapshot-Password-2026', is_system_admin=True)
    with transaction(settings.database_url, write=True) as db:
        db.execute("INSERT INTO knowledge_sources(id,filename,mime_type,size_bytes,sha256,stored_name,created_by_user_id,created_at,legacy_storage_status) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            ('source-1','产品说明书.pdf','application/pdf',len((sources/'产品说明书.pdf').read_bytes()),'fixture-source','产品说明书.pdf',user['id'],'2026-08-30T00:00:00+00:00','quarantined'))
        db.execute("INSERT INTO knowledge_versions(id,source_id,stored_name,status,created_by_user_id,created_at) VALUES(%s,%s,%s,%s,%s,%s)",
            ('version-1','source-1','产品说明书.md','draft',user['id'],'2026-08-30T00:00:00+00:00'))
        source_dir = settings.controlled_work_dir / 'procurement-sources'
        source_dir.mkdir(parents=True, exist_ok=True)
        content = b'PK fixture-original-procurement-workbook'
        digest = hashlib.sha256(content).hexdigest()
        source = source_dir / (digest + '.xlsx')
        source.write_bytes(content)
        db.execute('INSERT INTO procurement_source_imports(sha256,filename,stored_path,imported_by,imported_at) VALUES(%s,%s,%s,%s,%s)',
            (digest,'采购原件.xlsx',str(source),user['id'],'2026-08-30T00:00:00+00:00'))


def _create_snapshot(settings: Settings, destination: Path, capsys) -> Path:
    assert main(["backup", "--destination", str(destination)], settings=settings) == 0
    return Path(capsys.readouterr().out.strip().splitlines()[-1])


def test_backup_and_verify_restore_support_chinese_paths(tmp_path: Path, capsys) -> None:
    settings = Settings.from_data_dir(tmp_path / "中台数据")
    _ready_data(settings)
    destination = tmp_path / "中文快照"

    snapshot = _create_snapshot(settings, destination, capsys)
    assert snapshot.parent == destination
    assert (snapshot / DATABASE_NAME).is_file()
    assert (snapshot / "workbench-runtime-config.json").is_file()
    assert (snapshot / "knowledge" / "sources" / "产品说明书.pdf").is_file()
    assert (snapshot / "knowledge" / "items" / "产品说明书.md").is_file()
    assert main(["restore", str(snapshot), "--verify-only"], settings=settings) == 0


def test_restore_rejects_a_changed_snapshot(tmp_path: Path, capsys) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")
    _ready_data(settings)
    destination = tmp_path / "snapshots"
    snapshot = _create_snapshot(settings, destination, capsys)
    (snapshot / "knowledge" / "items" / "产品说明书.md").write_text("tampered", encoding="utf-8")

    assert main(["restore", str(snapshot), "--verify-only"], settings=settings) == 1


def test_restore_rejects_a_manifest_missing_a_referenced_source(
    tmp_path: Path,
    capsys,
) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")
    _ready_data(settings)
    destination = tmp_path / "snapshots"
    snapshot = _create_snapshot(settings, destination, capsys)
    manifest_path = snapshot / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["files"] = [
        record
        for record in manifest["files"]
        if record["path"] != "knowledge/sources/产品说明书.pdf"
    ]
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    (snapshot / "knowledge" / "sources" / "产品说明书.pdf").unlink()

    assert main(["restore", str(snapshot), "--verify-only"], settings=settings) == 1


def test_restore_rejects_a_corrupt_database_even_with_updated_hash(
    tmp_path: Path,
    capsys,
) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")
    _ready_data(settings)
    destination = tmp_path / "snapshots"
    snapshot = _create_snapshot(settings, destination, capsys)
    database = snapshot / DATABASE_NAME
    database.write_bytes(b"not a PostgreSQL archive")
    manifest_path = snapshot / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    database_record = next(record for record in manifest["files"] if record["path"] == DATABASE_NAME)
    database_record["size"] = database.stat().st_size
    database_record["sha256"] = hashlib.sha256(database.read_bytes()).hexdigest()
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    assert main(["restore", str(snapshot), "--verify-only"], settings=settings) == 1


def test_restore_requires_confirmation_and_uses_an_empty_target(tmp_path: Path, capsys, second_pg) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")
    _ready_data(settings)
    snapshot = _create_snapshot(settings, tmp_path / 'snapshots', capsys)
    source = settings.data_dir / 'knowledge/items/产品说明书.md'
    source.write_text('changed', encoding='utf-8')
    target = Settings.from_data_dir(tmp_path / 'restored', database_url=second_pg['migration_url'])
    assert main(['restore',str(snapshot),'--apply'], settings=target) == 1
    assert not target.data_dir.exists()
    assert main(['restore',str(snapshot),'--apply','--confirm','RESTORE'], settings=target) == 0
    assert (target.data_dir / 'knowledge/items/产品说明书.md').read_text(encoding='utf-8') == '# 产品说明书'
    assert source.read_text(encoding='utf-8') == 'changed'
    assert IdentityStore(second_pg['url']).login('snapshot-user','Snapshot-Password-2026',3600)
    with transaction(second_pg['url']) as db:
        restored_path = Path(db.execute('SELECT stored_path FROM procurement_source_imports').fetchone()[0])
    assert restored_path.is_relative_to(target.data_dir) and restored_path.is_file()
    assert not (target.data_dir / RESTORE_MARKER_NAME).exists()
    assert all(value == 'ok' for value in readiness(second_pg['url'], 'test').values())


def test_restore_preserves_existing_files_and_does_not_invent_missing_config(tmp_path: Path, capsys, second_pg) -> None:
    settings = Settings.from_data_dir(tmp_path / 'data')
    _ready_data(settings)
    (settings.data_dir / 'workbench-runtime-config.json').unlink()
    snapshot = _create_snapshot(settings, tmp_path / 'snapshots', capsys)
    target = Settings.from_data_dir(tmp_path / 'occupied', database_url=second_pg['migration_url'])
    target.ensure_directories()
    config = target.data_dir / 'workbench-runtime-config.json'
    config.write_text('{"environment":"test"}', encoding='utf-8')
    assert main(['restore',str(snapshot),'--apply','--confirm','RESTORE'], settings=target) == 1
    assert config.read_text(encoding='utf-8') == '{"environment":"test"}'
    fresh = replace(target, data_dir=tmp_path / 'fresh', controlled_work_dir=tmp_path / 'fresh/controlled-work')
    assert main(['restore',str(snapshot),'--apply','--confirm','RESTORE'], settings=fresh) == 0
    assert not (fresh.data_dir / 'workbench-runtime-config.json').exists()


def test_doctor_reports_a_ready_local_environment(tmp_path: Path) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")
    _ready_data(settings)

    assert main(["doctor"], settings=settings) == 0


def test_failed_backup_does_not_publish_a_partial_snapshot(
    tmp_path: Path,
    monkeypatch,
) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")
    _ready_data(settings)
    destination = tmp_path / "snapshots"

    monkeypatch.setattr("api.operations.shutil.copy2", lambda *_: (_ for _ in ()).throw(OSError("stopped")))

    assert main(["backup", "--destination", str(destination)], settings=settings) == 1
    assert list(destination.iterdir()) == []


def test_running_service_blocks_an_applied_restore(tmp_path: Path, capsys) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")
    _ready_data(settings)
    destination = tmp_path / "snapshots"
    snapshot = _create_snapshot(settings, destination, capsys)

    with TestClient(create_app(settings)):
        result = main(
            ["restore", str(snapshot), "--apply", "--confirm", "RESTORE"],
            settings=settings,
        )

    assert result == 1
def test_service_probe_preserves_live_process_and_clears_exited_marker(tmp_path):
    import subprocess
    import sys
    from api.operations import SERVICE_PID_NAME, service_is_running
    from api.settings import Settings

    settings = Settings.from_data_dir(tmp_path)
    process = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    marker = tmp_path / SERVICE_PID_NAME
    marker.write_text(f"service:{process.pid}", encoding="ascii")
    try:
        assert service_is_running(settings)
        assert process.poll() is None
    finally:
        process.terminate()
        process.wait(timeout=10)
    assert not service_is_running(settings)
    assert not marker.exists()


def test_service_probe_keeps_lock_when_marker_cannot_be_read(tmp_path, monkeypatch):
    from pathlib import Path
    from api.operations import SERVICE_PID_NAME, service_is_running
    from api.settings import Settings

    marker = tmp_path / SERVICE_PID_NAME
    marker.write_text("service:999999", encoding="ascii")
    def failed_read(*args, **kwargs):
        raise OSError("temporary I/O failure")
    monkeypatch.setattr(Path, "read_text", failed_read)
    assert service_is_running(Settings.from_data_dir(tmp_path))
    assert marker.exists()


def test_service_probe_does_not_remove_incomplete_marker(tmp_path):
    from api.operations import SERVICE_PID_NAME, service_is_running
    from api.settings import Settings
    marker = tmp_path / SERVICE_PID_NAME
    for content in ("", "service:", "service:0", "service:-1"):
        marker.write_text(content, encoding="ascii")
        assert service_is_running(Settings.from_data_dir(tmp_path))
        assert marker.exists()


def test_failed_native_restore_keeps_original_seed_and_removes_staged_files(tmp_path, capsys, second_pg, monkeypatch):
    import api.operations as operations
    settings = Settings.from_data_dir(tmp_path / 'source')
    _ready_data(settings)
    snapshot = _create_snapshot(settings, tmp_path / 'snapshots', capsys)
    target = Settings.from_data_dir(tmp_path / 'target', database_url=second_pg['migration_url'])
    with transaction(second_pg['url']) as db:
        before = _table_evidence(db)
    original = operations._run_pg
    def fail_restore(name, args, url=None):
        if name == 'psql':
            after = Path(next(value.removeprefix('--file=') for value in reversed(args) if value.startswith('--file=')))
            with after.open('a', encoding='utf-8') as script:
                script.write('\nSELECT 1/0;\n')
        return original(name,args,url)
    monkeypatch.setattr(operations, '_run_pg', fail_restore)
    assert main(['restore',str(snapshot),'--apply','--confirm','RESTORE'], settings=target) == 1
    with transaction(second_pg['url']) as db:
        assert _table_evidence(db) == before
    assert not (target.data_dir / RESTORE_MARKER_NAME).exists()
    assert sorted(path.relative_to(target.data_dir).as_posix() for path in target.data_dir.rglob('*') if path.is_file()) == ['environment']


def test_restore_rejects_populated_database_and_wrong_database_environment(tmp_path, capsys, second_pg):
    settings = Settings.from_data_dir(tmp_path / 'source')
    _ready_data(settings)
    snapshot = _create_snapshot(settings, tmp_path / 'snapshots', capsys)
    migration = replace(settings, data_dir=tmp_path / 'different-directory', database_url=os.environ['HONGHAO_TEST_MIGRATION_URL'])
    with transaction(settings.database_url) as db:
        before = _table_evidence(db)
    assert main(['restore',str(snapshot),'--apply','--confirm','RESTORE'], settings=migration) == 1
    with transaction(settings.database_url) as db:
        assert _table_evidence(db) == before
    wrong_environment = Settings.from_data_dir(tmp_path / 'wrong', database_url=second_pg['migration_url'], database_environment='acceptance')
    assert main(['restore',str(snapshot),'--apply','--confirm','RESTORE'], settings=wrong_environment) == 1
    assert not wrong_environment.data_dir.exists()


def test_restore_lost_lease_before_import_preserves_empty_target(tmp_path, capsys, second_pg, monkeypatch):
    from contextlib import contextmanager
    import api.operations as operations
    from api.postgres import connect

    settings = Settings.from_data_dir(tmp_path / 'source')
    _ready_data(settings)
    snapshot = _create_snapshot(settings, tmp_path / 'snapshots', capsys)
    target = Settings.from_data_dir(tmp_path / 'target', database_url=second_pg['migration_url'])
    with transaction(second_pg['url']) as db:
        before = _table_evidence(db)
    original_lease = operations.database_lease
    original_run = operations._run_pg
    observed = {'pid': None, 'terminated': False, 'import_started': False}

    @contextmanager
    def tracked_lease(url):
        with original_lease(url) as lease:
            observed['pid'] = lease.info.backend_pid
            yield lease

    def terminate_before_import(name, args, url=None):
        if name == 'psql':
            observed['import_started'] = True
        result = original_run(name, args, url)
        if name == 'pg_restore' and any(value.startswith('--file=') and Path(value.removeprefix('--file=')).name == 'restore.sql' for value in args):
            assert observed['pid'] is not None
            # Terminate only this test's captured restore lease in its disposable target database.
            with connect(target.database_url) as terminator:
                assert terminator.execute('SELECT pg_terminate_backend(%s)', (observed['pid'],)).fetchone() == (True,)
            observed['terminated'] = True
        return result

    monkeypatch.setattr(operations, 'database_lease', tracked_lease)
    monkeypatch.setattr(operations, '_run_pg', terminate_before_import)
    assert main(['restore', str(snapshot), '--apply', '--confirm', 'RESTORE'], settings=target) == 1
    assert observed['terminated'] and not observed['import_started']
    with transaction(second_pg['url']) as db:
        assert _table_evidence(db) == before
    assert not (target.data_dir / RESTORE_MARKER_NAME).exists()
    assert sorted(path.relative_to(target.data_dir).as_posix() for path in target.data_dir.rglob('*') if path.is_file()) == ['environment']


def test_same_database_service_lock_rejects_another_directory(tmp_path, capsys):
    from api.operations import service_marker
    import pytest
    settings = Settings.from_data_dir(tmp_path / 'one')
    settings.ensure_directories()
    other = Settings.from_data_dir(tmp_path / 'two')
    other.ensure_directories()
    with service_marker(settings):
        with service_marker(settings):
            with pytest.raises(RuntimeError):
                with service_marker(other):
                    pass
    with service_marker(other):
        pass


def test_native_tool_errors_do_not_expose_credentials(tmp_path, monkeypatch, capsys):
    from types import SimpleNamespace
    from uuid import uuid4
    import pytest
    import api.operations as operations
    secret = uuid4().hex
    url = 'postgresql://test-account:' + secret + '@127.0.0.1:5432/test-fixture'
    def failed(args, **kwargs):
        assert secret not in repr(args) and url not in repr(args)
        assert kwargs['env']['PGPASSWORD'] == secret
        return SimpleNamespace(returncode=1, stdout=url, stderr=url)
    monkeypatch.setattr(operations.subprocess, 'run', failed)
    with pytest.raises(RuntimeError) as error:
        operations._run_pg('pg_dump', ['--no-password'], url)
    assert secret not in str(error.value) and url not in str(error.value)
    assert secret not in capsys.readouterr().out


def test_snapshot_cannot_restore_database_identity_metadata(tmp_path, capsys):
    import api.operations as operations
    settings = Settings.from_data_dir(tmp_path / 'source')
    _ready_data(settings)
    snapshot = _create_snapshot(settings, tmp_path / 'snapshots', capsys)
    dump = snapshot / DATABASE_NAME
    operations._run_pg('pg_dump', ['--no-password','--format=custom','--data-only','--schema=public',
        '--schema=honghao_meta','--file=' + str(dump)], settings.database_url)
    manifest_path = snapshot / 'manifest.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    record = next(record for record in manifest['files'] if record['path'] == DATABASE_NAME)
    record.update(size=dump.stat().st_size, sha256=hashlib.sha256(dump.read_bytes()).hexdigest())
    manifest_path.write_text(json.dumps(manifest), encoding='utf-8')
    assert main(['restore',str(snapshot),'--verify-only'], settings=settings) == 1
