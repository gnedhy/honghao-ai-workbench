from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from api.modules import ModuleId


AUTHORIZATION_SCHEMA_VERSION = 1
SYSTEM_ADMIN_ROLE_ID = "system-admin"

PERMISSIONS: tuple[tuple[str, ModuleId, str, str], ...] = (
    ("chat.use", "chat", "使用", "发起聊天和工作提交"),
    ("knowledge.view", "knowledge", "查看", "查看知识条目和原文件"),
    ("knowledge.manage", "knowledge", "管理", "发布和维护知识内容"),
    ("automation.view", "automation", "查看", "查看技能与工作流"),
    ("automation.manage", "automation", "管理", "维护技能与工作流"),
    ("workbench.view", "workbench", "查看", "进入职能工作台"),
    ("workbench.manage", "workbench", "管理", "执行工作台正式写入"),
    ("tasks.view", "tasks", "查看", "查看任务及运行记录"),
    ("tasks.manage", "tasks", "管理", "创建、恢复和取消任务"),
)

FIELD_CATALOG: tuple[tuple[str, str, str, str], ...] = (
    ("procurement.material_unit_price", "采购", "原料采购单价", "供应商确认后的含税采购单价"),
    ("procurement.supplier_quote", "采购", "供应商报价", "供应商原始报价与商务条件"),
    ("research.product_cost", "研发", "产品成本", "产品配方与工艺形成的成本结果"),
    ("sales.floor_price", "销售", "报价底价", "销售报价不可低于的内部控制价"),
    ("sales.gross_margin", "销售", "销售毛利率", "报价对应的内部毛利率"),
    ("management.operating_summary", "总经办", "经营汇总", "跨部门确认数据形成的经营汇总"),
)

_DEFAULT_ROLE_PERMISSIONS: dict[str, tuple[str, ...]] = {
    "employee": ("workbench.view",),
    "procurement": ("workbench.view",),
    "research": ("workbench.view",),
    "sales": ("workbench.view",),
    "management": ("workbench.view",),
    "knowledge-admin": ("workbench.view", "knowledge.view", "knowledge.manage"),
}


