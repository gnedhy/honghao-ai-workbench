import hashlib
import json
import sqlite3
from pathlib import Path

from api.cli import main
from api.main import create_app
from api.settings import Settings
from fastapi.testclient import TestClient


def _ready_data(settings: Settings) -> None:
    assert main(["migrate"], settings=settings) == 0
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


def _create_snapshot(settings: Settings, destination: Path, capsys) -> Path:
    assert main(["backup", "--destination", str(destination)], settings=settings) == 0
    return Path(capsys.readouterr().out.strip().splitlines()[-1])


def test_backup_and_verify_restore_support_chinese_paths(tmp_path: Path, capsys) -> None:
    settings = Settings.from_data_dir(tmp_path / "中台数据")
    _ready_data(settings)
    destination = tmp_path / "中文快照"

    snapshot = _create_snapshot(settings, destination, capsys)
    assert snapshot.parent == destination
    assert (snapshot / "honghao.db").is_file()
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
    with sqlite3.connect(settings.database_path) as connection:
        connection.execute(
            """
            INSERT INTO knowledge_sources (
                id, filename, mime_type, size_bytes, sha256, stored_name,
                created_by_user_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "source-1",
                "产品说明书.pdf",
                "application/pdf",
                15,
                "unused-in-this-test",
                "产品说明书.pdf",
                "user-1",
                "2026-08-30T00:00:00+00:00",
            ),
        )
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
    database = snapshot / "honghao.db"
    database.write_bytes(b"not a sqlite database")
    manifest_path = snapshot / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    database_record = next(record for record in manifest["files"] if record["path"] == "honghao.db")
    database_record["size"] = database.stat().st_size
    database_record["sha256"] = hashlib.sha256(database.read_bytes()).hexdigest()
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    assert main(["restore", str(snapshot), "--verify-only"], settings=settings) == 1


def test_restore_requires_confirmation_and_replaces_data(tmp_path: Path, capsys) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")
    _ready_data(settings)
    destination = tmp_path / "snapshots"
    snapshot = _create_snapshot(settings, destination, capsys)
    source = settings.data_dir / "knowledge" / "items" / "产品说明书.md"
    source.write_text("changed", encoding="utf-8")

    assert main(["restore", str(snapshot), "--apply"], settings=settings) == 1
    assert source.read_text(encoding="utf-8") == "changed"
    assert main(
        ["restore", str(snapshot), "--apply", "--confirm", "RESTORE"],
        settings=settings,
    ) == 0
    assert source.read_text(encoding="utf-8") == "# 产品说明书"


def test_restore_removes_runtime_configuration_missing_from_snapshot(tmp_path: Path, capsys) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")
    _ready_data(settings)
    (settings.data_dir / "workbench-runtime-config.json").unlink()
    snapshot = _create_snapshot(settings, tmp_path / "snapshots", capsys)
    later_config = settings.data_dir / "workbench-runtime-config.json"
    later_config.write_text('{"environment":"test"}', encoding="utf-8")

    assert main(
        ["restore", str(snapshot), "--apply", "--confirm", "RESTORE"],
        settings=settings,
    ) == 0
    assert not later_config.exists()


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
