from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import psycopg
from api.postgres import transaction
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

from api.authorization import AuthorizationStore
from api import organization


IDENTITY_SCHEMA_VERSION = 6
SESSION_COOKIE_NAME = "honghao_session"
SYSTEM_ADMIN_ROLE_ID = "system-admin"
# Explicit deployment policy for new and administrator-reset credentials.
INITIAL_ACCOUNT_PASSWORD = "123456"

SCOPE_ACCESS_LEVELS = (2, 3, 4)
SCOPE_IDS = ("management", "procurement", "research", "sales", "knowledge")

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
    def __init__(self, url: str) -> None:
        self.url = url


    def create_user(
        self,
        *,
        username: str,
        display_name: str,
        department: str | None,
        password: str,
        is_system_admin: bool = False,
        scope_levels: dict[str, int] | None = None,
        primary_department_id: str | None = None,
        additional_department_ids: list[str] | None = None,
    ) -> dict[str, Any]:
        normalized_scopes = {} if is_system_admin else _validate_scope_levels(scope_levels or {})
        salt = os.urandom(16)
        password_hash = _hash_password(password, salt)
        user_id = str(uuid4())
        created_at = datetime.now(UTC).isoformat()
        try:
            with transaction(self.url, write=True) as connection:

                connection.execute(
                    "INSERT INTO identity_users (id, username, display_name, department, password_salt, password_hash, is_active, access_level, created_at) VALUES (%s, %s, %s, %s, %s, %s, 1, %s, %s)",
                    (user_id, username, display_name, department, salt, password_hash, 5 if is_system_admin else 1, created_at),
                )
                connection.cursor().executemany(
                    "INSERT INTO identity_user_scopes (user_id, scope_id, access_level) VALUES (%s, %s, %s)",
                    [(user_id, scope_id, level) for scope_id, level in normalized_scopes.items()],
                )
                primary = primary_department_id or (organization.legacy_department(connection, department) if department and department.strip() else None)
                organization.assign(connection, user_id, primary, additional_department_ids or [])
        except psycopg.IntegrityError as error:
            raise DuplicateIdentityError from error
        user = self.get_user(user_id)
        if user is None:
            raise RuntimeError("Created user is unavailable")
        return user

    def create_role(self, name: str) -> dict[str, Any]:
        role = {"id": str(uuid4()), "name": name, "system": False}
        try:
            with transaction(self.url, write=True) as connection:
                connection.execute(
                    "INSERT INTO identity_roles (id, name, system) VALUES (%s, %s, 0)",
                    (role["id"], role["name"]),
                )
        except psycopg.IntegrityError as error:
            raise DuplicateIdentityError from error
        return role

    def list_roles(self) -> list[dict[str, Any]]:
        with transaction(self.url) as connection:
            rows = connection.execute(
                "SELECT id, name, system FROM identity_roles ORDER BY _order"
            ).fetchall()
        return [
            {"id": str(row[0]), "name": str(row[1]), "system": bool(row[2])}
            for row in rows
        ]

    def login(self, username: str, password: str, ttl_seconds: int) -> tuple[dict[str, Any], str] | None:
        with transaction(self.url) as connection:
            row = connection.execute(
                "SELECT id, password_salt, password_hash, is_active FROM identity_users WHERE translate(username,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz') = translate(%s,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')",
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
        with transaction(self.url, write=True) as connection:
            # Recheck credentials under the same write lock as session insertion:
            # a password change must not be followed by a late old-password session.

            valid = connection.execute(
                "SELECT 1 FROM identity_users WHERE id=%s AND password_hash=%s AND password_salt=%s AND is_active=1",
                (str(row[0]), row[2], row[1]),
            ).fetchone()
            if valid is None:
                return None
            connection.execute(
                "INSERT INTO identity_sessions (token_hash, user_id, created_at, expires_at) VALUES (%s, %s, %s, %s)",
                (token_hash, str(row[0]), created_at.isoformat(), expires_at.isoformat()),
            )
        user = self.get_user(str(row[0]))
        if user is None:
            return None
        return user, token

    def change_password(self, user_id: str, token: str, current: str, new: str, confirm: str) -> str:
        if not 1 <= len(new) <= 1000 or new != confirm:
            return "invalid"
        now = datetime.now(UTC)
        with transaction(self.url, write=True) as connection:
            # ponytail: The shared PostgreSQL write transaction serializes credentials; revisit
            # per-account locking only if multi-server authentication is introduced.

            row = connection.execute(
                "SELECT u.password_salt,u.password_hash FROM identity_users u JOIN identity_sessions s ON s.user_id=u.id "
                "WHERE u.id=%s AND u.is_active=1 AND s.token_hash=%s AND s.expires_at>%s",
                (user_id, _hash_session_token(token), now.isoformat()),
            ).fetchone()
            if row is None:
                return "expired"
            connection.execute("DELETE FROM identity_password_failures WHERE user_id=%s AND attempted_at<=%s", (user_id, (now-timedelta(minutes=15)).isoformat()))
            failures = connection.execute("SELECT count(*) FROM identity_password_failures WHERE user_id=%s", (user_id,)).fetchone()[0]
            result = "limited" if failures >= 5 else "wrong" if not hmac.compare_digest(_hash_password(current, bytes(row[0])), bytes(row[1])) else "same" if current == new else "changed"
            if result == "wrong":
                connection.execute("INSERT INTO identity_password_failures (user_id,attempted_at) VALUES (%s,%s)", (user_id, now.isoformat()))
            elif result in ("same", "changed"):
                connection.execute("DELETE FROM identity_password_failures WHERE user_id=%s", (user_id,))
            if result == "changed":
                salt = os.urandom(16)
                connection.execute("UPDATE identity_users SET password_salt=%s,password_hash=%s WHERE id=%s", (salt, _hash_password(new, salt), user_id))
                connection.execute("DELETE FROM identity_sessions WHERE user_id=%s", (user_id,))
            AuthorizationStore(self.url).audit("password." + result, actor_user_id=user_id, target_type="account", target_id=user_id, connection=connection)
            return result

    def reset_initial_passwords(self, *, actor_id: str, user_ids: list[str]) -> int:
        if actor_id in user_ids or len(set(user_ids)) != len(user_ids):
            raise ValueError('不能重置当前管理员自身密码或重复选择账号')
        with transaction(self.url, write=True) as connection:

            organization.require_admin(connection, actor_id)
            for user_id in user_ids:
                if not connection.execute('SELECT 1 FROM identity_users WHERE id=%s', (user_id,)).fetchone():
                    raise ValueError('账号已不存在，未执行重置')
            for user_id in user_ids:
                salt = os.urandom(16)
                connection.execute('UPDATE identity_users SET password_salt=%s,password_hash=%s WHERE id=%s', (salt, _hash_password(INITIAL_ACCOUNT_PASSWORD, salt), user_id))
                connection.execute('DELETE FROM identity_sessions WHERE user_id=%s', (user_id,))
                connection.execute('DELETE FROM identity_password_failures WHERE user_id=%s', (user_id,))
                AuthorizationStore(self.url).audit('password.reset', actor_user_id=actor_id, target_type='account', target_id=user_id, connection=connection)
        return len(user_ids)

    def update_profile(self, user_id: str, *, actor_id: str, display_name: str | None = None, department: str | None = None, membership: dict | None = None) -> dict[str, Any] | None:
        with transaction(self.url, write=True) as connection:

            actor = connection.execute("SELECT 1 FROM identity_users WHERE id=%s AND is_active=1 AND (access_level=5 OR id=%s)", (actor_id, user_id)).fetchone()
            if actor is None:
                raise PermissionError("Active account owner or administrator required")
            existing = connection.execute('SELECT department FROM identity_users WHERE id=%s', (user_id,)).fetchone()
            if existing is None:
                return None
            if department is not None and department != existing[0]:
                raise ValueError('部门归属请由管理员通过部门选择调整')
            if membership is not None:
                organization.require_admin(connection, actor_id)
                organization.assign(connection, user_id, membership['primary_department_id'], membership['additional_department_ids'])
                AuthorizationStore(self.url).audit('user.departments.updated', actor_user_id=actor_id, target_type='account', target_id=user_id, connection=connection)
            if display_name is not None:
                connection.execute('UPDATE identity_users SET display_name=%s WHERE id=%s', (display_name, user_id))
                AuthorizationStore(self.url).audit("user.profile.updated", actor_user_id=actor_id, target_type="account", target_id=user_id, connection=connection)
        return self.get_user(user_id)

    def user_for_session(self, token: str) -> dict[str, Any] | None:
        token_hash = _hash_session_token(token)
        now = datetime.now(UTC).isoformat()
        with transaction(self.url) as connection:
            row = connection.execute(
                "SELECT user_id, expires_at FROM identity_sessions WHERE token_hash = %s",
                (token_hash,),
            ).fetchone()
            if row is None:
                return None
            if str(row[1]) <= now:
                return None
            user = self.get_user(str(row[0]))
            return user if user is not None and user["is_active"] else None

    def logout(self, token: str) -> None:
        with transaction(self.url, write=True) as connection:
            connection.execute(
                "DELETE FROM identity_sessions WHERE token_hash = %s",
                (_hash_session_token(token),),
            )

    def get_user(self, user_id: str) -> dict[str, Any] | None:
        with transaction(self.url) as connection:
            row = connection.execute(
                "SELECT id, username, display_name, department, is_active, access_level FROM identity_users WHERE id = %s",
                (user_id,),
            ).fetchone()
            if row is None:
                return None
            scope_rows = connection.execute(
                "SELECT scope_id, access_level FROM identity_user_scopes WHERE user_id = %s",
                (user_id,),
            ).fetchall()
            memberships = connection.execute('SELECT m.department_id,d.name,m.is_primary FROM organization_memberships m JOIN organization_departments d ON d.id=m.department_id WHERE m.user_id=%s ORDER BY m.is_primary DESC,d._order', (user_id,)).fetchall()
        return {
            "id": str(row[0]),
            "username": str(row[1]),
            "display_name": str(row[2]),
            "department": str(row[3]) if row[3] is not None else None,
            "primary_department_id": next((d for d, _, primary in memberships if primary), None),
            "additional_department_ids": [d for d, _, primary in memberships if not primary],
            "departments": [{"id": d, "name": name, "is_primary": bool(primary)} for d, name, primary in memberships],
            "is_active": bool(row[4]),
            "is_system_admin": int(row[5]) == 5,
            "scope_levels": {
                scope_id: next(int(level) for stored_scope, level in scope_rows if stored_scope == scope_id)
                for scope_id in SCOPE_IDS
                if any(stored_scope == scope_id for stored_scope, _ in scope_rows)
            },
        }

    def list_users(self) -> list[dict[str, Any]]:
        # ponytail: account lists are small locally; replace with one joined query if volume grows.
        with transaction(self.url) as connection:
            user_ids = [
                str(row[0])
                for row in connection.execute("SELECT id FROM identity_users ORDER BY _order")
            ]
        return [user for user_id in user_ids if (user := self.get_user(user_id)) is not None]

    def update_user(
        self,
        user_id: str,
        *,
        is_active: bool | None = None,
        is_system_admin: bool | None = None,
        scope_levels: dict[str, int] | None = None,
    ) -> dict[str, Any] | None:
        normalized_scopes = _validate_scope_levels(scope_levels) if scope_levels is not None else None
        with transaction(self.url, write=True) as connection:

            existing = connection.execute(
                "SELECT access_level, is_active FROM identity_users WHERE id = %s", (user_id,)
            ).fetchone()
            if existing is None:
                return None
            target_is_admin = is_system_admin if is_system_admin is not None else int(existing[0]) == 5
            if is_system_admin is not None:
                connection.execute(
                    "UPDATE identity_users SET access_level = %s WHERE id = %s",
                    (5 if is_system_admin else 1, user_id),
                )
            if normalized_scopes is not None or is_system_admin is True:
                connection.execute("DELETE FROM identity_user_scopes WHERE user_id = %s", (user_id,))
                connection.cursor().executemany(
                    "INSERT INTO identity_user_scopes (user_id, scope_id, access_level) VALUES (%s, %s, %s)",
                    [
                        (user_id, scope_id, level)
                        for scope_id, level in ({} if target_is_admin else normalized_scopes or {}).items()
                    ],
                )
            if is_active is not None:
                connection.execute(
                    "UPDATE identity_users SET is_active = %s WHERE id = %s",
                    (int(is_active), user_id),
                )
            connection.execute("DELETE FROM identity_sessions WHERE user_id = %s", (user_id,))
            from api.procurement_collaboration import capabilities, pause_schedules
            current_scopes = dict(connection.execute(
                "SELECT scope_id, access_level FROM identity_user_scopes WHERE user_id = %s", (user_id,)
            ).fetchall())
            current = {"id": user_id, "is_system_admin": target_is_admin, "scope_levels": current_scopes,
                       "is_active": is_active if is_active is not None else bool(existing[1])}
            if not capabilities(self.url, current)["can_activate"]:
                pause_schedules(connection, user_id)
        return self.get_user(user_id)

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


def _validate_scope_levels(scope_levels: dict[str, int]) -> dict[str, int]:
    if any(scope_id not in SCOPE_IDS for scope_id in scope_levels):
        raise ValueError("Unknown access scope")
    if any(level not in SCOPE_ACCESS_LEVELS for level in scope_levels.values()):
        raise ValueError("Scope permission must be view, edit, or manage")
    return {scope_id: scope_levels[scope_id] for scope_id in SCOPE_IDS if scope_id in scope_levels}