class AuthorizationStore:
    def __init__(self, path: Path) -> None:
        self.path = path

    def initialize(self) -> None:
        with sqlite3.connect(self.path) as connection:
            connection.execute(
                "CREATE TABLE IF NOT EXISTS authorization_role_permissions (role_id TEXT NOT NULL, permission_id TEXT NOT NULL, PRIMARY KEY (role_id, permission_id))"
            )
            connection.execute(
                "CREATE TABLE IF NOT EXISTS authorization_field_policies (field_id TEXT PRIMARY KEY, read_role_ids TEXT NOT NULL, write_role_ids TEXT NOT NULL)"
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
                connection.executemany(
                    "INSERT INTO authorization_role_permissions (role_id, permission_id) VALUES (?, ?)",
                    [
                        (role_id, permission_id)
                        for role_id, permission_ids in _DEFAULT_ROLE_PERMISSIONS.items()
                        for permission_id in permission_ids
                    ],
                )
            elif int(version[0]) != AUTHORIZATION_SCHEMA_VERSION:
                raise RuntimeError("Unsupported authorization schema version")

    def has_permission(self, role_ids: list[str], permission_id: str) -> bool:
        if SYSTEM_ADMIN_ROLE_ID in role_ids:
            return True
        if not role_ids:
            return False
        placeholders = ",".join("?" for _ in role_ids)
        with sqlite3.connect(self.path) as connection:
            row = connection.execute(
                f"SELECT 1 FROM authorization_role_permissions WHERE permission_id = ? AND role_id IN ({placeholders}) LIMIT 1",
                [permission_id, *role_ids],
            ).fetchone()
        return row is not None

    def permissions_for_role(self, role_id: str) -> list[str]:
        with sqlite3.connect(self.path) as connection:
            rows = connection.execute(
                "SELECT permission_id FROM authorization_role_permissions WHERE role_id = ? ORDER BY permission_id",
                (role_id,),
            ).fetchall()
        return [str(row[0]) for row in rows]

    def set_role_permissions(self, role_id: str, permission_ids: list[str]) -> list[str]:
        unique_ids = list(dict.fromkeys(permission_ids))
        known_ids = {permission[0] for permission in PERMISSIONS}
        if any(permission_id not in known_ids for permission_id in unique_ids):
            raise ValueError("Unknown permission")
        with sqlite3.connect(self.path) as connection:
            if connection.execute("SELECT 1 FROM identity_roles WHERE id = ?", (role_id,)).fetchone() is None:
                raise ValueError("Unknown role")
            connection.execute("BEGIN IMMEDIATE")
            connection.execute("DELETE FROM authorization_role_permissions WHERE role_id = ?", (role_id,))
            connection.executemany(
                "INSERT INTO authorization_role_permissions (role_id, permission_id) VALUES (?, ?)",
                [(role_id, permission_id) for permission_id in unique_ids],
            )
        return self.permissions_for_role(role_id)

    def list_field_policies(self) -> list[dict[str, Any]]:
        with sqlite3.connect(self.path) as connection:
            rows = {
                str(row[0]): (json.loads(str(row[1])), json.loads(str(row[2])))
                for row in connection.execute(
                    "SELECT field_id, read_role_ids, write_role_ids FROM authorization_field_policies"
                )
            }
        return [
            {
                "id": field_id,
                "area": area,
                "name": name,
                "description": description,
                "read_role_ids": rows.get(field_id, ([], []))[0],
                "write_role_ids": rows.get(field_id, ([], []))[1],
            }
            for field_id, area, name, description in FIELD_CATALOG
        ]

    def set_field_policy(
        self,
        field_id: str,
        read_role_ids: list[str],
        write_role_ids: list[str],
    ) -> dict[str, Any]:
        if field_id not in {field[0] for field in FIELD_CATALOG}:
            raise ValueError("Unknown field")
        read_ids = list(dict.fromkeys(read_role_ids))
        write_ids = list(dict.fromkeys(write_role_ids))
        with sqlite3.connect(self.path) as connection:
            self._ensure_roles_exist(connection, [*read_ids, *write_ids])
            connection.execute(
                "INSERT INTO authorization_field_policies (field_id, read_role_ids, write_role_ids) VALUES (?, ?, ?) ON CONFLICT(field_id) DO UPDATE SET read_role_ids = excluded.read_role_ids, write_role_ids = excluded.write_role_ids",
                (field_id, json.dumps(read_ids), json.dumps(write_ids)),
            )
        return next(field for field in self.list_field_policies() if field["id"] == field_id)

    def filter_readable_fields(
        self,
        payload: dict[str, Any],
        field_ids_by_key: dict[str, str],
        role_ids: list[str],
    ) -> dict[str, Any]:
        return {
            key: value
            for key, value in payload.items()
            if key not in field_ids_by_key or self._field_allowed(field_ids_by_key[key], role_ids, "read_role_ids")
        }

    def can_write_field(self, field_id: str, role_ids: list[str]) -> bool:
        return self._field_allowed(field_id, role_ids, "write_role_ids")

    def audit(
        self,
        action: str,
        *,
        actor_user_id: str | None,
        target_type: str,
        target_id: str,
    ) -> None:
        with sqlite3.connect(self.path) as connection:
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

    def _field_allowed(self, field_id: str, role_ids: list[str], column: str) -> bool:
        if SYSTEM_ADMIN_ROLE_ID in role_ids:
            return True
        if not role_ids:
            return False
        with sqlite3.connect(self.path) as connection:
            row = connection.execute(
                f"SELECT {column} FROM authorization_field_policies WHERE field_id = ?",
                (field_id,),
            ).fetchone()
        return row is not None and bool(set(json.loads(str(row[0]))) & set(role_ids))

    @staticmethod
    def _ensure_roles_exist(connection: sqlite3.Connection, role_ids: list[str]) -> None:
        unique_ids = list(dict.fromkeys(role_ids))
        if not unique_ids:
            return
        placeholders = ",".join("?" for _ in unique_ids)
        row = connection.execute(
            f"SELECT COUNT(*) FROM identity_roles WHERE id IN ({placeholders})",
            unique_ids,
        ).fetchone()
        if row is None or int(row[0]) != len(unique_ids):
            raise ValueError("Unknown role")


def permission_for_request(module_id: ModuleId, method: str) -> str:
    if module_id == "chat":
        return "chat.use"
    operation = "view" if method == "GET" else "manage"
    return f"{module_id}.{operation}"
