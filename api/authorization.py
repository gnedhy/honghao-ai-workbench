from __future__ import annotations

import json
import sqlite3
from contextlib import nullcontext
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from api.modules import ModuleId


AUTHORIZATION_SCHEMA_VERSION = 5
SCOPE_IDS = ("management", "procurement", "research", "sales", "knowledge")
WORKBENCH_SCOPE_IDS = SCOPE_IDS[:4]

FIELD_CATALOG: tuple[tuple[str, str, str, str], ...] = (
    ("procurement.material_unit_price", "采购", "原料采购单价", "供应商确认后的含税采购单价"),
    ("procurement.supplier_quote", "采购", "供应商报价", "供应商原始报价与商务条件"),
    ("research.product_cost", "研发", "产品成本", "产品配方与工艺形成的成本结果"),
    ("sales.floor_price", "销售", "报价底价", "销售报价不可低于的内部控制价"),
    ("sales.gross_margin", "销售", "销售毛利率", "报价对应的内部毛利率"),
    ("management.operating_summary", "总经办", "经营汇总", "跨部门确认数据形成的经营汇总"),
)

class AuthorizationStore:
    def __init__(self, path: Path) -> None:
        self.path = path

    def initialize(self) -> None:
        with sqlite3.connect(self.path) as connection:
            connection.execute(
                "CREATE TABLE IF NOT EXISTS authorization_role_permissions (role_id TEXT NOT NULL, permission_id TEXT NOT NULL, PRIMARY KEY (role_id, permission_id))"
            )
            connection.execute(
                "CREATE TABLE IF NOT EXISTS authorization_field_policies (field_id TEXT PRIMARY KEY, read_role_ids TEXT NOT NULL DEFAULT '[]', write_role_ids TEXT NOT NULL DEFAULT '[]', read_min_level INTEGER NOT NULL DEFAULT 4, write_min_level INTEGER NOT NULL DEFAULT 4, read_scope_ids TEXT NOT NULL DEFAULT '[]', write_scope_ids TEXT NOT NULL DEFAULT '[]')"
            )
            connection.execute(
                "CREATE TABLE IF NOT EXISTS authorization_custom_fields (id TEXT PRIMARY KEY, area TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, UNIQUE (area, name))"
            )
            connection.execute(
                "CREATE TABLE IF NOT EXISTS authorization_audit_events (id TEXT PRIMARY KEY, actor_user_id TEXT, action TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL, created_at TEXT NOT NULL)"
            )
            version = connection.execute(
                "SELECT value FROM schema_metadata WHERE key = 'authorization_schema_version'"
            ).fetchone()
            if version is None:
                connection.execute(
                    "INSERT INTO schema_metadata (key, value) VALUES ('authorization_schema_version', ?)",
                    (AUTHORIZATION_SCHEMA_VERSION,),
                )
                version = (AUTHORIZATION_SCHEMA_VERSION,)
            elif int(version[0]) == 1:
                connection.execute(
                    "UPDATE schema_metadata SET value = ? WHERE key = 'authorization_schema_version'",
                    (2,),
                )
                version = (2,)
            if int(version[0]) == 2:
                columns = {
                    str(row[1])
                    for row in connection.execute("PRAGMA table_info(authorization_field_policies)")
                }
                if "read_min_level" not in columns:
                    connection.execute("ALTER TABLE authorization_field_policies ADD COLUMN read_min_level INTEGER NOT NULL DEFAULT 4")
                    connection.execute("ALTER TABLE authorization_field_policies ADD COLUMN write_min_level INTEGER NOT NULL DEFAULT 4")
                    connection.execute("ALTER TABLE authorization_field_policies ADD COLUMN read_scope_ids TEXT NOT NULL DEFAULT '[]'")
                    connection.execute("ALTER TABLE authorization_field_policies ADD COLUMN write_scope_ids TEXT NOT NULL DEFAULT '[]'")
                for field_id, read_roles, write_roles in connection.execute(
                    "SELECT field_id, read_role_ids, write_role_ids FROM authorization_field_policies"
                ).fetchall():
                    read_level, read_scopes = _legacy_policy(json.loads(str(read_roles)))
                    write_level, write_scopes = _legacy_policy(json.loads(str(write_roles)))
                    connection.execute(
                        "UPDATE authorization_field_policies SET read_min_level = ?, write_min_level = ?, read_scope_ids = ?, write_scope_ids = ? WHERE field_id = ?",
                        (read_level, write_level, json.dumps(read_scopes), json.dumps(write_scopes), field_id),
                    )
                connection.execute(
                    "UPDATE schema_metadata SET value = ? WHERE key = 'authorization_schema_version'",
                    (3,),
                )
                version = (3,)
            if int(version[0]) == 3:
                connection.execute(
                    "UPDATE authorization_field_policies SET read_min_level = 2 WHERE read_min_level = 1"
                )
                connection.execute(
                    "UPDATE authorization_field_policies SET write_min_level = 2 WHERE write_min_level = 1"
                )
                connection.execute(
                    "UPDATE schema_metadata SET value = ? WHERE key = 'authorization_schema_version'",
                    (4,),
                )
                version = (4,)
            if int(version[0]) == 4:
                connection.execute(
                    "UPDATE authorization_field_policies SET write_min_level = 3 WHERE write_min_level < 3"
                )
                connection.execute(
                    "UPDATE schema_metadata SET value = ? WHERE key = 'authorization_schema_version'",
                    (AUTHORIZATION_SCHEMA_VERSION,),
                )
                version = (AUTHORIZATION_SCHEMA_VERSION,)
            if int(version[0]) != AUTHORIZATION_SCHEMA_VERSION:
                raise RuntimeError("Unsupported authorization schema version")

    def has_module_access(
        self,
        is_system_admin: bool,
        scope_levels: dict[str, int],
        module_id: ModuleId,
        method: str,
    ) -> bool:
        if is_system_admin:
            return True
        if module_id == "knowledge":
            return scope_levels.get("knowledge", 0) >= (2 if method == "GET" else 3)
        if module_id == "workbench":
            minimum_level = 2 if method == "GET" else 3
            return any(scope_levels.get(scope_id, 0) >= minimum_level for scope_id in WORKBENCH_SCOPE_IDS)
        return False

    @staticmethod
    def can_access_workbench(is_system_admin: bool, scope_levels: dict[str, int], workbench_id: str) -> bool:
        return is_system_admin or scope_levels.get(workbench_id, 0) >= 2

    def list_field_policies(self) -> list[dict[str, Any]]:
        with sqlite3.connect(self.path) as connection:
            rows = {
                str(row[0]): (int(row[1]), int(row[2]), json.loads(str(row[3])), json.loads(str(row[4])))
                for row in connection.execute(
                    "SELECT field_id, read_min_level, write_min_level, read_scope_ids, write_scope_ids FROM authorization_field_policies"
                )
            }
        return [
            {
                "id": field_id,
                "area": area,
                "name": name,
                "description": description,
                "read_min_level": min(rows.get(field_id, (4, 4, [], []))[0], 4),
                "write_min_level": min(rows.get(field_id, (4, 4, [], []))[1], 4),
                "read_scope_ids": rows.get(field_id, (4, 4, [], []))[2],
                "write_scope_ids": rows.get(field_id, (4, 4, [], []))[3],
            }
            for field_id, area, name, description in self._field_catalog()
        ]

    def create_field(
        self,
        area: str,
        name: str,
        description: str,
        read_min_level: int,
        write_min_level: int,
        read_scope_ids: list[str],
        write_scope_ids: list[str],
    ) -> dict[str, Any]:
        field_id = f"custom.{uuid4()}"
        read_scopes = _validate_policy(read_min_level, read_scope_ids)
        write_scopes = _validate_policy(write_min_level, write_scope_ids, write=True)
        with sqlite3.connect(self.path) as connection:
            try:
                connection.execute(
                    "INSERT INTO authorization_custom_fields (id, area, name, description) VALUES (?, ?, ?, ?)",
                    (field_id, area, name, description),
                )
                connection.execute(
                    "INSERT INTO authorization_field_policies (field_id, read_role_ids, write_role_ids, read_min_level, write_min_level, read_scope_ids, write_scope_ids) VALUES (?, '[]', '[]', ?, ?, ?, ?)",
                    (field_id, read_min_level, write_min_level, json.dumps(read_scopes), json.dumps(write_scopes)),
                )
            except sqlite3.IntegrityError as error:
                raise ValueError("Field already exists") from error
        return next(field for field in self.list_field_policies() if field["id"] == field_id)

    def set_field_policy(
        self,
        field_id: str,
        read_min_level: int,
        write_min_level: int,
        read_scope_ids: list[str],
        write_scope_ids: list[str],
    ) -> dict[str, Any]:
        if field_id not in {field[0] for field in self._field_catalog()}:
            raise ValueError("Unknown field")
        read_scopes = _validate_policy(read_min_level, read_scope_ids)
        write_scopes = _validate_policy(write_min_level, write_scope_ids, write=True)
        with sqlite3.connect(self.path) as connection:
            connection.execute(
                "INSERT INTO authorization_field_policies (field_id, read_role_ids, write_role_ids, read_min_level, write_min_level, read_scope_ids, write_scope_ids) VALUES (?, '[]', '[]', ?, ?, ?, ?) ON CONFLICT(field_id) DO UPDATE SET read_min_level = excluded.read_min_level, write_min_level = excluded.write_min_level, read_scope_ids = excluded.read_scope_ids, write_scope_ids = excluded.write_scope_ids",
                (field_id, read_min_level, write_min_level, json.dumps(read_scopes), json.dumps(write_scopes)),
            )
        return next(field for field in self.list_field_policies() if field["id"] == field_id)

    def filter_readable_fields(
        self,
        payload: dict[str, Any],
        field_ids_by_key: dict[str, str],
        is_system_admin: bool,
        scope_levels: dict[str, int],
    ) -> dict[str, Any]:
        return {
            key: value
            for key, value in payload.items()
            if key not in field_ids_by_key or self._field_allowed(field_ids_by_key[key], is_system_admin, scope_levels, "read")
        }

    def can_write_field(self, field_id: str, is_system_admin: bool, scope_levels: dict[str, int]) -> bool:
        return self._field_allowed(field_id, is_system_admin, scope_levels, "write")

    def audit(
        self,
        action: str,
        *,
        actor_user_id: str | None,
        target_type: str,
        target_id: str,
        connection: sqlite3.Connection | None = None,
    ) -> None:
        with (nullcontext(connection) if connection is not None else sqlite3.connect(self.path)) as connection:
            connection.execute(
                "INSERT INTO authorization_audit_events (id, actor_user_id, action, target_type, target_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                (str(uuid4()), actor_user_id, action, target_type, target_id, datetime.now(UTC).isoformat()),
            )

    def list_audit_events(self) -> list[dict[str, Any]]:
        with sqlite3.connect(self.path) as connection:
            rows = connection.execute(
                "SELECT events.id, events.action, events.target_type, events.target_id, events.created_at, users.display_name FROM authorization_audit_events AS events LEFT JOIN identity_users AS users ON users.id = events.actor_user_id ORDER BY events.created_at DESC, events.rowid DESC LIMIT 200"
            ).fetchall()
        return [
            {
                "id": str(row[0]),
                "action": str(row[1]),
                "target_type": str(row[2]),
                "target_id": str(row[3]),
                "created_at": str(row[4]),
                "actor_name": str(row[5]) if row[5] is not None else None,
            }
            for row in rows
        ]

    def _field_allowed(self, field_id: str, is_system_admin: bool, scope_levels: dict[str, int], operation: str) -> bool:
        if field_id not in {field[0] for field in FIELD_CATALOG}:
            return False
        if is_system_admin:
            return True
        return scope_levels.get(field_id.split(".", 1)[0], 0) >= (2 if operation == "read" else 3)

    def _field_catalog(self) -> list[tuple[str, str, str, str]]:
        with sqlite3.connect(self.path) as connection:
            custom_fields = connection.execute(
                "SELECT id, area, name, description FROM authorization_custom_fields ORDER BY rowid"
            ).fetchall()
        return [*FIELD_CATALOG, *(tuple(str(value) for value in row) for row in custom_fields)]

def _validate_policy(min_level: int, scope_ids: list[str], *, write: bool = False) -> list[str]:
    if min_level not in ((3, 4) if write else (2, 3, 4)):
        raise ValueError("Field write permission must be edit or manage" if write else "Field read permission must be view, edit, or manage")
    normalized = list(dict.fromkeys(scope_ids))
    if any(scope_id not in SCOPE_IDS for scope_id in normalized):
        raise ValueError("Unknown access scope")
    return [scope_id for scope_id in SCOPE_IDS if scope_id in normalized]


def _legacy_policy(role_ids: list[str]) -> tuple[int, list[str]]:
    scopes = [scope_id for scope_id in WORKBENCH_SCOPE_IDS if scope_id in role_ids]
    if "knowledge-admin" in role_ids:
        scopes.append("knowledge")
    if "employee" in role_ids:
        scopes = list(SCOPE_IDS)
    return (2 if scopes else 4, scopes)
