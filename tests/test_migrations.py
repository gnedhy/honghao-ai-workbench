"""Old SQLite schemas must be upgraded by the retained old app before current-snapshot import."""
import os
from pathlib import Path

from fastapi.testclient import TestClient

from api.database import Database
from api.main import create_app
from api.postgres import transaction
from api.settings import Settings


def test_version_three_partial_migration_is_rejected_without_runtime_ddl(tmp_path: Path) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")
    with transaction(os.environ['HONGHAO_TEST_MIGRATION_URL'], write=True) as connection:
        connection.execute("DROP TABLE tasks")
        connection.execute("ALTER TABLE conversation_messages DROP COLUMN submission_key")
        connection.execute("UPDATE schema_metadata SET value=3 WHERE key='schema_version'")
        connection.execute("INSERT INTO projects(id,title) VALUES ('project-1','已有项目')")
    with TestClient(create_app(settings)) as client:
        assert client.get('/api/readiness').status_code == 503
        assert client.get('/api/projects').status_code == 503
    assert Database(settings.database_url).schema_version() == 3
    with transaction(settings.database_url) as connection:
        assert connection.execute("SELECT to_regclass('tasks')").fetchone() == (None,)
        assert connection.execute("SELECT to_regclass('conversation_messages')").fetchone() == ('conversation_messages',)
        assert connection.execute("SELECT id,title FROM projects").fetchall() == [('project-1','已有项目')]
        assert connection.execute("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='conversation_messages' AND column_name='submission_key'").fetchall() == []


def test_version_four_migration_is_rejected_without_relinking_work_history(tmp_path: Path) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")
    with transaction(os.environ['HONGHAO_TEST_MIGRATION_URL'], write=True) as connection:
        connection.execute("ALTER TABLE tasks DROP COLUMN message_id")
        connection.execute("ALTER TABLE conversation_messages DROP COLUMN submission_key")
        connection.execute("UPDATE schema_metadata SET value=4 WHERE key='schema_version'")
        connection.execute("INSERT INTO conversations(id,title,project_id) VALUES ('conversation-1','已有工作',NULL)")
        connection.execute("INSERT INTO conversation_messages(id,conversation_id,mode,content,created_at) VALUES ('message-1','conversation-1','work','整理已有材料','2026-08-18T00:00:00+00:00')")
        connection.execute("INSERT INTO tasks(id,conversation_id,objective,project_id,status,created_at) VALUES ('task-1','conversation-1','整理已有材料',NULL,'created','2026-08-18T00:00:00+00:00')")
        messages = connection.execute("SELECT * FROM conversation_messages ORDER BY _order").fetchall()
        tasks = connection.execute("SELECT * FROM tasks ORDER BY _order").fetchall()
    with TestClient(create_app(settings)) as client:
        assert client.get('/api/readiness').status_code == 503
        assert client.get('/api/tasks').status_code == 503
    assert Database(settings.database_url).schema_version() == 4
    with transaction(settings.database_url) as connection:
        assert connection.execute("SELECT * FROM conversation_messages ORDER BY _order").fetchall() == messages
        assert connection.execute("SELECT * FROM tasks ORDER BY _order").fetchall() == tasks
        assert connection.execute("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='tasks' AND column_name='message_id'").fetchall() == []
