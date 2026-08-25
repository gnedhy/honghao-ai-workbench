from __future__ import annotations

import argparse
import sqlite3
from pathlib import Path


def backup_database(source: Path, destination: Path) -> None:
    if not source.is_file():
        raise FileNotFoundError(source)

    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("xb"):
        pass

    try:
        with sqlite3.connect(source) as source_connection:
            with sqlite3.connect(destination) as destination_connection:
                source_connection.backup(destination_connection)
    except Exception:
        destination.unlink(missing_ok=True)
        raise


def main() -> None:
    parser = argparse.ArgumentParser(description="Create a non-overwriting SQLite backup.")
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    arguments = parser.parse_args()
    backup_database(arguments.source, arguments.destination)
    print(arguments.destination.resolve())


if __name__ == "__main__":
    main()
