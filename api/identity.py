from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from uuid import uuid4


IDENTITY_SCHEMA_VERSION = 1
SESSION_COOKIE_NAME = "honghao_session"
SYSTEM_ADMIN_ROLE_ID = "system-admin"

SYSTEM_ROLES: tuple[tuple[str, str], ...] = (
    (SYSTEM_ADMIN_ROLE_ID, "系统管理员"),
    ("knowledge-admin", "知识管理员"),
    ("employee", "普通员工"),
    ("procurement", "采购"),
    ("research", "研发"),
    ("sales", "销售"),
    ("management", "总经办"),
)

_SCRYPT_N = 2**14
_SCRYPT_R = 8
_SCRYPT_P = 1


class DuplicateIdentityError(Exception):
    pass


class IdentityStore:
    def __init__(self, path: Path) -> None:
        self.path = path

    def initialize(self) -> None:
        with sqlite3.connect(self.path) as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS identity_roles (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL UNIQUE,
                    system INTEGER NOT NULL CHECK (system IN (0, 1))
                );
                CREATE TABLE IF NOT EXISTS identity_users (
                    id TEXT PRIMARY KEY,
                    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
                    display_name TEXT NOT NULL,
                    department TEXT,
                    password_salt BLOB NOT NULL,
                    password_hash BLOB NOT NULL,
                    is_active INTEGER NOT NULL CHECK (is_active IN (0, 1)),
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS identity_user_roles (
                    user_id TEXT NOT NULL REFERENCES identity_users(id) ON DELETE CASCADE,
                    role_id TEXT NOT NULL REFERENCES identity_roles(id),
                    PRIMARY KEY (user_id, role_id)
                );
                CREATE TABLE IF NOT EXISTS identity_sessions (
                    token_hash TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL REFERENCES identity_users(id) ON DELETE CASCADE,
                    created_at TEXT NOT NULL,
                    expires_at TEXT NOT NULL
                );
                """
            )
            connection.execute(
                "INSERT OR IGNORE INTO schema_metadata (key, value) VALUES (?, ?)",
                ("identity_schema_version", IDENTITY_SCHEMA_VERSION),
            )
            version = connection.execute(
                "SELECT value FROM schema_metadata WHERE key = ?",
                ("identity_schema_version",),
            ).fetchone()
            if version is None or int(version[0]) != IDENTITY_SCHEMA_VERSION:
                raise RuntimeError("Unsupported identity schema version")
            connection.executemany(
                "INSERT OR IGNORE INTO identity_roles (id, name, system) VALUES (?, ?, 1)",
                SYSTEM_ROLES,
            )

    def create_user(
        self,
        *,
        username: str,
        display_name: str,
        department: str | None,
        password: str,
        role_ids: list[str],
    ) -> dict[str, Any]:
        salt = os.urandom(16)
        password_hash = _hash_password(password, salt)
        user_id = str(uuid4())
        created_at = datetime.now(UTC).isoformat()
        try:
            with sqlite3.connect(self.path) as connection:
                connection.execute("BEGIN IMMEDIATE")
                self._ensure_roles_exist(connection, role_ids)
                connection.execute(
                    "INSERT INTO identity_users (id, username, display_name, department, password_salt, password_hash, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)",
                    (user_id, username, display_name, department, salt, password_hash, created_at),
                )
                connection.executemany(
                    "INSERT INTO identity_user_roles (user_id, role_id) VALUES (?, ?)",
                    [(user_id, role_id) for role_id in dict.fromkeys(role_ids)],
                )
        except sqlite3.IntegrityError as error:
            raise DuplicateIdentityError from error
        user = self.get_user(user_id)
        if user is None:
            raise RuntimeError("Created user is unavailable")
        return user

    def create_role(self, name: str) -> dict[str, Any]:
        role = {"id": str(uuid4()), "name": name, "system": False}
        try:
            with sqlite3.connect(self.path) as connection:
                connection.execute(
                    "INSERT INTO identity_roles (id, name, system) VALUES (?, ?, 0)",
                    (role["id"], role["name"]),
                )
        except sqlite3.IntegrityError as error:
            raise DuplicateIdentityError from error
        return role

    def list_roles(self) -> list[dict[str, Any]]:
        with sqlite3.connect(self.path) as connection:
            rows = connection.execute(
                "SELECT id, name, system FROM identity_roles ORDER BY rowid"
            ).fetchall()
        return [
            {"id": str(row[0]), "name": str(row[1]), "system": bool(row[2])}
            for row in rows
        ]

    def login(self, username: str, password: str, ttl_seconds: int) -> tuple[dict[str, Any], str] | None:
        with sqlite3.connect(self.path) as connection:
            row = connection.execute(
                "SELECT id, password_salt, password_hash, is_active FROM identity_users WHERE username = ?",
                (username,),
            ).fetchone()
        if row is None:
            _hash_password(password, bytes(16))
            return None
        if not hmac.compare_digest(_hash_password(password, bytes(row[1])), bytes(row[2])):
            return None
        if not bool(row[3]):
            return None

        token = secrets.token_urlsafe(32)
        token_hash = _hash_session_token(token)
        created_at = datetime.now(UTC)
        expires_at = created_at + timedelta(seconds=ttl_seconds)
        with sqlite3.connect(self.path) as connection:
            connection.execute(
                "INSERT INTO identity_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
                (token_hash, str(row[0]), created_at.isoformat(), expires_at.isoformat()),
            )
        user = self.get_user(str(row[0]))
        if user is None:
            return None
        return user, token

    def user_for_session(self, token: str) -> dict[str, Any] | None:
        token_hash = _hash_session_token(token)
        now = datetime.now(UTC).isoformat()
        with sqlite3.connect(self.path) as connection:
            row = connection.execute(
                "SELECT user_id, expires_at FROM identity_sessions WHERE token_hash = ?",
                (token_hash,),
            ).fetchone()
            if row is None:
                return None
            if str(row[1]) <= now:
                # ponytail: sessions are purged lazily; add batch cleanup if local volume grows.
                connection.execute("DELETE FROM identity_sessions WHERE token_hash = ?", (token_hash,))
                return None
        user = self.get_user(str(row[0]))
        return user if user is not None and user["is_active"] else None

    def logout(self, token: str) -> None:
        with sqlite3.connect(self.path) as connection:
            connection.execute(
                "DELETE FROM identity_sessions WHERE token_hash = ?",
                (_hash_session_token(token),),
            )

    def get_user(self, user_id: str) -> dict[str, Any] | None:
        with sqlite3.connect(self.path) as connection:
            row = connection.execute(
                "SELECT id, username, display_name, department, is_active FROM identity_users WHERE id = ?",
                (user_id,),
            ).fetchone()
            if row is None:
                return None
            role_rows = connection.execute(
                "SELECT roles.id, roles.name, roles.system FROM identity_roles AS roles JOIN identity_user_roles AS user_roles ON user_roles.role_id = roles.id WHERE user_roles.user_id = ? ORDER BY roles.rowid",
                (user_id,),
            ).fetchall()
        return {
            "id": str(row[0]),
            "username": str(row[1]),
            "display_name": str(row[2]),
            "department": str(row[3]) if row[3] is not None else None,
            "is_active": bool(row[4]),
            "roles": [
                {"id": str(role[0]), "name": str(role[1]), "system": bool(role[2])}
                for role in role_rows
            ],
        }

    def list_users(self) -> list[dict[str, Any]]:
        # ponytail: account lists are small locally; replace with one joined query if volume grows.
        with sqlite3.connect(self.path) as connection:
            user_ids = [
                str(row[0])
                for row in connection.execute("SELECT id FROM identity_users ORDER BY rowid")
            ]
        return [user for user_id in user_ids if (user := self.get_user(user_id)) is not None]

    def update_user(
        self,
        user_id: str,
        *,
        is_active: bool | None = None,
        role_ids: list[str] | None = None,
    ) -> dict[str, Any] | None:
        with sqlite3.connect(self.path) as connection:
            connection.execute("BEGIN IMMEDIATE")
            if connection.execute("SELECT 1 FROM identity_users WHERE id = ?", (user_id,)).fetchone() is None:
                return None
            if role_ids is not None:
                self._ensure_roles_exist(connection, role_ids)
                connection.execute("DELETE FROM identity_user_roles WHERE user_id = ?", (user_id,))
                connection.executemany(
                    "INSERT INTO identity_user_roles (user_id, role_id) VALUES (?, ?)",
                    [(user_id, role_id) for role_id in dict.fromkeys(role_ids)],
                )
            if is_active is not None:
                connection.execute(
                    "UPDATE identity_users SET is_active = ? WHERE id = ?",
                    (int(is_active), user_id),
                )
            connection.execute("DELETE FROM identity_sessions WHERE user_id = ?", (user_id,))
        return self.get_user(user_id)

    @staticmethod
    def _ensure_roles_exist(connection: sqlite3.Connection, role_ids: list[str]) -> None:
        if not role_ids:
            raise ValueError("At least one role is required")
        unique_role_ids = list(dict.fromkeys(role_ids))
        placeholders = ",".join("?" for _ in unique_role_ids)
        count = connection.execute(
            f"SELECT COUNT(*) FROM identity_roles WHERE id IN ({placeholders})",
            unique_role_ids,
        ).fetchone()
        if count is None or int(count[0]) != len(unique_role_ids):
            raise ValueError("Unknown role")


def _hash_password(password: str, salt: bytes) -> bytes:
    return hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=_SCRYPT_N,
        r=_SCRYPT_R,
        p=_SCRYPT_P,
        dklen=32,
    )


def _hash_session_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()
