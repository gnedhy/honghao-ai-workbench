import sqlite3
from pathlib import Path

import pytest

from scripts.backup_database import backup_database


def test_backup_database_creates_readable_copy_without_overwrite(tmp_path: Path) -> None:
    source = tmp_path / "honghao.db"
    destination = tmp_path / "backups" / "pre-procurement.db"
    with sqlite3.connect(source) as connection:
        connection.execute("CREATE TABLE evidence (value TEXT NOT NULL)")
        connection.execute("INSERT INTO evidence (value) VALUES ('baseline')")

    backup_database(source, destination)

    with sqlite3.connect(destination) as connection:
        assert connection.execute("SELECT value FROM evidence").fetchone() == ("baseline",)
    with pytest.raises(FileExistsError):
        backup_database(source, destination)
