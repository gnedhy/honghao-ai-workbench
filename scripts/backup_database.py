from __future__ import annotations

import argparse
import os
import sqlite3
import tempfile
from contextlib import closing
from pathlib import Path


def backup_database(source: Path, destination: Path) -> None:
    if not source.is_file():
        raise FileNotFoundError(source)

    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        raise FileExistsError(destination)

    with tempfile.NamedTemporaryFile(
        dir=destination.parent,
        prefix=f".{destination.name}.",
        suffix=".tmp",
        delete=False,
    ) as temporary_file:
        temporary_path = Path(temporary_file.name)

    try:
        with closing(sqlite3.connect(source)) as source_connection:
            with closing(sqlite3.connect(temporary_path)) as destination_connection:
                source_connection.backup(destination_connection)
        with closing(sqlite3.connect(temporary_path)) as backup_connection:
            if backup_connection.execute("PRAGMA integrity_check").fetchone() != ("ok",):
                raise RuntimeError("SQLite backup failed integrity_check")
        os.link(temporary_path, destination)
    finally:
        temporary_path.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="Create a non-overwriting SQLite backup.")
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    arguments = parser.parse_args()
    backup_database(arguments.source, arguments.destination)
    print(arguments.destination.resolve())


if __name__ == "__main__":
    main()
