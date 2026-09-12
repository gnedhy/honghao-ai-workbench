from __future__ import annotations

import csv
import io
import json
import re
import sqlite3
from collections import Counter
from datetime import UTC, date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Request, UploadFile, File, Form, status
from pydantic import BaseModel, Field

from api.authorization import AuthorizationStore
from api.identity import IdentityStore
from api.settings import Settings
from api import procurement_collaboration as collaboration


PROCUREMENT_SCHEMA_VERSION = 7
SHANGHAI = timezone(timedelta(hours=8), "Asia/Shanghai")
EDITABLE_UPDATE_STATUSES = ("draft", "returned", "submitted")
DEFAULT_LEDGER_COLUMNS = ["inventory_quantity", "unit", "latest_price", "inventory_price", "change", "price_date", "modifier", "status"]
ALLOWED_LEDGER_COLUMNS = set(DEFAULT_LEDGER_COLUMNS) | {"in_transit_price", "previous_latest_price", "suggested_price"}
PRICE_FIELD_ID = "procurement.material_unit_price"
PRICE_KEYS = {
    "comparison": PRICE_FIELD_ID,
    "ledger_comparison": PRICE_FIELD_ID,
    "raw_price": PRICE_FIELD_ID,
    "previous_raw": PRICE_FIELD_ID,
    "before": PRICE_FIELD_ID,
    "after": PRICE_FIELD_ID,
    "priced": PRICE_FIELD_ID,
    "published_price": PRICE_FIELD_ID,
    "draft_price": PRICE_FIELD_ID,
    "draft_change": PRICE_FIELD_ID,
    "latest_price": PRICE_FIELD_ID,
    "previous_latest_price": PRICE_FIELD_ID,
    "previous_published_price": PRICE_FIELD_ID,
    "previous_price": PRICE_FIELD_ID,
    "change": PRICE_FIELD_ID,
    "price": PRICE_FIELD_ID,
    "up_count": PRICE_FIELD_ID,
    "down_count": PRICE_FIELD_ID,
    "flat_count": PRICE_FIELD_ID,
    "missing_count": PRICE_FIELD_ID,
    "inventory_price": PRICE_FIELD_ID,
    "inventory_quantity": PRICE_FIELD_ID,
    "in_transit_price": PRICE_FIELD_ID,
    "suggested_price": PRICE_FIELD_ID,
    "recommended_price": PRICE_FIELD_ID,
}
HISTORY_PRICE_KEYS = {
    "latest_price": "procurement.supplier_quote",
    "inventory_price": "procurement.supplier_quote",
    "in_transit_price": "procurement.supplier_quote",
    "previous_price": "procurement.supplier_quote",
    "change": "procurement.supplier_quote",
}
ISSUE_LABELS = {
    "missing_price": "缺少可用价格",
    "duplicate_code": "导入内容存在重复编码",
    "unit_conflict": "计量单位冲突",
    "price_spike": "最新价波动超过 15%",
}


class PriceConfirmation(BaseModel):
    baseline_id: str | None
    references: dict[str, Decimal | None]


class DelimitedImportRequest(BaseModel):
    update_id: str | None = None
    updated_at: str | None = None
    source_name: str = Field(min_length=1, max_length=120)
    effective_date: date
    content: str = Field(min_length=1, max_length=1_000_000)
    price_confirmation: PriceConfirmation | None = None
    reason: str = Field(default="已核对导入报价及价格波动", min_length=4, max_length=200)


class ProcurementPreferencesRequest(BaseModel):
    ledger_columns: list[str]
    history_view: str = Field(pattern="^(batches|materials)$")
    ledger_view: str = Field(pattern="^(scroll|paged)$")
    ledger_page_size: int = Field(ge=10, le=200)


class MaterialIdentityRequest(BaseModel):
    code: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=120)


class MaterialCreateRequest(BaseModel):
    model_config = {"extra": "forbid"}
    code: str = Field(min_length=1, max_length=64)
    name: str = Field(default="", max_length=120)
    department_ids: list[str] = Field(default_factory=list, max_length=100)
    price: Decimal | None = Field(default=None, ge=0)
    effective_date: date | None = None
    reason: str = Field(default="", max_length=200)
    update_id: str | None = None
    updated_at: str | None = None
    baseline_id: str | None = None


class PriceAdjustmentRequest(BaseModel):
    updated_at: str | None = None
    price: Decimal = Field(ge=0)
    effective_date: date
    reason: str = Field(min_length=4, max_length=200)
    target_history_id: str | None = None
    price_confirmation: PriceConfirmation | None = None


class BulkPriceItem(BaseModel):
    material_id: str = Field(min_length=1)
    price: Decimal = Field(ge=0, allow_inf_nan=False)


class BulkPriceAdjustmentRequest(BaseModel):
    update_id: str | None
    updated_at: str | None
    effective_date: date
    reason: str = Field(min_length=4, max_length=200)
    items: list[BulkPriceItem] = Field(min_length=1, max_length=10000)
    price_confirmation: PriceConfirmation | None = None


class PricePreviewRequest(BaseModel):
    effective_date: date
    items: list[BulkPriceItem] = Field(min_length=1, max_length=10000)


class UpdateReasonRequest(BaseModel):
    updated_at: str | None = None
    reason: str = Field(min_length=4, max_length=200)


class ScheduleCancelRequest(UpdateReasonRequest):
    copy_to_draft: bool = False


class PublishUpdateRequest(BaseModel):
    updated_at: str | None = None
    baseline_id: str | None = None
    mode: str = Field(pattern="^(immediate|scheduled)$")
    activate_at: datetime | None = None


class ActivationGrantRequest(BaseModel):
    enabled: bool
    manager: bool | None = None


class DepartmentMaterialsRequest(BaseModel):
    material_ids: list[str] = Field(max_length=10000)


class ProcurementStore:
    def __init__(self, path: Path) -> None:
        self.path = path

    def initialize(self) -> None:
        with sqlite3.connect(self.path) as connection:
            version = connection.execute(
                "SELECT value FROM schema_metadata WHERE key = ?",
                ("workbench_procurement_schema_version",),
            ).fetchone()
            if version is None:
                connection.executescript(
                    """
                    CREATE TABLE procurement_materials (
                        id TEXT PRIMARY KEY,
                        code TEXT NOT NULL UNIQUE,
                        name TEXT NOT NULL,
                        unit TEXT NOT NULL,
                        latest_price TEXT,
                        inventory_price TEXT,
                        in_transit_price TEXT,
                        previous_latest_price TEXT,
                        last_import_id TEXT,
                        updated_at TEXT NOT NULL
                    );
                    CREATE TABLE procurement_imports (
                        id TEXT PRIMARY KEY,
                        source_name TEXT NOT NULL,
                        received_count INTEGER NOT NULL,
                        imported_count INTEGER NOT NULL,
                        skipped_count INTEGER NOT NULL,
                        created_by TEXT NOT NULL,
                        created_at TEXT NOT NULL
                    );
                    CREATE TABLE procurement_issues (
                        id TEXT PRIMARY KEY,
                        material_id TEXT NOT NULL,
                        kind TEXT NOT NULL,
                        status TEXT NOT NULL CHECK (status IN ('open', 'reviewed', 'resolved')),
                        created_at TEXT NOT NULL,
                        reviewed_by TEXT,
                        reviewed_at TEXT
                    );
                    CREATE UNIQUE INDEX procurement_open_issue
                    ON procurement_issues(material_id, kind)
                    WHERE status = 'open';
                    CREATE TABLE procurement_price_history (
                        id TEXT PRIMARY KEY,
                        material_id TEXT NOT NULL,
                        import_id TEXT NOT NULL,
                        latest_price TEXT,
                        inventory_price TEXT,
                        in_transit_price TEXT,
                        recorded_at TEXT NOT NULL
                    );
                    CREATE TABLE procurement_price_batches (
                        id TEXT PRIMARY KEY,
                        version INTEGER NOT NULL UNIQUE,
                        published_by TEXT NOT NULL,
                        published_at TEXT NOT NULL,
                        item_count INTEGER NOT NULL
                    );
                    CREATE TABLE procurement_price_batch_items (
                        batch_id TEXT NOT NULL,
                        material_id TEXT NOT NULL,
                        code TEXT NOT NULL,
                        name TEXT NOT NULL,
                        unit TEXT NOT NULL,
                        latest_price TEXT,
                        inventory_price TEXT,
                        in_transit_price TEXT,
                        recommended_price TEXT,
                        PRIMARY KEY (batch_id, material_id)
                    );
                    CREATE TABLE procurement_working_state (
                        id INTEGER PRIMARY KEY CHECK (id = 1),
                        latest_import_id TEXT,
                        submitted_by TEXT,
                        submitted_at TEXT
                    );
                    INSERT INTO procurement_working_state VALUES (1, NULL, NULL, NULL);
                    """
                )
                connection.execute(
                    "INSERT INTO schema_metadata (key, value) VALUES (?, ?)",
                    ("workbench_procurement_schema_version", 1),
                )
                version = (1,)
            if int(version[0]) == 1:
                self._migrate_v2(connection)
                version = (2,)
            if int(version[0]) == 2:
                self._migrate_v3(connection)
                version = (3,)
            if int(version[0]) == 3:
                self._migrate_v4(connection)
                version = (4,)
            if int(version[0]) == 4:
                collaboration.initialize(connection)
                connection.execute("UPDATE schema_metadata SET value=5 WHERE key='workbench_procurement_schema_version'")
                version = (5,)
            if int(version[0]) == 5:
                from api.procurement_inventory import initialize
                initialize(connection)
                version = (6,)
            if int(version[0]) == 6:
                from api.procurement_rd5 import initialize
                initialize(connection)
                version = (7,)
            if int(version[0]) != PROCUREMENT_SCHEMA_VERSION:
                raise RuntimeError("Unsupported procurement workbench schema version")

    @staticmethod
    def _migrate_v2(connection: sqlite3.Connection) -> None:
        connection.executescript(
            """
            ALTER TABLE procurement_imports ADD COLUMN effective_date TEXT;
            ALTER TABLE procurement_imports ADD COLUMN archived_at TEXT;
            ALTER TABLE procurement_imports ADD COLUMN archived_by TEXT;
            ALTER TABLE procurement_materials ADD COLUMN archived_at TEXT;
            ALTER TABLE procurement_materials ADD COLUMN archived_by TEXT;
            CREATE TABLE procurement_price_adjustments (
                id TEXT PRIMARY KEY,
                material_id TEXT NOT NULL,
                target_history_id TEXT,
                replacement_history_id TEXT NOT NULL UNIQUE,
                reason TEXT NOT NULL,
                created_by TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE UNIQUE INDEX procurement_adjustment_target
            ON procurement_price_adjustments(target_history_id)
            WHERE target_history_id IS NOT NULL;
            CREATE TABLE procurement_user_preferences (
                user_id TEXT PRIMARY KEY,
                ledger_columns TEXT NOT NULL,
                history_view TEXT NOT NULL CHECK (history_view IN ('batches', 'materials')),
                updated_at TEXT NOT NULL
            );
            """
        )
        rows = connection.execute("SELECT id, source_name, created_at FROM procurement_imports").fetchall()
        connection.executemany(
            "UPDATE procurement_imports SET effective_date = ? WHERE id = ?",
            [(_recorded_at(str(row[1]), str(row[2]))[:10], str(row[0])) for row in rows],
        )
        connection.execute(
            "UPDATE schema_metadata SET value = ? WHERE key = ?",
            (2, "workbench_procurement_schema_version"),
        )

    @staticmethod
    def _migrate_v3(connection: sqlite3.Connection) -> None:
        connection.executescript(
            """
            ALTER TABLE procurement_user_preferences ADD COLUMN ledger_view TEXT NOT NULL DEFAULT 'scroll'
                CHECK (ledger_view IN ('scroll', 'paged'));
            ALTER TABLE procurement_user_preferences ADD COLUMN ledger_page_size INTEGER NOT NULL DEFAULT 50
                CHECK (ledger_page_size BETWEEN 10 AND 200);
            CREATE TABLE procurement_material_aliases (
                alias_code TEXT PRIMARY KEY,
                material_id TEXT NOT NULL,
                created_by TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE INDEX procurement_material_alias_material
            ON procurement_material_aliases(material_id);
            CREATE TABLE procurement_material_identity_changes (
                id TEXT PRIMARY KEY,
                material_id TEXT NOT NULL,
                old_code TEXT NOT NULL,
                new_code TEXT NOT NULL,
                old_name TEXT NOT NULL,
                new_name TEXT NOT NULL,
                created_by TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            """
        )
        connection.execute(
            "UPDATE schema_metadata SET value = ? WHERE key = ?",
            (PROCUREMENT_SCHEMA_VERSION, "workbench_procurement_schema_version"),
        )

    @staticmethod
    def _migrate_v4(connection: sqlite3.Connection) -> None:
        connection.executescript(
            """
            CREATE TABLE procurement_updates (
                id TEXT PRIMARY KEY,
                price_date TEXT NOT NULL,
                source_name TEXT NOT NULL,
                created_by TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                status TEXT NOT NULL CHECK (status IN (
                    'draft', 'returned', 'submitted', 'scheduled',
                    'revalidation_required', 'published', 'cancelled'
                )),
                submitted_by TEXT,
                submitted_at TEXT,
                return_reason TEXT,
                scheduled_activate_at TEXT,
                base_batch_id TEXT,
                published_batch_id TEXT,
                cancelled_by TEXT,
                cancelled_at TEXT,
                cancel_reason TEXT
            );
            CREATE INDEX procurement_updates_status ON procurement_updates(status, updated_at DESC);
            CREATE TABLE procurement_update_items (
                update_id TEXT NOT NULL,
                material_id TEXT NOT NULL,
                code TEXT NOT NULL,
                name TEXT NOT NULL,
                unit TEXT NOT NULL,
                latest_price TEXT,
                inventory_price TEXT,
                in_transit_price TEXT,
                recommended_price TEXT,
                PRIMARY KEY (update_id, material_id)
            );
            CREATE TABLE procurement_update_events (
                id TEXT PRIMARY KEY,
                update_id TEXT NOT NULL,
                event TEXT NOT NULL,
                actor_user_id TEXT,
                reason TEXT,
                created_at TEXT NOT NULL
            );
            CREATE INDEX procurement_update_events_update ON procurement_update_events(update_id, created_at DESC);
            ALTER TABLE procurement_imports ADD COLUMN update_id TEXT;
            ALTER TABLE procurement_issues ADD COLUMN update_id TEXT;
            ALTER TABLE procurement_issues ADD COLUMN review_reason TEXT;
            ALTER TABLE procurement_price_adjustments ADD COLUMN update_id TEXT;
            ALTER TABLE procurement_price_batches ADD COLUMN update_id TEXT;
            ALTER TABLE procurement_price_batches ADD COLUMN price_date TEXT;
            ALTER TABLE procurement_price_batches ADD COLUMN activated_at TEXT;
            ALTER TABLE procurement_price_batches ADD COLUMN submitted_by TEXT;
            ALTER TABLE procurement_price_batches ADD COLUMN source_name TEXT;
            ALTER TABLE procurement_price_batches ADD COLUMN base_batch_id TEXT;
            """
        )
        now = datetime.now(UTC).isoformat()
        state = connection.execute(
            "SELECT latest_import_id, submitted_by, submitted_at FROM procurement_working_state WHERE id = 1"
        ).fetchone()
        if state and state[0]:
            imported = connection.execute(
                "SELECT source_name, effective_date, created_by, created_at FROM procurement_imports WHERE id = ?",
                (state[0],),
            ).fetchone()
            if imported:
                update_id = str(uuid4())
                status_value = "submitted" if state[2] else "draft"
                connection.execute(
                    """INSERT INTO procurement_updates (
                           id, price_date, source_name, created_by, created_at, updated_at, status,
                           submitted_by, submitted_at
                       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (update_id, str(imported[1]), str(imported[0]), str(imported[2]), str(imported[3]), now, status_value, state[1], state[2]),
                )
                connection.execute(
                    "UPDATE procurement_imports SET update_id = ? WHERE effective_date = ? AND archived_at IS NULL",
                    (update_id, imported[1]),
                )
                connection.execute(
                    "UPDATE procurement_price_adjustments SET update_id = ? WHERE replacement_history_id IN (SELECT id FROM procurement_price_history WHERE import_id IN (SELECT id FROM procurement_imports WHERE update_id = ?))",
                    (update_id, update_id),
                )
                connection.execute(
                    "UPDATE procurement_issues SET update_id = ? WHERE status != 'resolved'",
                    (update_id,),
                )
                connection.execute(
                    "INSERT INTO procurement_update_events VALUES (?, ?, 'migrated', ?, NULL, ?)",
                    (str(uuid4()), update_id, imported[2], now),
                )
        connection.execute(
            """UPDATE procurement_price_batches
               SET activated_at = published_at,
                   price_date = COALESCE(price_date, substr(published_at, 1, 10)),
                   source_name = COALESCE(source_name, '历史迁移')"""
        )
        connection.execute(
            "UPDATE schema_metadata SET value = ? WHERE key = ?",
            (PROCUREMENT_SCHEMA_VERSION, "workbench_procurement_schema_version"),
        )

    def schema_version(self) -> int:
        with sqlite3.connect(self.path) as connection:
            row = connection.execute(
                "SELECT value FROM schema_metadata WHERE key = ?",
                ("workbench_procurement_schema_version",),
            ).fetchone()
        if row is None:
            raise RuntimeError("Procurement workbench schema is not initialized")
        return int(row[0])

    def preview_import(self, content: str, effective_date: date | None = None) -> dict[str, Any]:
        with sqlite3.connect(self.path) as connection:
            baseline_id = self._latest_batch_id(connection)
        existing = self._materials_by_code()
        rows = _parse_delimited(content)
        counts = Counter(row["code"] for row in rows)
        preview_rows = []
        for row in rows:
            issues: list[str] = list(row.get("validation_issues", []))
            current = existing.get(row["code"])
            if current is None:
                issues.append("unknown_code")
            if counts[row["code"]] > 1:
                issues.append("duplicate_code")
            if current is not None and current["unit"] != row["unit"]:
                issues.append("unit_conflict")
            suggested = row["latest_price"]
            if suggested is None:
                issues.append("missing_price")
            previous = current["latest_price"] if current is not None else row["previous_latest_price"]
            if current is not None and effective_date is not None:
                with sqlite3.connect(self.path) as connection:
                    previous = _decimal(self._reference_for_date(connection, effective_date.isoformat(), current["id"]))
            if _has_price_spike(row["latest_price"], previous):
                issues.append("price_spike")
            preview_rows.append({
                **_serialize_import_row(row),
                "suggested_price": _decimal_text(suggested),
                "reference_price": _decimal_text(_decimal(previous)),
                "change": _change(row["latest_price"], previous),
                "issues": issues,
                "importable": not any(issue in {"duplicate_code", "unit_conflict", "unknown_code", "missing_price", "invalid_price", "invalid_identity"} for issue in issues),
            })
        return {
            "received_count": len(preview_rows),
            "baseline_id": baseline_id,
            "importable_count": sum(1 for row in preview_rows if row["importable"]),
            "skipped_count": sum(1 for row in preview_rows if any(i in {"duplicate_code", "unit_conflict", "unknown_code", "invalid_price", "invalid_identity"} for i in row["issues"])),
            "blank_count": sum(1 for row in preview_rows if "missing_price" in row["issues"]),
            "rows": preview_rows,
        }

    @staticmethod
    def _event(connection: sqlite3.Connection, update_id: str, event: str, actor_user_id: str | None, reason: str | None = None) -> str:
        event_id = str(uuid4())
        connection.execute(
            "INSERT INTO procurement_update_events VALUES (?, ?, ?, ?, ?, ?)",
            (event_id, update_id, event, actor_user_id, reason, datetime.now(UTC).isoformat()),
        )

        connection.execute("UPDATE procurement_updates SET updated_at=? WHERE id=?", (datetime.now(UTC).isoformat(), update_id))
        return event_id

    @staticmethod
    def _editable_update(connection: sqlite3.Connection) -> tuple[Any, ...] | None:
        return connection.execute(
            """SELECT id, price_date, status, submitted_by, submitted_at
               FROM procurement_updates
               WHERE status IN ('draft', 'returned', 'submitted')
               ORDER BY created_at DESC LIMIT 1"""
        ).fetchone()

    def _ensure_editable_update(
        self,
        connection: sqlite3.Connection,
        price_date: str,
        source_name: str,
        actor_user_id: str,
        now: str,
    ) -> str:
        current = self._editable_update(connection)
        if current:
            if str(current[2]) == "submitted":
                raise RuntimeError("当前批次已提交，负责人退回后才能修改")
            if str(current[1]) != price_date:
                raise RuntimeError(f"已有 {current[1]} 的本轮更新，请先完成或取消后再录入新日期")
            update_id = str(current[0])
            connection.execute(
                """UPDATE procurement_updates SET source_name = ?, status = 'draft', updated_at = ?,
                   return_reason = CASE WHEN status = 'returned' THEN return_reason ELSE NULL END
                   WHERE id = ?""",
                (source_name.strip(), now, update_id),
            )
            return update_id
        update_id = str(uuid4())
        connection.execute(
            """INSERT INTO procurement_updates (
                   id, price_date, source_name, created_by, created_at, updated_at, status
               ) VALUES (?, ?, ?, ?, ?, ?, 'draft')""",
            (update_id, price_date, source_name.strip(), actor_user_id, now, now),
        )
        self._event(connection, update_id, "created", actor_user_id)
        return update_id

    def confirm_import(self, source_name: str, effective_date: date, content: str, actor_user_id: str, price_confirmation: PriceConfirmation | None = None, reason: str = "已核对导入报价及价格波动", *, revision: tuple | None = None) -> dict[str, Any]:
        preview = self.preview_import(content, effective_date)
        if preview["skipped_count"]:
            raise ValueError("存在重复、未知编号或单位冲突，请先维护目录或修正文件")
        if not preview["importable_count"]:
            raise ValueError("没有有效新价格；空白不会清除现价")
        import_id = str(uuid4())
        now = datetime.now(UTC).isoformat()
        recorded_at = f"{effective_date.isoformat()}T00:00:00+00:00"
        imported_count = 0
        with sqlite3.connect(self.path) as connection:
            connection.execute("BEGIN IMMEDIATE")
            if revision is not None:
                self._check_revision(connection, *revision)
            collaboration.require_current(self.path, actor_user_id, "can_edit")
            if price_confirmation is not None:
                collaboration.require_current(self.path, actor_user_id, "can_activate")
            update_id = self._ensure_editable_update(
                connection, effective_date.isoformat(), source_name, actor_user_id, now
            )
            changes = []
            for row in preview["rows"]:
                if not row["importable"]:
                    continue
                existing = self._material_for_code(connection, row["code"])
                if not existing or existing[3] != row["unit"]:
                    raise RuntimeError("原料目录或单位已变化，请重新预览；价格输入未保存")
                material_id = str(existing[0])
                before = connection.execute("SELECT latest_price FROM procurement_update_items WHERE update_id=? AND material_id=?", (update_id, material_id)).fetchone()
                if before is None:
                    before = connection.execute("SELECT latest_price FROM procurement_price_batch_items WHERE batch_id=? AND material_id=?", (self._latest_batch_id(connection), material_id)).fetchone()
                changes.append((material_id, before[0] if before else None, row["latest_price"]))
                previous_latest = str(existing[2]) if existing[2] is not None else row["previous_latest_price"]
                same_period = connection.execute(
                    """SELECT m.previous_latest_price FROM procurement_materials m JOIN procurement_imports i ON i.id=m.last_import_id
                       WHERE m.id=? AND i.effective_date=?""", (material_id, effective_date.isoformat()),
                ).fetchone()
                if same_period:
                    previous_latest = same_period[0]
                connection.execute(
                    """UPDATE procurement_materials SET latest_price = ?, inventory_price = ?,
                              in_transit_price = ?, previous_latest_price = ?, last_import_id = ?, updated_at = ?
                       WHERE id = ?""",
                    (row["latest_price"], row["inventory_price"], row["in_transit_price"], previous_latest, import_id, now, material_id),
                )
                connection.execute(
                    "INSERT INTO procurement_price_history VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (
                        str(uuid4()),
                        material_id,
                        import_id,
                        row["latest_price"],
                        row["inventory_price"],
                        row["in_transit_price"],
                        recorded_at,
                    ),
                )
                self._save_candidate(connection, update_id, material_id)
                imported_count += 1
            connection.execute(
                """INSERT INTO procurement_imports (
                    id, source_name, received_count, imported_count, skipped_count,
                    created_by, created_at, effective_date, archived_at, archived_by, update_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)""",
                (
                    import_id,
                    source_name.strip(),
                    preview["received_count"],
                    imported_count,
                    preview["received_count"] - imported_count,
                    actor_user_id,
                    now,
                    recorded_at[:10],
                    update_id,
                ),
            )
            connection.execute(
                "UPDATE procurement_working_state SET latest_import_id = ?, submitted_by = NULL, submitted_at = NULL WHERE id = 1",
                (import_id,),
            )
            changed_ids = {change[0] for change in changes}
            self._refresh_update_issues(connection, update_id, now, changed_ids)
            if price_confirmation is not None:
                references = {str(self._material_for_code(connection, code)[0]): value for code, value in price_confirmation.references.items() if self._material_for_code(connection, code)}
                self._confirm_saved_risks(connection, update_id, changed_ids, PriceConfirmation(baseline_id=price_confirmation.baseline_id, references=references), reason, actor_user_id)
            event_id = self._event(connection, update_id, "imported", actor_user_id, reason.strip())
            collaboration.record_changes(connection, event_id, update_id, actor_user_id, effective_date.isoformat(), changes)
        return {
            "id": import_id,
            "source_name": source_name.strip(),
            "received_count": preview["received_count"],
            "imported_count": imported_count,
            "skipped_count": preview["received_count"] - imported_count,
            "created_at": now,
            "update_id": update_id,
        }

    def overview(self) -> dict[str, Any]:
        with sqlite3.connect(self.path) as connection:
            inventory = {row[0]: row[1:] for row in connection.execute(
                "SELECT material_id, quantity, price FROM procurement_inventory"
            )}
            material_rows = connection.execute(
                """
                SELECT materials.id, materials.code, materials.name, materials.unit,
                       materials.latest_price, materials.inventory_price, materials.in_transit_price,
                       previous_latest_price, materials.updated_at, imports.effective_date
                FROM procurement_materials AS materials
                LEFT JOIN procurement_imports AS imports ON imports.id = materials.last_import_id
                WHERE materials.archived_at IS NULL AND (imports.archived_at IS NULL OR imports.id IS NULL)
                ORDER BY materials.code
                """
            ).fetchall()
            issue_rows = connection.execute(
                """
                SELECT issues.id, issues.material_id, materials.code, materials.name,
                       issues.kind, issues.status, issues.created_at, issues.reviewed_at
                FROM procurement_issues AS issues
                JOIN procurement_materials AS materials ON materials.id = issues.material_id
                WHERE materials.archived_at IS NULL
                ORDER BY CASE issues.status WHEN 'open' THEN 0 WHEN 'reviewed' THEN 1 ELSE 2 END,
                         issues.created_at DESC
                """
            ).fetchall()
            batch_rows = connection.execute(
                """SELECT id, version, published_at, item_count, price_date, activated_at,
                          source_name, submitted_by, published_by
                   FROM procurement_price_batches ORDER BY version DESC"""
            ).fetchall()
            current_batch_id = str(batch_rows[0][0]) if batch_rows else None
            previous_batch_id = str(batch_rows[1][0]) if len(batch_rows) > 1 else None
            published_rows = connection.execute(
                "SELECT material_id, latest_price FROM procurement_price_batch_items WHERE batch_id = ?",
                (current_batch_id,),
            ).fetchall() if current_batch_id else []
            previous_published_rows = connection.execute(
                "SELECT material_id, latest_price FROM procurement_price_batch_items WHERE batch_id = ?",
                (previous_batch_id,),
            ).fetchall() if previous_batch_id else []
            working_state = connection.execute(
                """
                SELECT state.submitted_by, state.submitted_at, submitter.display_name,
                       imports.id, imports.source_name, imports.effective_date, imports.imported_count,
                       imports.created_at, importer.display_name
                FROM procurement_working_state AS state
                LEFT JOIN identity_users AS submitter ON submitter.id = state.submitted_by
                LEFT JOIN procurement_imports AS imports ON imports.id = state.latest_import_id
                LEFT JOIN identity_users AS importer ON importer.id = imports.created_by
                WHERE state.id = 1
                """
            ).fetchone()
        materials = [_material_from_row(row) for row in material_rows]
        published_prices = {str(row[0]): row[1] for row in published_rows}
        previous_published_prices = {str(row[0]): row[1] for row in previous_published_rows}
        published_price_date = str(batch_rows[0][4]) if batch_rows and batch_rows[0][4] else None
        ledger_comparison = self.batch_comparison(current_batch_id, preserve_catalog=True) if current_batch_id else None
        active_update = self.current_update()
        scheduled_update = self.scheduled_update()
        sources = collaboration.snapshot_sources(self.path, current_batch_id)
        all_participants = collaboration.participants(self.path)
        round_participants = collaboration.participants(self.path, active_update["id"]) if active_update else {}
        pending = active_update or scheduled_update
        authorship = collaboration.price_authorship(self.path)
        official_authors = authorship["batches"].get(current_batch_id, {})
        pending_authors = authorship["updates"].get(pending["id"], {}) if pending else {}
        pending_prices = {item["material_id"]: item["draft_price"] for item in pending["items"]} if pending else {}
        for material in materials:
            material["inventory_quantity"] = None
            if material["id"] in inventory:
                material["inventory_quantity"], material["inventory_price"] = inventory[material["id"]]
            material["published_price"] = published_prices.get(material["id"])
            material["previous_published_price"] = ledger_comparison["items"].get(material["id"], {}).get("previous") if ledger_comparison else previous_published_prices.get(material["id"])
            material["published_price_date"] = published_price_date if material["published_price"] is not None else None
            if material["id"] in sources:
                material["published_price_date"] = sources[material["id"]]["price_date"]
            material["reported"] = bool(material["published_price_date"] and material["published_price_date"] == published_price_date)
            material["participants"] = all_participants.get(material["id"], [])
            material["round_participants"] = round_participants.get(material["id"], [])
            material["price_modifier"] = pending_authors.get(material["id"], official_authors.get(material["id"]))
            material["source_purchasers"] = authorship["purchasers"].get(material["id"], [])
            if pending:
                material["draft_price"] = pending_prices.get(material["id"], material["published_price"])
            else:
                material["draft_price"] = None
            reference = material["published_price"] if material["published_price"] is not None else material.get("previous_latest_price")
            material["draft_change"] = _change(material["draft_price"], reference) if active_update or scheduled_update else None
            material["draft_status"] = active_update["status"] if active_update else (scheduled_update["status"] if scheduled_update else None)
        issues = [_issue_from_row(row) for row in issue_rows]
        open_issues = [issue for issue in issues if issue["status"] == "open"]
        return {
            "metrics": {
                "material_count": len(materials),
                "open_issue_count": len(open_issues),
                "missing_price_count": sum(1 for issue in open_issues if issue["kind"] == "missing_price"),
                "published_batch_count": len(batch_rows),
            },
            "materials": materials,
            "ledger_comparison": ledger_comparison,
            "issues": issues,
            "batches": [
                {
                    "id": str(row[0]), "version": int(row[1]), "published_at": str(row[2]),
                    "item_count": int(row[3]), "price_date": row[4], "activated_at": row[5],
                    "source_name": row[6], "submitted_by": row[7], "published_by": row[8],
                    "status": "active" if str(row[0]) == current_batch_id else "historical",
                    "comparison": self.batch_comparison(str(row[0])),
                    "provenance": collaboration.provenance(self.path, str(row[0])),
                    "published_by_name": self._user_name(str(row[8])),
                }
                for row in batch_rows
            ],
            "current_update": active_update,
            "scheduled_update": scheduled_update,
            "working_state": {
                "status": "submitted" if working_state and working_state[1] else ("ready" if materials and not open_issues else "draft"),
                "submitted_by": str(working_state[0]) if working_state and working_state[0] is not None else None,
                "submitted_at": str(working_state[1]) if working_state and working_state[1] is not None else None,
                "submitted_by_name": str(working_state[2]) if working_state and working_state[2] is not None else None,
                "latest_import": {
                    "id": str(working_state[3]),
                    "source_name": str(working_state[4]),
                    "effective_date": str(working_state[5]),
                    "item_count": int(working_state[6]),
                    "created_at": str(working_state[7]),
                    "created_by_name": str(working_state[8]) if working_state[8] is not None else "—",
                } if working_state and working_state[3] is not None else None,
            },
        }

    def _user_name(self, user_id: str) -> str:
        with sqlite3.connect(self.path) as connection:
            row = connection.execute("SELECT display_name FROM identity_users WHERE id=?", (user_id,)).fetchone()
        return str(row[0]) if row else "未记录"

    def _batch_update_id(self, batch_id: str) -> str | None:
        with sqlite3.connect(self.path) as connection:
            row = connection.execute("SELECT update_id FROM procurement_price_batches WHERE id=?", (batch_id,)).fetchone()
        return row[0] if row else None

    def current_update(self) -> dict[str, Any] | None:
        with sqlite3.connect(self.path) as connection:
            row = connection.execute(
                """SELECT id FROM procurement_updates
                   WHERE status IN ('draft', 'returned', 'submitted', 'revalidation_required')
                   ORDER BY CASE status WHEN 'revalidation_required' THEN 1 ELSE 0 END, created_at DESC LIMIT 1"""
            ).fetchone()
        return self.get_update(str(row[0])) if row else None

    def scheduled_update(self) -> dict[str, Any] | None:
        with sqlite3.connect(self.path) as connection:
            row = connection.execute(
                "SELECT id FROM procurement_updates WHERE status = 'scheduled' ORDER BY updated_at DESC LIMIT 1"
            ).fetchone()
        return self.get_update(str(row[0])) if row else None

    def get_update(self, update_id: str) -> dict[str, Any] | None:
        with sqlite3.connect(self.path) as connection:
            update = connection.execute(
                """SELECT updates.id, updates.price_date, updates.source_name, updates.status,
                          updates.created_at, updates.updated_at, updates.submitted_at,
                          updates.return_reason, updates.scheduled_activate_at, updates.base_batch_id,
                          updates.published_batch_id, updates.cancel_reason,
                          COALESCE(creator.display_name, updates.created_by),
                          COALESCE(submitter.display_name, updates.submitted_by)
                   FROM procurement_updates AS updates
                   LEFT JOIN identity_users AS creator ON creator.id = updates.created_by
                   LEFT JOIN identity_users AS submitter ON submitter.id = updates.submitted_by
                   WHERE updates.id = ?""",
                (update_id,),
            ).fetchone()
            if update is None:
                return None
            official = dict(connection.execute(
                "SELECT material_id, latest_price FROM procurement_price_batch_items WHERE batch_id = ?",
                (self._latest_batch_id(connection),),
            ).fetchall())
            item_rows = [(*row[:5], official.get(row[0]), self._reference_price(connection, update_id, str(row[0])))
                         for row in self._candidate_snapshot(connection, update_id)]
            input_ids = {str(row[0]) for row in connection.execute(
                """SELECT material_id FROM procurement_update_items WHERE update_id = ?
                   UNION SELECT h.material_id FROM procurement_price_history h
                   JOIN procurement_imports i ON i.id = h.import_id
                   LEFT JOIN procurement_price_adjustments a ON a.target_history_id = h.id
                   WHERE i.update_id = ? AND i.archived_at IS NULL AND a.id IS NULL""",
                (update_id, update_id),
            ).fetchall()}
            issue_rows = connection.execute(
                """SELECT issues.id, issues.material_id, materials.code, materials.name, issues.kind,
                          issues.status, issues.created_at, issues.reviewed_at, issues.review_reason
                   FROM procurement_issues AS issues
                   JOIN procurement_materials AS materials ON materials.id = issues.material_id
                   WHERE issues.update_id = ? AND issues.status != 'resolved'
                   ORDER BY CASE issues.kind WHEN 'missing_price' THEN 0 ELSE 1 END, materials.code""",
                (update_id,),
            ).fetchall()
            event_rows = connection.execute(
                """SELECT events.event, COALESCE(users.display_name, events.actor_user_id),
                          events.reason, events.created_at, events.id
                   FROM procurement_update_events AS events
                   LEFT JOIN identity_users AS users ON users.id = events.actor_user_id
                   WHERE events.update_id = ? ORDER BY events.created_at DESC""",
                (update_id,),
            ).fetchall()
        items = [
            {
                "material_id": str(row[0]), "code": str(row[1]), "name": str(row[2]), "unit": str(row[3]),
                "draft_price": row[4], "published_price": row[5],
                "change": _change(row[4], row[5] if row[5] is not None else row[6]),
                "comparison_basis": "published" if row[5] is not None else "previous_inquiry" if row[6] is not None else "none",
            }
            for row in item_rows
        ]
        issues = [
            {
                "id": str(row[0]), "material_id": str(row[1]), "material_code": str(row[2]),
                "material_name": str(row[3]), "kind": str(row[4]), "status": str(row[5]),
                "label": ISSUE_LABELS.get(str(row[4]), str(row[4])), "created_at": str(row[6]),
                "reviewed_at": row[7], "review_reason": row[8],
            }
            for row in issue_rows
        ]
        changed = [item for item in items if _decimal(item["draft_price"]) != _decimal(item["published_price"])]
        return {
            "id": str(update[0]), "price_date": str(update[1]), "source_name": str(update[2]),
            "status": str(update[3]), "created_at": str(update[4]), "updated_at": str(update[5]),
            "submitted_at": update[6], "return_reason": update[7], "activate_at": update[8],
            "base_batch_id": update[9], "published_batch_id": update[10], "cancel_reason": update[11],
            "created_by_name": str(update[12]), "submitted_by_name": str(update[13]) if update[13] else None,
            "summary": {
                "coverage_count": len(items), "changed_count": len(changed),
                "unchanged_count": len(items) - len(changed),
                "error_count": sum(1 for issue in issues if issue["kind"] != "price_spike" and issue["status"] == "open"),
                "risk_count": sum(1 for issue in issues if issue["kind"] == "price_spike" and issue["status"] == "open"),
            },
            "items": changed,
            "input_items": [item for item in items if item["material_id"] in input_ids],
            "changes": collaboration.saved_events(self.path, update_id=update_id),
            "issues": issues,
            "events": [
                {"id": str(row[4]), "event": str(row[0]), "actor_name": str(row[1] or "系统"), "reason": row[2], "created_at": str(row[3])}
                for row in event_rows
            ],
        }

    def submit(self, actor_user_id: str) -> dict[str, Any]:
        now = datetime.now(UTC).isoformat()
        with sqlite3.connect(self.path) as connection:
            update = self._editable_update(connection)
            if update is None or str(update[2]) not in {"draft", "returned"}:
                raise ValueError("没有可提交的本轮更新")
            update_id = str(update[0])
            error_count = int(connection.execute(
                """SELECT COUNT(*) FROM procurement_issues
                   WHERE update_id = ? AND status = 'open' AND kind != 'price_spike'""",
                (update_id,),
            ).fetchone()[0])
            if error_count:
                raise ValueError(f"仍有 {error_count} 个数据错误，不能提交")
            connection.execute(
                "UPDATE procurement_working_state SET submitted_by = ?, submitted_at = ? WHERE id = 1",
                (actor_user_id, now),
            )
            connection.execute(
                """UPDATE procurement_updates SET status = 'submitted', submitted_by = ?,
                   submitted_at = ?, updated_at = ? WHERE id = ?""",
                (actor_user_id, now, now, update_id),
            )
            self._event(connection, update_id, "submitted", actor_user_id)
        return self.get_update(update_id) or {"id": update_id, "status": "submitted"}

    def review_issue(
        self,
        issue_id: str,
        actor_user_id: str,
        reason: str,
        expected_update_id: str | None = None,
        updated_at: str | None = None,
    ) -> dict[str, Any] | None:
        reason = reason.strip()
        if not 4 <= len(reason) <= 200:
            raise ValueError("高风险确认依据需填写 4–200 字")
        now = datetime.now(UTC).isoformat()
        with sqlite3.connect(self.path) as connection:
            connection.execute("BEGIN IMMEDIATE")
            issue = connection.execute(
                """SELECT issues.kind, issues.status, issues.update_id, updates.status
                   FROM procurement_issues AS issues
                   LEFT JOIN procurement_updates AS updates ON updates.id = issues.update_id
                   WHERE issues.id = ?""",
                (issue_id,),
            ).fetchone()
            if issue is None:
                return None
            collaboration.require_current(self.path, actor_user_id, "can_activate")
            if updated_at is not None:
                revision = connection.execute("SELECT updated_at FROM procurement_updates WHERE id=?", (issue[2],)).fetchone()
                if not revision or revision[0] != updated_at:
                    raise ValueError("本轮价格已变化，请刷新核对后重新确认")
            if expected_update_id is not None and str(issue[2] or "") != expected_update_id:
                return None
            if str(issue[0]) != "price_spike":
                raise ValueError("该问题必须通过补充或修正数据解决")
            if issue[2] is None or str(issue[3]) not in {"draft", "returned", "submitted", "revalidation_required"}:
                raise ValueError("当前批次不能确认价格波动")
            if str(issue[1]) == "open":
                connection.execute(
                    """UPDATE procurement_issues SET status = 'reviewed', reviewed_by = ?,
                       reviewed_at = ?, review_reason = ? WHERE id = ?""",
                    (actor_user_id, now, reason, issue_id),
                )
                self._event(connection, str(issue[2]), "risk_reviewed", actor_user_id, reason)
        update = self.get_update(str(issue[2]))
        return next((item for item in (update or {}).get("issues", []) if item["id"] == issue_id), None)

    def return_update(self, update_id: str, actor_user_id: str, reason: str) -> dict[str, Any]:
        reason = reason.strip()
        now = datetime.now(UTC).isoformat()
        with sqlite3.connect(self.path) as connection:
            changed = connection.execute(
                """UPDATE procurement_updates SET status = 'returned', return_reason = ?, updated_at = ?
                   WHERE id = ? AND status = 'submitted'""",
                (reason, now, update_id),
            ).rowcount
            if not changed:
                raise ValueError("只有已提交批次可以退回")
            connection.execute(
                "UPDATE procurement_working_state SET submitted_by = NULL, submitted_at = NULL WHERE id = 1"
            )
            self._event(connection, update_id, "returned", actor_user_id, reason)
        return self.get_update(update_id) or {"id": update_id, "status": "returned"}

    def cancel_update(self, update_id: str, actor_user_id: str, reason: str) -> dict[str, Any]:
        now = datetime.now(UTC).isoformat()
        with sqlite3.connect(self.path) as connection:
            connection.execute("BEGIN IMMEDIATE")
            collaboration.require_current(self.path, actor_user_id, "can_cancel_round")
            self._freeze_update(connection, update_id)
            changed = connection.execute(
                """UPDATE procurement_updates SET status = 'cancelled', cancelled_by = ?,
                   cancelled_at = ?, cancel_reason = ?, updated_at = ?
                   WHERE id = ? AND status IN ('draft', 'returned')""",
                (actor_user_id, now, reason.strip(), now, update_id),
            ).rowcount
            if not changed:
                raise ValueError("只有草稿或已退回批次可以取消")
            connection.execute(
                "UPDATE procurement_working_state SET latest_import_id = NULL, submitted_by = NULL, submitted_at = NULL WHERE id = 1"
            )
            connection.execute(
                "UPDATE procurement_issues SET status = 'resolved' WHERE update_id = ? AND status = 'open'",
                (update_id,),
            )
            self._event(connection, update_id, "cancelled", actor_user_id, reason.strip())
            for (material_id,) in connection.execute("SELECT material_id FROM procurement_update_items WHERE update_id=?", (update_id,)).fetchall():
                self._refresh_material_snapshot(connection, material_id)
        return self.get_update(update_id) or {"id": update_id, "status": "cancelled"}

    def price_history(self) -> list[dict[str, Any]]:
        with sqlite3.connect(self.path) as connection:
            rows = connection.execute(
                """
                SELECT history.id, materials.code, materials.name, materials.unit,
                       imports.source_name, history.latest_price, history.inventory_price,
                       history.in_transit_price, history.recorded_at
                FROM procurement_price_history AS history
                JOIN procurement_materials AS materials ON materials.id = history.material_id
                JOIN procurement_imports AS imports ON imports.id = history.import_id
                LEFT JOIN procurement_price_adjustments AS replacements
                  ON replacements.target_history_id = history.id
                WHERE materials.archived_at IS NULL AND imports.archived_at IS NULL
                  AND replacements.id IS NULL
                ORDER BY history.recorded_at DESC, materials.code
                """
            ).fetchall()
        return [
            {
                "id": str(row[0]),
                "material_code": str(row[1]),
                "material_name": str(row[2]),
                "unit": str(row[3]),
                "source_name": str(row[4]),
                "latest_price": row[5],
                "inventory_price": row[6],
                "in_transit_price": row[7],
                "recorded_at": str(row[8]),
            }
            for row in rows
        ]

    def history_batches(self, include_archived: bool = False) -> list[dict[str, Any]]:
        rows = self._active_history(include_archived=include_archived)
        dates = sorted({row["effective_date"] for row in rows}, reverse=True)
        by_date = {period: [row for row in rows if row["effective_date"] == period] for period in dates}
        chronological = sorted(dates)
        result = []
        for period in dates:
            current = {row["material_code"]: row for row in by_date[period]}
            earlier = [candidate for candidate in chronological if candidate < period]
            previous = {row["material_code"]: row for row in by_date[earlier[-1]]} if earlier else {}
            counts = _movement_counts(current, previous)
            sources = sorted({row["source_name"] for row in current.values()})
            creators = sorted({row["created_by_name"] for row in current.values()})
            created_at = max(row["created_at"] for row in current.values())
            result.append({
                "id": period,
                "effective_date": period,
                "source_name": sources[0] if len(sources) == 1 else f"{len(sources)} 个来源",
                "material_count": len(current),
                **counts,
                "created_by": creators[0] if len(creators) == 1 else f"{len(creators)} 人",
                "created_at": created_at,
            })
        return result

    def history_batch(self, batch_id: str, include_archived: bool = False) -> dict[str, Any] | None:
        batches = {item["id"]: item for item in self.history_batches(include_archived)}
        if batch_id not in batches:
            return None
        rows = self._active_history(include_archived=include_archived)
        dates = sorted({row["effective_date"] for row in rows})
        index = dates.index(batch_id)
        previous_date = dates[index - 1] if index else None
        previous = {row["material_code"]: row for row in rows if row["effective_date"] == previous_date}
        items = []
        for row in (row for row in rows if row["effective_date"] == batch_id):
            old = previous.get(row["material_code"])
            items.append({**row, "previous_price": old["latest_price"] if old else None, "change": _change(row["latest_price"], old["latest_price"] if old else None)})
        return {**batches[batch_id], "previous_date": previous_date, "items": items}

    def history_materials(self, include_archived: bool = False) -> list[dict[str, Any]]:
        rows = self._active_history(include_archived=include_archived)
        materials: dict[str, list[dict[str, Any]]] = {}
        for row in rows:
            materials.setdefault(row["material_id"], []).append(row)
        result = []
        for entries in materials.values():
            entries.sort(key=lambda item: (item["effective_date"], item["created_at"]))
            latest = entries[-1]
            previous = entries[-2] if len(entries) > 1 else None
            result.append({
                "material_id": latest["material_id"],
                "material_code": latest["material_code"],
                "material_name": latest["material_name"],
                "unit": latest["unit"],
                "period_count": len({item["effective_date"] for item in entries}),
                "latest_price": latest["latest_price"],
                "previous_price": previous["latest_price"] if previous else None,
                "change": _change(latest["latest_price"], previous["latest_price"] if previous else None),
                "latest_date": latest["effective_date"],
                "status": "missing" if latest["latest_price"] is None else "active",
                "trend": [{"date": item["effective_date"], "price": item["latest_price"]} for item in entries[-8:]],
            })
        return sorted(result, key=lambda item: item["material_code"])

    def material_detail(self, material_id: str, include_archived: bool = False) -> dict[str, Any] | None:
        rows = self._active_history(include_archived=include_archived, material_id=material_id)
        with sqlite3.connect(self.path) as connection:
            material = connection.execute(
                "SELECT id, code, name, unit, archived_at, updated_at, latest_price FROM procurement_materials WHERE id = ?",
                (material_id,),
            ).fetchone()
            adjustments = connection.execute(
                """SELECT adjustments.id, adjustments.target_history_id, adjustments.replacement_history_id,
                          adjustments.reason, users.display_name, adjustments.created_at
                   FROM procurement_price_adjustments AS adjustments
                   LEFT JOIN identity_users AS users ON users.id = adjustments.created_by
                   WHERE adjustments.material_id = ? ORDER BY adjustments.created_at DESC""",
                (material_id,),
            ).fetchall()
            official = connection.execute("""SELECT b.id,b.version,b.price_date,i.latest_price,
                s.price_date,s.raw_price,s.price_kind,s.sheet,s.cell
                FROM procurement_price_batches b JOIN procurement_price_batch_items i ON i.batch_id=b.id
                LEFT JOIN procurement_snapshot_sources s ON s.batch_id=b.id AND s.material_id=i.material_id
                WHERE i.material_id=? ORDER BY b.version""", (material_id,)).fetchall()
            sources = connection.execute("""SELECT s.sheet,s.source_row,s.raw_json,f.filename
                FROM procurement_material_sources s JOIN procurement_source_imports f ON f.sha256=s.sha256
                WHERE s.material_id=? ORDER BY s.sheet,s.source_row""", (material_id,)).fetchall()
        if material is None or (material[4] is not None and not include_archived):
            return None
        authorship = collaboration.price_authorship(self.path, material_id)["batches"]
        rows.sort(key=lambda item: (item["effective_date"], item["created_at"]))
        latest = rows[-1] if rows else None
        previous = rows[-2] if len(rows) > 1 else None
        return {
            "comparison": self.batch_comparison(official[-1][0], preserve_catalog=True)["items"].get(material_id) if official else None,
            "material": {"id": str(material[0]), "code": str(material[1]), "name": str(material[2]), "unit": str(material[3]), "archived": material[4] is not None, "updated_at": material[5]},
            "latest_price": latest["latest_price"] if latest else material[6],
            "previous_price": previous["latest_price"] if previous else None,
            "change": _change(latest["latest_price"] if latest else material[6], previous["latest_price"] if previous else None),
            "price_date": latest["effective_date"] if latest else None,
            "status": "missing" if latest is None or latest["latest_price"] is None else "active",
            "history": rows,
            "official_history": [{**dict(zip(("id","version","version_date","latest_price","price_date","raw_price","price_kind","sheet","cell"), row)), "modifier": authorship.get(row[0], {}).get(material_id)} for row in official],
            "sources": [{"sheet": r[0], "row": r[1], "purchaser": json.loads(r[2])[0], "filename": r[3]} for r in sources],
            "adjustments": [
                {"id": str(row[0]), "target_history_id": row[1], "replacement_history_id": str(row[2]), "reason": str(row[3]), "created_by": str(row[4] or "未知用户"), "created_at": str(row[5])}
                for row in adjustments
            ],
        }

    def preferences(self, user_id: str) -> dict[str, Any]:
        import json
        with sqlite3.connect(self.path) as connection:
            row = connection.execute(
                "SELECT ledger_columns, history_view, ledger_view, ledger_page_size FROM procurement_user_preferences WHERE user_id = ?",
                (user_id,),
            ).fetchone()
        return {
            "ledger_columns": json.loads(row[0]),
            "history_view": str(row[1]),
            "ledger_view": str(row[2]),
            "ledger_page_size": int(row[3]),
        } if row else {
            "ledger_columns": DEFAULT_LEDGER_COLUMNS,
            "history_view": "batches",
            "ledger_view": "paged",
            "ledger_page_size": 50,
        }

    def save_preferences(self, user_id: str, ledger_columns: list[str], history_view: str, ledger_view: str, ledger_page_size: int) -> dict[str, Any]:
        import json
        columns = list(dict.fromkeys(ledger_columns))
        if not columns or any(column not in ALLOWED_LEDGER_COLUMNS for column in columns):
            raise ValueError("列设置包含无效字段")
        now = datetime.now(UTC).isoformat()
        with sqlite3.connect(self.path) as connection:
            connection.execute(
                """INSERT INTO procurement_user_preferences (
                       user_id, ledger_columns, history_view, updated_at, ledger_view, ledger_page_size
                   ) VALUES (?, ?, ?, ?, ?, ?)
                   ON CONFLICT(user_id) DO UPDATE SET ledger_columns = excluded.ledger_columns,
                   history_view = excluded.history_view, updated_at = excluded.updated_at,
                   ledger_view = excluded.ledger_view, ledger_page_size = excluded.ledger_page_size""",
                (user_id, json.dumps(columns, ensure_ascii=False), history_view, now, ledger_view, ledger_page_size),
            )
        return {"ledger_columns": columns, "history_view": history_view, "ledger_view": ledger_view, "ledger_page_size": ledger_page_size}

    def update_material_identity(self, material_id: str, code: str, name: str, actor_user_id: str) -> dict[str, Any]:
        code = code.strip()
        name = name.strip()
        if not code or not name:
            raise ValueError("原料编号和名称不能为空")
        now = datetime.now(UTC).isoformat()
        with sqlite3.connect(self.path) as connection:
            material = connection.execute(
                "SELECT code, name FROM procurement_materials WHERE id = ? AND archived_at IS NULL",
                (material_id,),
            ).fetchone()
            if material is None:
                raise LookupError("Material not found")
            old_code, old_name = str(material[0]), str(material[1])
            if code != old_code:
                current = connection.execute(
                    "SELECT id FROM procurement_materials WHERE code = ? AND id != ?",
                    (code, material_id),
                ).fetchone()
                alias = connection.execute(
                    "SELECT material_id FROM procurement_material_aliases WHERE alias_code = ?",
                    (code,),
                ).fetchone()
                if current is not None or (alias is not None and str(alias[0]) != material_id):
                    raise RuntimeError("原料编号已被使用")
                if alias is not None:
                    connection.execute("DELETE FROM procurement_material_aliases WHERE alias_code = ?", (code,))
                connection.execute(
                    "INSERT OR IGNORE INTO procurement_material_aliases VALUES (?, ?, ?, ?)",
                    (old_code, material_id, actor_user_id, now),
                )
            connection.execute(
                "UPDATE procurement_materials SET code = ?, name = ?, updated_at = ? WHERE id = ?",
                (code, name, now, material_id),
            )
            if code != old_code or name != old_name:
                connection.execute(
                    "INSERT INTO procurement_material_identity_changes VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    (str(uuid4()), material_id, old_code, code, old_name, name, actor_user_id, now),
                )
        detail = self.material_detail(material_id)
        if detail is None:
            raise LookupError("Material not found")
        return detail

    def create_material(self, payload: MaterialCreateRequest, actor_user_id: str) -> str:
        code = payload.code.strip()
        if not code:
            raise ValueError("请填写原料编号")
        if payload.price is not None and (payload.effective_date is None or not 4 <= len(payload.reason.strip()) <= 200):
            raise ValueError("填写价格时，请选择价格日期并填写 4–200 字录入说明")
        with sqlite3.connect(self.path) as connection:
            connection.execute("BEGIN IMMEDIATE")
            collaboration.require_current(self.path, actor_user_id, "can_manage_catalog")
            if connection.execute("SELECT 1 FROM procurement_materials WHERE code=? UNION ALL SELECT 1 FROM procurement_material_aliases WHERE alias_code=? LIMIT 1", (code, code)).fetchone():
                raise RuntimeError("编号或旧编号已存在，请使用其他编号")
            groups = set(payload.department_ids)
            known = {row[0] for row in connection.execute("SELECT id FROM procurement_departments")}
            if len(groups) != len(payload.department_ids) or not groups <= known:
                raise ValueError("分流部门重复或已不存在，请刷新部门后重新选择")
            if payload.price is not None:
                collaboration.require_current(self.path, actor_user_id, "can_edit")
                self._check_revision(connection, payload.update_id, payload.updated_at)
                current = connection.execute("SELECT status FROM procurement_updates WHERE id=?", (payload.update_id,)).fetchone()
                if current and current[0] not in ("draft", "returned"):
                    raise RuntimeError("本轮更新暂不可录价，请先处理本轮更新，或清空价格仅新增原料")
                if self._latest_batch_id(connection) != payload.baseline_id:
                    raise RuntimeError("正式版本已变化，请保留输入并刷新核对")
            material_id = str(uuid4())
            connection.execute("INSERT INTO procurement_materials(id,code,name,unit,updated_at) VALUES (?,?,?,'kg',?)", (material_id, code, payload.name.strip() or code, datetime.now(UTC).isoformat()))
            connection.executemany("INSERT INTO procurement_department_materials VALUES (?,?)", [(group, material_id) for group in groups])
            collaboration.admin_event(connection, actor_user_id, "material.created", material_id, {"code": code, "name": payload.name.strip() or code, "department_ids": sorted(groups)})
            for group in sorted(groups):
                collaboration.admin_event(connection, actor_user_id, "department.changed", group, {"added": [material_id], "removed": []})
            if payload.price is not None:
                self._adjust_price(connection, material_id, payload.price, payload.effective_date, payload.reason, actor_user_id, None)
        return material_id

    def adjust_price(self, material_id: str, price: Decimal, effective_date: date, reason: str, actor_user_id: str, target_history_id: str | None, price_confirmation: PriceConfirmation | None = None, *, updated_at: str | None = None) -> dict[str, Any]:
        with sqlite3.connect(self.path) as connection:
            connection.execute("BEGIN IMMEDIATE")
            collaboration.require_current(self.path, actor_user_id, "can_edit")
            if price_confirmation is not None:
                collaboration.require_current(self.path, actor_user_id, "can_activate")
            if updated_at is not None:
                material = connection.execute("SELECT updated_at FROM procurement_materials WHERE id=?", (material_id,)).fetchone()
                if not material or material[0] != updated_at:
                    raise RuntimeError("原料已被其他人修改，请保留输入并刷新核对")
            result = self._adjust_price(connection, material_id, price, effective_date, reason, actor_user_id, target_history_id)
            if price_confirmation is not None:
                self._confirm_saved_risks(connection, str(self._editable_update(connection)[0]), {material_id}, price_confirmation, reason, actor_user_id)
            return result

    def _adjust_price(self, connection: sqlite3.Connection, material_id: str, price: Decimal, effective_date: date, reason: str, actor_user_id: str, target_history_id: str | None, record_event: bool = True) -> dict[str, Any]:
        now = datetime.now(UTC).isoformat()
        date_text = effective_date.isoformat()
        if not 4 <= len(reason.strip()) <= 200:
            raise ValueError("原因须为 4–200 字")
        update_id = self._ensure_editable_update(connection, date_text, "手工价格修正", actor_user_id, now)
        material = connection.execute("SELECT id FROM procurement_materials WHERE id = ? AND archived_at IS NULL", (material_id,)).fetchone()
        if material is None:
            raise LookupError("Material not found")
        active = self._active_history(connection=connection, material_id=material_id)
        before_row = connection.execute("SELECT latest_price FROM procurement_update_items WHERE update_id=? AND material_id=?", (update_id, material_id)).fetchone()
        if before_row is None:
            before_row = connection.execute("SELECT latest_price FROM procurement_price_batch_items WHERE batch_id=? AND material_id=?", (self._latest_batch_id(connection), material_id)).fetchone()
        active.sort(key=lambda item: (item["effective_date"], item["created_at"]))
        latest = active[-1] if active else None
        if target_history_id is None and latest and date_text < latest["effective_date"]:
            raise ValueError("较早日期必须选择一条历史记录进行修正")
        if target_history_id is None and latest and date_text == latest["effective_date"]:
            target_history_id = latest["id"]
        target = next((item for item in active if item["id"] == target_history_id), None) if target_history_id else None
        if target_history_id and target is None:
            raise LookupError("History record not found")
        if any(item["effective_date"] == date_text and item["id"] != target_history_id for item in active):
            raise RuntimeError("同一原料在该日期已有有效价格，请先处理冲突")
        import_id = str(uuid4())
        history_id = str(uuid4())
        connection.execute(
            """INSERT INTO procurement_imports (
                id, source_name, received_count, imported_count, skipped_count, created_by,
                created_at, effective_date, archived_at, archived_by, update_id
            ) VALUES (?, '手工价格修正', 1, 1, 0, ?, ?, ?, NULL, NULL, ?)""",
            (import_id, actor_user_id, now, date_text, update_id),
        )
        connection.execute(
            "INSERT INTO procurement_price_history VALUES (?, ?, ?, ?, ?, ?, ?)",
            (history_id, material_id, import_id, _decimal_text(price), target["inventory_price"] if target else None, target["in_transit_price"] if target else None, f"{date_text}T00:00:00+00:00"),
        )
        adjustment_id = str(uuid4())
        # A cancelled replacement keeps its audit link; a new save must not overwrite that link.
        if target_history_id and connection.execute("SELECT 1 FROM procurement_price_adjustments WHERE target_history_id=?", (target_history_id,)).fetchone():
            target_history_id = None
        connection.execute(
            """INSERT INTO procurement_price_adjustments (
                   id, material_id, target_history_id, replacement_history_id, reason,
                   created_by, created_at, update_id
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (adjustment_id, material_id, target_history_id, history_id, reason.strip(), actor_user_id, now, update_id),
        )
        self._refresh_material_snapshot(connection, material_id)
        self._save_candidate(connection, update_id, material_id, history_id)
        self._refresh_update_issues(connection, update_id, now, {material_id})
        connection.execute(
            "UPDATE procurement_working_state SET latest_import_id = ?, submitted_by = NULL, submitted_at = NULL WHERE id = 1",
            (import_id,),
        )
        if record_event:
            event_id = self._event(connection, update_id, "price_adjusted", actor_user_id, reason.strip())
            before = before_row[0] if before_row else target["latest_price"] if target else None
            collaboration.record_changes(connection, event_id, update_id, actor_user_id, date_text, [(material_id, before, _decimal_text(price))])
        return {"id": adjustment_id, "replacement_history_id": history_id}

    @staticmethod
    def _check_revision(connection, update_id, updated_at):
        current = connection.execute("SELECT id,updated_at FROM procurement_updates WHERE status IN ('draft','returned','submitted','revalidation_required') ORDER BY CASE status WHEN 'revalidation_required' THEN 1 ELSE 0 END,created_at DESC LIMIT 1").fetchone()
        if (current and tuple(current) != (update_id, updated_at)) or (not current and (update_id or updated_at)):
            raise RuntimeError("本轮更新已变化，请保留输入，刷新核对后重新编辑")

    def bulk_adjust_prices(self, payload: BulkPriceAdjustmentRequest, actor_user_id: str) -> str:
        with sqlite3.connect(self.path) as connection:
            connection.execute("BEGIN IMMEDIATE")
            collaboration.require_current(self.path, actor_user_id, "can_edit")
            if payload.price_confirmation is not None:
                collaboration.require_current(self.path, actor_user_id, "can_activate")
            current = connection.execute(
                """SELECT id, updated_at, status FROM procurement_updates
                   WHERE status IN ('draft', 'returned', 'submitted', 'revalidation_required')
                   ORDER BY CASE status WHEN 'revalidation_required' THEN 1 ELSE 0 END, created_at DESC LIMIT 1"""
            ).fetchone()
            if (current and (current[0] != payload.update_id or current[1] != payload.updated_at or current[2] not in ('draft', 'returned'))) or (not current and (payload.update_id is not None or payload.updated_at is not None)):
                raise RuntimeError("本轮更新已变化，请保留输入，刷新核对后重新编辑")
            if len({item.material_id for item in payload.items}) != len(payload.items):
                raise ValueError("同一原料不能重复提交")
            changes = []
            for item in payload.items:
                before = connection.execute("SELECT latest_price FROM procurement_update_items WHERE update_id=? AND material_id=?", (payload.update_id, item.material_id)).fetchone()
                if before is None:
                    before = connection.execute("SELECT latest_price FROM procurement_price_batch_items WHERE batch_id=? AND material_id=?", (self._latest_batch_id(connection), item.material_id)).fetchone()
                changes.append((item.material_id, before[0] if before else None, _decimal_text(item.price)))
                material = connection.execute("SELECT code FROM procurement_materials WHERE id=?", (item.material_id,)).fetchone()
                try:
                    self._adjust_price(connection, item.material_id, item.price, payload.effective_date, payload.reason, actor_user_id, None, record_event=False)
                except (ValueError, LookupError, RuntimeError) as error:
                    raise type(error)(f"{material[0] if material else item.material_id}：{error}") from error
            update_id = str(self._editable_update(connection)[0])
            if payload.price_confirmation is not None:
                self._confirm_saved_risks(connection, update_id, {item.material_id for item in payload.items}, payload.price_confirmation, payload.reason, actor_user_id)
            event_id = self._event(connection, update_id, "prices_adjusted", actor_user_id, f"修改 {len(payload.items)} 项原料；{payload.reason.strip()}")
            collaboration.record_changes(connection, event_id, update_id, actor_user_id, payload.effective_date.isoformat(), changes)
            return update_id

    def preview_prices(self, payload: PricePreviewRequest) -> dict[str, Any]:
        with sqlite3.connect(self.path) as connection:
            connection.execute("BEGIN")
            baseline_id = self._latest_batch_id(connection)
            rows = []
            for item in payload.items:
                material = connection.execute("SELECT code, name FROM procurement_materials WHERE id=? AND archived_at IS NULL", (item.material_id,)).fetchone()
                if material is None:
                    raise LookupError("原料不存在")
                reference = self._reference_for_date(connection, payload.effective_date.isoformat(), item.material_id)
                official = connection.execute("SELECT 1 FROM procurement_price_batch_items WHERE batch_id=? AND material_id=?", (baseline_id, item.material_id)).fetchone()
                rows.append({"material_id": item.material_id, "code": material[0], "name": material[1], "reference_price": reference, "comparison_basis": "published" if official else "previous_inquiry", "price": _decimal_text(item.price), "change": _change(item.price, reference), "high_risk": _has_price_spike(item.price, _decimal(reference))})
            return {"baseline_id": baseline_id, "rows": rows}

    def _confirm_saved_risks(self, connection: sqlite3.Connection, update_id: str, changed_ids: set[str], confirmation: PriceConfirmation, reason: str, actor_user_id: str) -> None:
        if not 4 <= len(reason.strip()) <= 200:
            raise ValueError("确认原因须为 4–200 字")
        if confirmation.baseline_id != self._latest_batch_id(connection) or set(confirmation.references) != changed_ids:
            raise RuntimeError("价格核对已过期，请重新检查价格变化后保存")
        for material_id in changed_ids:
            if _decimal(self._reference_price(connection, update_id, material_id)) != confirmation.references[material_id]:
                raise RuntimeError("参考价格已变化，请重新检查价格变化后保存")
        now = datetime.now(UTC).isoformat()
        for material_id in changed_ids:
            changed = connection.execute("""UPDATE procurement_issues SET status='reviewed', reviewed_by=?, reviewed_at=?, review_reason=?
                WHERE update_id=? AND material_id=? AND kind='price_spike' AND status='open'""", (actor_user_id, now, reason.strip(), update_id, material_id)).rowcount
            if changed:
                self._event(connection, update_id, "risk_reviewed", actor_user_id, f"{material_id}：{reason.strip()}")

    def set_archive(self, kind: str, item_id: str, archived: bool, actor_user_id: str) -> bool:
        table = "procurement_imports" if kind == "imports" else "procurement_materials"
        now = datetime.now(UTC).isoformat()
        with sqlite3.connect(self.path) as connection:
            connection.execute("BEGIN IMMEDIATE")
            if kind == "imports":
                pending = connection.execute(
                    """SELECT 1 FROM procurement_imports i JOIN procurement_updates u ON u.id=i.update_id
                       WHERE i.id=? AND u.status IN ('draft','returned','submitted','scheduled','revalidation_required')""", (item_id,),
                ).fetchone()
                if pending:
                    raise ValueError("请先完成或取消该批次，再归档或恢复其询价记录")
            changed = connection.execute(
                f"UPDATE {table} SET archived_at = ?, archived_by = ? WHERE id = ?",
                (now if archived else None, actor_user_id if archived else None, item_id),
            ).rowcount
            if kind == "imports":
                material_ids = [str(row[0]) for row in connection.execute("SELECT DISTINCT material_id FROM procurement_price_history WHERE import_id = ?", (item_id,))]
                for material_id in material_ids:
                    self._refresh_material_snapshot(connection, material_id)
        return bool(changed)

    def _active_history(self, *, include_archived: bool = False, material_id: str | None = None, connection: sqlite3.Connection | None = None) -> list[dict[str, Any]]:
        own_connection = connection is None
        connection = connection or sqlite3.connect(self.path)
        try:
            where = ["""NOT EXISTS (SELECT 1 FROM procurement_price_adjustments a JOIN procurement_price_history h ON h.id=a.replacement_history_id JOIN procurement_imports i ON i.id=h.import_id JOIN procurement_updates u ON u.id=i.update_id WHERE a.target_history_id=history.id AND u.status!='cancelled' AND i.archived_at IS NULL)""", "NOT EXISTS (SELECT 1 FROM procurement_updates u WHERE u.id=imports.update_id AND u.status='cancelled')"]
            params: list[Any] = []
            if not include_archived:
                where += ["materials.archived_at IS NULL", "imports.archived_at IS NULL"]
            if material_id:
                where.append("history.material_id = ?")
                params.append(material_id)
            rows = connection.execute(
                f"""SELECT history.id, history.material_id, materials.code, materials.name, materials.unit,
                           imports.source_name, imports.effective_date, imports.created_at,
                           COALESCE(users.display_name, imports.created_by), history.latest_price,
                           history.inventory_price, history.in_transit_price
                    FROM procurement_price_history AS history
                    JOIN procurement_materials AS materials ON materials.id = history.material_id
                    JOIN procurement_imports AS imports ON imports.id = history.import_id
                    LEFT JOIN identity_users AS users ON users.id = imports.created_by
                    WHERE {' AND '.join(where)}
                    ORDER BY imports.effective_date, materials.code, imports.created_at""",
                params,
            ).fetchall()
        finally:
            if own_connection:
                connection.close()
        # Date summaries use the latest non-cancelled save; individual operations remain in saved_events.
        latest_by_period = {(row[1], row[6]): row for row in rows}
        return [
            {"id": str(row[0]), "material_id": str(row[1]), "material_code": str(row[2]), "material_name": str(row[3]), "unit": str(row[4]), "source_name": str(row[5]), "effective_date": str(row[6]), "created_at": str(row[7]), "created_by_name": str(row[8]), "latest_price": row[9], "inventory_price": row[10], "in_transit_price": row[11]}
            for row in latest_by_period.values()
        ]

    def _refresh_material_snapshot(self, connection: sqlite3.Connection, material_id: str) -> None:
        rows = self._active_history(connection=connection, material_id=material_id)
        rows.sort(key=lambda item: (item["effective_date"], item["created_at"]))
        latest = rows[-1] if rows else None
        previous = rows[-2] if len(rows) > 1 else None
        baseline = connection.execute("SELECT latest_price FROM procurement_price_batch_items WHERE batch_id=? AND material_id=?", (self._latest_batch_id(connection), material_id)).fetchone()
        connection.execute(
            """UPDATE procurement_materials SET latest_price = ?, inventory_price = ?, in_transit_price = ?,
               previous_latest_price = ?, last_import_id = ?, updated_at = ? WHERE id = ?""",
            (latest["latest_price"] if latest else baseline[0] if baseline else None, latest["inventory_price"] if latest else None, latest["in_transit_price"] if latest else None, previous["latest_price"] if previous else None, self._history_import_id(connection, latest["id"]) if latest else None, datetime.now(UTC).isoformat(), material_id),
        )

    @staticmethod
    def _history_import_id(connection: sqlite3.Connection, history_id: str) -> str:
        return str(connection.execute("SELECT import_id FROM procurement_price_history WHERE id = ?", (history_id,)).fetchone()[0])

    @staticmethod
    def _latest_batch_id(connection: sqlite3.Connection) -> str | None:
        row = connection.execute(
            "SELECT id FROM procurement_price_batches ORDER BY version DESC LIMIT 1"
        ).fetchone()
        return str(row[0]) if row else None

    def _candidate_snapshot(self, connection: sqlite3.Connection, update_id: str) -> list[tuple[Any, ...]]:
        update = connection.execute("SELECT status FROM procurement_updates WHERE id = ?", (update_id,)).fetchone()
        if update and update[0] in {"scheduled", "revalidation_required", "cancelled", "published"}:
            return self._frozen_snapshot(connection, update_id)
        rows = {row[0]: row for row in connection.execute(
            """SELECT m.id, m.code, m.name, m.unit, b.latest_price, b.inventory_price,
                      b.in_transit_price, b.recommended_price
               FROM procurement_materials m LEFT JOIN procurement_price_batch_items b
                 ON b.material_id = m.id AND b.batch_id = ?
               WHERE m.archived_at IS NULL ORDER BY m.code""",
            (self._latest_batch_id(connection),),
        ).fetchall()}
        # Existing v4 drafts have no item rows. Recover only their own inquiry records.
        history = connection.execute(
            """SELECT m.id, m.code, m.name, m.unit, h.latest_price, h.inventory_price, h.in_transit_price, NULL
               FROM procurement_price_history h JOIN procurement_imports i ON i.id = h.import_id
               JOIN procurement_materials m ON m.id = h.material_id
               LEFT JOIN procurement_price_adjustments a ON a.target_history_id = h.id
               WHERE i.update_id = ? AND i.archived_at IS NULL AND m.archived_at IS NULL AND a.id IS NULL
               ORDER BY i.created_at, i.rowid, h.rowid""", (update_id,),
        ).fetchall()
        own_rows = history + self._frozen_snapshot(connection, update_id)
        involved = {row[0] for row in own_rows}
        for row in own_rows:
            if row[0] in rows:
                rows[row[0]] = (*rows[row[0]][:4], *row[4:])
        return sorted((row for row in rows.values() if row[4] is not None or row[0] in involved), key=lambda row: row[1])

    @staticmethod
    def _save_candidate(connection: sqlite3.Connection, update_id: str, material_id: str, history_id: str | None = None) -> None:
        material = connection.execute(
            "SELECT id, code, name, unit, latest_price, inventory_price, in_transit_price FROM procurement_materials WHERE id = ?",
            (material_id,),
        ).fetchone()
        if history_id:
            values = connection.execute("SELECT latest_price, inventory_price, in_transit_price FROM procurement_price_history WHERE id = ?", (history_id,)).fetchone()
            material = (*material[:4], *values)
        connection.execute(
            """INSERT INTO procurement_update_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(update_id, material_id) DO UPDATE SET code=excluded.code, name=excluded.name,
               unit=excluded.unit, latest_price=excluded.latest_price, inventory_price=excluded.inventory_price,
               in_transit_price=excluded.in_transit_price, recommended_price=excluded.recommended_price""",
            (update_id, *material, material[4]),
        )

    def _reference_price(self, connection: sqlite3.Connection, update_id: str, material_id: str) -> str | None:
        price_date = connection.execute("SELECT price_date FROM procurement_updates WHERE id=?", (update_id,)).fetchone()[0]
        return self._reference_for_date(connection, str(price_date), material_id)

    def _reference_for_date(self, connection: sqlite3.Connection, price_date: str, material_id: str) -> str | None:
        official = connection.execute(
            "SELECT latest_price FROM procurement_price_batch_items WHERE batch_id = ? AND material_id = ?",
            (self._latest_batch_id(connection), material_id),
        ).fetchone()
        if official is not None:
            return official[0]
        previous = connection.execute(
            """SELECT h.latest_price FROM procurement_price_history h JOIN procurement_imports i ON i.id=h.import_id
               LEFT JOIN procurement_price_adjustments a ON a.target_history_id=h.id
               WHERE h.material_id=? AND i.archived_at IS NULL AND a.id IS NULL
                 AND i.effective_date < ?
               ORDER BY i.effective_date DESC, i.created_at DESC, i.rowid DESC LIMIT 1""",
            (material_id, price_date),
        ).fetchone()
        if previous:
            return previous[0]
        initial = connection.execute(
            "SELECT previous_latest_price FROM procurement_materials WHERE id=?", (material_id,),
        ).fetchone()
        return initial[0] if initial else None

    def _refresh_update_issues(self, connection: sqlite3.Connection, update_id: str, now: str, changed_ids: set[str] | None = None) -> None:
        for row in self._candidate_snapshot(connection, update_id):
            material_id = str(row[0])
            required = {"missing_price": row[4] is None,
                        "price_spike": _has_price_spike(_decimal(row[4]), _decimal(self._reference_price(connection, update_id, material_id)))}
            for kind, present in required.items():
                existing = connection.execute(
                    "SELECT status FROM procurement_issues WHERE update_id=? AND material_id=? AND kind=? AND status!='resolved'",
                    (update_id, material_id, kind),
                ).fetchone()
                if changed_ids is None or material_id in changed_ids or not present or existing is None:
                    self._sync_issue(connection, material_id, kind, present, now, update_id)

    def _validate_snapshot(self, connection: sqlite3.Connection, update_id: str) -> None:
        rows = self._candidate_snapshot(connection, update_id)
        if not rows or any(row[4] is None or _decimal(row[4]) is None or _decimal(row[4]) < 0 for row in rows):
            raise ValueError("正式基线存在未处理问题：原料缺价或价格无效")
        for row in rows:
            if _has_price_spike(_decimal(row[4]), _decimal(self._reference_price(connection, update_id, str(row[0])))):
                confirmed = connection.execute(
                    "SELECT 1 FROM procurement_issues WHERE update_id=? AND material_id=? AND kind='price_spike' AND status='reviewed' AND length(trim(review_reason)) BETWEEN 4 AND 200",
                    (update_id, row[0]),
                ).fetchone()
                if confirmed is None:
                    raise ValueError("仍有未处理问题：价格波动需要确认")

    @staticmethod
    def _frozen_snapshot(connection: sqlite3.Connection, update_id: str) -> list[tuple[Any, ...]]:
        return connection.execute(
            """SELECT material_id, code, name, unit, latest_price, inventory_price,
                      in_transit_price, recommended_price
               FROM procurement_update_items WHERE update_id = ? ORDER BY code""",
            (update_id,),
        ).fetchall()

    def _freeze_update(self, connection: sqlite3.Connection, update_id: str) -> list[tuple[Any, ...]]:
        rows = self._candidate_snapshot(connection, update_id)
        collaboration.freeze_sources(connection, update_id, update_id, self._latest_batch_id(connection))
        connection.execute("DELETE FROM procurement_update_items WHERE update_id = ?", (update_id,))
        connection.executemany(
            """INSERT INTO procurement_update_items (
                   update_id, material_id, code, name, unit, latest_price,
                   inventory_price, in_transit_price, recommended_price
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            [
                (
                    update_id, row[0], row[1], row[2], row[3], row[4], row[5], row[6],
                    _decimal_text(_first_decimal(row[4], row[6], row[5])),
                )
                for row in rows
            ],
        )
        return rows

    def _refresh_revalidation_issues(self, connection: sqlite3.Connection, update_id: str, now: str) -> None:
        self._refresh_update_issues(connection, update_id, now)

    def _activate_update(self, connection: sqlite3.Connection, update_id: str, actor_user_id: str, now: str) -> dict[str, Any]:
        update = connection.execute(
            """SELECT price_date, source_name, submitted_by, base_batch_id, status
               FROM procurement_updates WHERE id = ?""",
            (update_id,),
        ).fetchone()
        if update is None or str(update[4]) not in {"draft", "returned", "submitted", "scheduled", "revalidation_required"}:
            raise ValueError("当前批次不能启用")
        self._validate_snapshot(connection, update_id)
        rows = self._freeze_update(connection, update_id)
        if not rows:
            raise ValueError("没有可发布的原料数据")
        version = int(connection.execute(
            "SELECT COALESCE(MAX(version), 0) + 1 FROM procurement_price_batches"
        ).fetchone()[0])
        batch_id = str(uuid4())
        connection.execute(
            """INSERT INTO procurement_price_batches (
                   id, version, published_by, published_at, item_count, update_id,
                   price_date, activated_at, submitted_by, source_name, base_batch_id
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (batch_id, version, actor_user_id, now, len(rows), update_id, update[0], now, update[2], update[1], update[3]),
        )
        connection.executemany(
            "INSERT INTO procurement_price_batch_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
                (
                    batch_id, row[0], row[1], row[2], row[3], row[4], row[5], row[6],
                    row[7] if len(row) > 7 and row[7] is not None else _decimal_text(_first_decimal(row[4], row[6], row[5])),
                )
                for row in rows
            ],
        )
        previous_id = connection.execute("SELECT id FROM procurement_price_batches WHERE version<? ORDER BY version DESC LIMIT 1", (version,)).fetchone()
        collaboration.freeze_sources(connection, batch_id, update_id, previous_id[0] if previous_id else None)
        connection.execute(
            """UPDATE procurement_updates SET status = 'published', published_batch_id = ?,
               updated_at = ? WHERE id = ?""",
            (batch_id, now, update_id),
        )
        connection.execute(
            "UPDATE procurement_working_state SET latest_import_id = NULL, submitted_by = NULL, submitted_at = NULL WHERE id = 1"
        )
        self._event(connection, update_id, "activated", actor_user_id)
        scheduled = connection.execute(
            "SELECT id FROM procurement_updates WHERE status = 'scheduled' AND id != ?",
            (update_id,),
        ).fetchall()
        for scheduled_row in scheduled:
            scheduled_id = str(scheduled_row[0])
            connection.execute(
                "UPDATE procurement_updates SET status = 'revalidation_required', updated_at = ? WHERE id = ?",
                (now, scheduled_id),
            )
            self._refresh_revalidation_issues(connection, scheduled_id, now)
            self._event(connection, scheduled_id, "revalidation_required", None, "正式基线已更新")
        for (draft_id,) in connection.execute("SELECT id FROM procurement_updates WHERE status IN ('draft','returned','submitted','revalidation_required') AND id != ?", (update_id,)).fetchall():
            self._refresh_update_issues(connection, str(draft_id), now)
        from api.research import enqueue
        enqueue(connection, "采购正式价格更新")
        return {"id": batch_id, "version": version, "published_at": now, "activated_at": now, "item_count": len(rows)}

    def publish_update(
        self,
        update_id: str,
        actor_user_id: str,
        mode: str,
        activate_at: datetime | None = None,
        revision: tuple | None = None,
    ) -> dict[str, Any]:
        now_dt = datetime.now(UTC)
        now = now_dt.isoformat()
        with sqlite3.connect(self.path) as connection:
            connection.execute("BEGIN IMMEDIATE")
            collaboration.require_current(self.path, actor_user_id, "can_activate")
            if revision is not None:
                row = connection.execute("SELECT updated_at FROM procurement_updates WHERE id=?", (update_id,)).fetchone()
                if not row or (row[0], self._latest_batch_id(connection)) != revision:
                    raise RuntimeError("启用概况已变化，请刷新核对后重新确认")
            update = connection.execute(
                "SELECT status, submitted_by FROM procurement_updates WHERE id = ?",
                (update_id,),
            ).fetchone()
            if update is None or str(update[0]) not in {"draft", "returned", "submitted", "revalidation_required"}:
                raise ValueError("当前批次不能启用")
            open_issue_count = int(connection.execute(
                "SELECT COUNT(*) FROM procurement_issues WHERE update_id = ? AND status = 'open'",
                (update_id,),
            ).fetchone()[0])
            if open_issue_count:
                raise ValueError(f"仍有 {open_issue_count} 个未处理问题")
            self._validate_snapshot(connection, update_id)
            if mode == "immediate":
                return self._activate_update(connection, update_id, actor_user_id, now)
            if activate_at is None:
                raise ValueError("定时启用必须填写日期和时间")
            local_time = activate_at.replace(tzinfo=SHANGHAI) if activate_at.tzinfo is None else activate_at
            activate_utc = local_time.astimezone(UTC)
            if activate_utc <= now_dt:
                raise ValueError("定时启用时间必须晚于当前时间")
            other = connection.execute(
                "SELECT id FROM procurement_updates WHERE status = 'scheduled' AND id != ?",
                (update_id,),
            ).fetchone()
            if other:
                raise ValueError("已有一个待启用批次，请先处理后再安排新的定时启用")
            if str(update[0]) in {"draft", "returned", "submitted"}:
                self._freeze_update(connection, update_id)
            connection.execute(
                """UPDATE procurement_updates SET status = 'scheduled', scheduled_activate_at = ?,
                   base_batch_id = ?, updated_at = ? WHERE id = ?""",
                (activate_utc.isoformat(), self._latest_batch_id(connection), now, update_id),
            )
            connection.execute(
                "UPDATE procurement_working_state SET latest_import_id = NULL, submitted_by = NULL, submitted_at = NULL WHERE id = 1"
            )
            self._event(connection, update_id, "scheduled", actor_user_id, activate_utc.isoformat())
        return self.get_update(update_id) or {"id": update_id, "status": "scheduled"}

    def publish_batch(self, actor_user_id: str) -> dict[str, Any]:
        update = self.current_update()
        if update is None:
            raise ValueError("当前价格工作稿尚未提交")
        return self.publish_update(update["id"], actor_user_id, "immediate")

    def process_scheduled(self, now: datetime | None = None) -> int:
        now_dt = (now or datetime.now(UTC)).astimezone(UTC)
        processed = 0
        with sqlite3.connect(self.path) as connection:
            connection.execute("BEGIN IMMEDIATE")
            rows = connection.execute(
                """SELECT id, base_batch_id FROM procurement_updates
                   WHERE status = 'scheduled' AND scheduled_activate_at <= ? ORDER BY scheduled_activate_at""",
                (now_dt.isoformat(),),
            ).fetchall()
            for row in rows:
                update_id = str(row[0])
                approver = connection.execute("SELECT actor_user_id FROM procurement_update_events WHERE update_id=? AND event='scheduled' ORDER BY created_at DESC,rowid DESC LIMIT 1", (update_id,)).fetchone()
                if row[1] != self._latest_batch_id(connection) or not approver or not collaboration.can_activate(self.path, str(approver[0])):
                    connection.execute(
                        "UPDATE procurement_updates SET status = 'revalidation_required', updated_at = ? WHERE id = ? AND status = 'scheduled'",
                        (now_dt.isoformat(), update_id),
                    )
                    self._refresh_revalidation_issues(connection, update_id, now_dt.isoformat())
                    self._event(connection, update_id, "revalidation_required", None, "正式基线或启用授权已变化")
                else:
                    approver = connection.execute("SELECT actor_user_id FROM procurement_update_events WHERE update_id=? AND event='scheduled' ORDER BY created_at DESC, rowid DESC LIMIT 1", (update_id,)).fetchone()
                    self._activate_update(connection, update_id, str(approver[0]) if approver else "system-scheduler", now_dt.isoformat())
                    self._event(connection, update_id, "scheduled_activation", "system-scheduler")
                processed += 1
        return processed

    def cancel_schedule(self, update_id: str, actor_user_id: str, reason: str, copy_to_draft: bool) -> dict[str, Any]:
        now = datetime.now(UTC).isoformat()
        copied_id: str | None = None
        with sqlite3.connect(self.path) as connection:
            connection.execute("BEGIN IMMEDIATE")
            collaboration.require_current(self.path, actor_user_id, "can_activate")
            update = connection.execute(
                "SELECT price_date, source_name FROM procurement_updates WHERE id = ? AND status IN ('scheduled', 'revalidation_required')",
                (update_id,),
            ).fetchone()
            if update is None:
                raise ValueError("该批次当前没有可撤销的排期")
            if copy_to_draft and self._editable_update(connection):
                raise ValueError("已有正在处理的本轮更新，不能同时复制排期")
            connection.execute(
                """UPDATE procurement_updates SET status = 'cancelled', cancelled_by = ?,
                   cancelled_at = ?, cancel_reason = ?, updated_at = ? WHERE id = ?""",
                (actor_user_id, now, reason.strip(), now, update_id),
            )
            connection.execute(
                "UPDATE procurement_issues SET status = 'resolved' WHERE update_id = ? AND status = 'open'",
                (update_id,),
            )
            self._event(connection, update_id, "schedule_cancelled", actor_user_id, reason.strip())
            for (material_id,) in connection.execute("SELECT material_id FROM procurement_update_items WHERE update_id=?", (update_id,)).fetchall():
                self._refresh_material_snapshot(connection, material_id)
            if copy_to_draft:
                copied_id = str(uuid4())
                connection.execute(
                    """INSERT INTO procurement_updates (
                           id, price_date, source_name, created_by, created_at, updated_at, status
                       ) VALUES (?, ?, ?, ?, ?, ?, 'draft')""",
                    (copied_id, update[0], f"复制：{update[1]}", actor_user_id, now, now),
                )
                connection.execute(
                    """INSERT INTO procurement_update_items SELECT ?, material_id, code, name, unit,
                       latest_price, inventory_price, in_transit_price, recommended_price
                       FROM procurement_update_items WHERE update_id=?""", (copied_id, update_id),
                )
                collaboration.freeze_sources(connection, copied_id, update_id, self._latest_batch_id(connection))
                self._refresh_update_issues(connection, copied_id, now)
                event_id = self._event(connection, copied_id, "copied_from_schedule", actor_user_id, f"从排期 {update_id} 复制：{reason}")
                changes = connection.execute("""SELECT c.material_id,b.latest_price,c.after_price,c.price_date FROM procurement_saved_changes c
                    LEFT JOIN procurement_price_batch_items b ON b.material_id=c.material_id AND b.batch_id=?
                    WHERE c.update_id=? AND c.rowid=(SELECT MAX(s.rowid) FROM procurement_saved_changes s WHERE s.update_id=c.update_id AND s.material_id=c.material_id)""", (self._latest_batch_id(connection),update_id)).fetchall()
                for material_id,before,after,price_date in changes:
                    collaboration.record_changes(connection,event_id,copied_id,actor_user_id,price_date,[(material_id,before,after)])
        result = self.get_update(update_id) or {"id": update_id, "status": "cancelled"}
        result["copied_update"] = self.get_update(copied_id) if copied_id else None
        return result

    def batch_comparison(self, batch_id: str, *, preserve_catalog: bool = False) -> dict[str, Any]:
        with sqlite3.connect(self.path) as connection:
            previous = connection.execute("SELECT id, version FROM procurement_price_batches WHERE version < (SELECT version FROM procurement_price_batches WHERE id=?) ORDER BY version DESC LIMIT 1", (batch_id,)).fetchone()
            old = dict(connection.execute("SELECT material_id, latest_price FROM procurement_price_batch_items WHERE batch_id=?", (previous[0] if previous else None,)).fetchall())
            current = connection.execute("SELECT material_id, latest_price FROM procurement_price_batch_items WHERE batch_id=?", (batch_id,)).fetchall()
            batch = connection.execute("SELECT version,update_id FROM procurement_price_batches WHERE id=?", (batch_id,)).fetchone()
            reported = {row[0] for row in connection.execute("SELECT material_id FROM procurement_saved_changes WHERE update_id=?", (batch[1],))} if batch else set()
            supplement = bool(previous) and bool(reported) and reported.isdisjoint(old)
        # Catalog supplementation must not replace existing materials' comparison baselines.
        inherited = self.batch_comparison(previous[0], preserve_catalog=True)["items"] if preserve_catalog and supplement else {}
        current_sources = collaboration.snapshot_sources(self.path, batch_id)
        old_sources = collaboration.snapshot_sources(self.path, previous[0] if previous else None)
        counts = dict(up=0, down=0, unchanged=0, first=0, missing=0, incomparable=0)
        items = {}
        for material_id, value in current:
            before = old.get(material_id)
            unusual = current_sources.get(material_id, {}).get('price_kind') in ('range','invalid') or old_sources.get(material_id, {}).get('price_kind') in ('range','invalid')
            kind = 'incomparable' if unusual else 'missing' if value is None else 'first' if before is None else 'up' if Decimal(value) > Decimal(before) else 'down' if Decimal(value) < Decimal(before) else 'unchanged'
            entry = {"previous": before, "previous_raw": old_sources.get(material_id, {}).get("raw_price"), "change": None if unusual else _change(value, before), "kind": kind}
            if preserve_catalog:
                entry.update(version=batch[0], previous_version=previous[1] if previous else None)
                if kind == 'unchanged' and material_id not in reported and material_id in inherited:
                    entry = inherited[material_id]
            counts[entry["kind"]] += 1
            items[material_id] = entry
        return {"previous_version": previous[1] if previous else None, **counts, "items": items, "added_material_ids": sorted(reported) if supplement else []}

    def get_batch(self, batch_id: str) -> dict[str, Any] | None:
        with sqlite3.connect(self.path) as connection:
            batch = connection.execute(
                """SELECT batches.id, batches.version, batches.published_at, batches.item_count,
                          batches.price_date, batches.activated_at, batches.source_name,
                          submitter.display_name, publisher.display_name,
                          CASE WHEN batches.version = (SELECT MAX(version) FROM procurement_price_batches)
                               THEN 'active' ELSE 'historical' END
                   FROM procurement_price_batches AS batches
                   LEFT JOIN identity_users AS submitter ON submitter.id = batches.submitted_by
                   LEFT JOIN identity_users AS publisher ON publisher.id = batches.published_by
                   WHERE batches.id = ?""",
                (batch_id,),
            ).fetchone()
            if batch is None:
                return None
            items = connection.execute(
                """
                SELECT material_id, code, name, unit, latest_price, inventory_price,
                       in_transit_price, recommended_price
                FROM procurement_price_batch_items WHERE batch_id = ? ORDER BY code
                """,
                (batch_id,),
            ).fetchall()
            scheduled_activation = connection.execute(
                """SELECT 1 FROM procurement_update_events WHERE event='scheduled_activation'
                   AND update_id=(SELECT update_id FROM procurement_price_batches WHERE id=?)""", (batch_id,),
            ).fetchone()
        return {
            "id": str(batch[0]),
            "version": int(batch[1]),
            "published_at": str(batch[2]),
            "item_count": int(batch[3]),
            "price_date": batch[4],
            "activated_at": batch[5],
            "source_name": batch[6],
            "submitted_by_name": batch[7],
            "published_by_name": batch[8],
            "changes": collaboration.saved_events(self.path, update_id=self._batch_update_id(batch_id)) if self._batch_update_id(batch_id) else [],
            "provenance": collaboration.provenance(self.path, batch_id),
            "snapshot_sources": collaboration.snapshot_sources(self.path, batch_id),
            "comparison": self.batch_comparison(batch_id),
            "activation_mode": "scheduled" if scheduled_activation else "immediate",
            "status": str(batch[9]),
            "items": [
                {
                    "material_id": str(row[0]),
                    "code": str(row[1]),
                    "name": str(row[2]),
                    "unit": str(row[3]),
                    "latest_price": row[4],
                    "inventory_price": row[5],
                    "in_transit_price": row[6],
                    "recommended_price": row[7],
                }
                for row in items
            ],
        }

    def _materials_by_code(self) -> dict[str, dict[str, Any]]:
        with sqlite3.connect(self.path) as connection:
            rows = connection.execute(
                "SELECT id, code, unit, latest_price FROM procurement_materials WHERE archived_at IS NULL"
            ).fetchall()
            aliases = connection.execute(
                """SELECT aliases.alias_code, materials.id, materials.unit, materials.latest_price
                   FROM procurement_material_aliases AS aliases
                   JOIN procurement_materials AS materials ON materials.id = aliases.material_id
                   WHERE materials.archived_at IS NULL"""
            ).fetchall()
        materials = {str(row[1]): {"id": str(row[0]), "unit": str(row[2]), "latest_price": _decimal(row[3])} for row in rows}
        materials.update({str(row[0]): {"id": str(row[1]), "unit": str(row[2]), "latest_price": _decimal(row[3])} for row in aliases})
        return materials

    @staticmethod
    def _material_for_code(connection: sqlite3.Connection, code: str) -> tuple[Any, ...] | None:
        return connection.execute(
            """SELECT materials.id, materials.code, materials.latest_price, materials.unit
               FROM procurement_materials AS materials
               LEFT JOIN procurement_material_aliases AS aliases ON aliases.material_id = materials.id
               WHERE materials.archived_at IS NULL AND (materials.code = ? OR aliases.alias_code = ?)
               LIMIT 1""",
            (code, code),
        ).fetchone()

    @staticmethod
    def _sync_issue(
        connection: sqlite3.Connection,
        material_id: str,
        kind: str,
        present: bool,
        now: str,
        update_id: str,
    ) -> None:
        if present:
            existing = connection.execute(
                "SELECT id FROM procurement_issues WHERE material_id = ? AND kind = ? AND update_id = ? AND status != 'resolved'",
                (material_id, kind, update_id),
            ).fetchone()
            if existing:
                connection.execute(
                    """UPDATE procurement_issues SET status = 'open', reviewed_by = NULL,
                       reviewed_at = NULL, review_reason = NULL WHERE id = ?""",
                    (existing[0],),
                )
            else:
                connection.execute(
                    """INSERT INTO procurement_issues (
                           id, material_id, kind, status, created_at, reviewed_by,
                           reviewed_at, update_id, review_reason
                       ) VALUES (?, ?, ?, 'open', ?, NULL, NULL, ?, NULL)""",
                    (str(uuid4()), material_id, kind, now, update_id),
                )
        else:
            connection.execute(
                """UPDATE procurement_issues SET status = 'resolved'
                   WHERE material_id = ? AND kind = ? AND update_id = ? AND status != 'resolved'""",
                (material_id, kind, update_id),
            )


def create_procurement_router(
    store: ProcurementStore,
    authorization: AuthorizationStore,
    settings: Settings,
) -> APIRouter:
    router = APIRouter(prefix="/api/workbenches/procurement", tags=["procurement"])

    def actor(request: Request, minimum_level: int) -> dict[str, Any]:
        if settings.workbench_modes["procurement"] != "active":
            raise HTTPException(status_code=404, detail="Workbench not available")
        if getattr(request.app.state, "procurement_error", None) is not None:
            raise HTTPException(status_code=503, detail="采购工作台暂时不可用")
        user = getattr(request.state, "current_user", None)
        if user is None:
            raise HTTPException(status_code=401, detail="Authentication required")
        if not user["is_system_admin"] and user["scope_levels"].get("procurement", 0) < minimum_level:
            raise HTTPException(status_code=403, detail="Permission denied")
        return user

    def require_price_write(user: dict[str, Any]) -> None:
        if not authorization.can_write_field(PRICE_FIELD_ID, user["is_system_admin"], user["scope_levels"]):
            raise HTTPException(status_code=403, detail="Procurement edit permission required")

    def require_activation(user, *, manage=False):
        key = "can_manage_grants" if manage else "can_activate"
        if not collaboration.capabilities(store.path, user)[key]:
            raise HTTPException(status_code=403, detail="需要启用授权管理权限" if manage else "尚未获得价格启用授权")

    def require_catalog_management(user):
        if not collaboration.capabilities(store.path, user)["can_manage_catalog"]:
            raise HTTPException(status_code=403, detail="需要采购管理权限以维护原料目录与分组")

    def permit_archived(user: dict[str, Any], include_archived: bool) -> None:
        if include_archived and not user["is_system_admin"] and user["scope_levels"].get("procurement", 0) < 3:
            raise HTTPException(status_code=403, detail="Procurement edit permission required")

    def visible_payload(payload: dict[str, Any], user: dict[str, Any], fields: dict[str, str] = PRICE_KEYS) -> dict[str, Any]:
        readable = authorization.filter_readable_fields(dict.fromkeys(fields, True), fields, user["is_system_admin"], user["scope_levels"])
        denied = fields.keys() - readable.keys()
        def clean(value):
            if isinstance(value, dict):
                return {key: clean(item) for key,item in value.items() if key not in denied}
            if isinstance(value, list):
                return [clean(item) for item in value]
            return value
        return clean(payload)

    history_fields = {key: "procurement.supplier_quote" for key in PRICE_KEYS}

    @router.get("/news")
    def news(request: Request, source: str = "all", page: int = 1):
        actor(request, 2)
        if source not in {"all", "market", "商务部", "生意社", "隆众资讯"} or page < 1:
            raise HTTPException(status_code=422, detail="资讯筛选参数无效")
        return request.app.state.procurement_news.listing(source, page)

    @router.get("/overview")
    def overview(request: Request, editor_id: str | None = None, editor_scope: str = "round") -> dict[str, Any]:
        user = actor(request, 2)
        result = store.overview()
        result["capabilities"] = collaboration.capabilities(store.path, user)
        result["environment"] = settings.environment
        result["departments"] = collaboration.departments(store.path, result)
        result["editors"] = [{"id": person["id"], "name": person["display_name"]} for person in IdentityStore(store.path).list_users()
                             if person["is_active"] and not person["is_system_admin"] and person["scope_levels"].get("procurement", 0) >= 3]
        if editor_id:
            if editor_scope not in {"round", "all"}:
                raise HTTPException(status_code=422, detail="筛选范围无效")
            key = "round_participants" if editor_scope == "round" else "participants"
            selected_editor = next((person for person in result["editors"] if person["id"] == editor_id), None)
            result["materials"] = [m for m in result["materials"] if any(p["id"] == editor_id for p in m[key]) or
                                   (editor_scope == "all" and selected_editor and selected_editor["name"] in m["source_purchasers"])]
        level = 5 if user["is_system_admin"] else user["scope_levels"].get("procurement", 0)
        current = result.get("current_update")
        scheduled = result.get("scheduled_update")
        if current:
            status_value = current["status"]
            if status_value in {"draft", "returned"}:
                if current["summary"]["error_count"]:
                    result["next_action"] = "补齐缺价并确认价格波动" if level >= 3 else "等待采购员处理价格"
                elif current["summary"]["risk_count"]:
                    result["next_action"] = "确认价格波动" if result["capabilities"]["can_activate"] else "等待有启用权的人员确认价格波动"
                else:
                    result["next_action"] = "选择正式启用方式" if result["capabilities"]["can_activate"] else "等待有启用权的人员启用价格"
            elif status_value == "submitted":
                result["next_action"] = "选择正式启用方式" if result["capabilities"]["can_activate"] else "等待有启用权的人员启用价格"
            else:
                result["next_action"] = "重新确认价格波动并选择启用方式" if result["capabilities"]["can_activate"] else "等待有启用权的人员重新确认"
        elif scheduled:
            result["next_action"] = f"已安排 {scheduled['activate_at']} 自动启用"
        else:
            result["next_action"] = "录入下一轮采购价格" if level >= 3 else "当前没有待处理更新"
        return visible_payload(result, user)

    @router.get("/activation-grants")
    def list_activation_grants(request: Request):
        user = actor(request, 3)
        require_activation(user, manage=True)
        return collaboration.grants(store.path)

    @router.put("/activation-grants/{user_id}")
    def set_activation_grant(user_id: str, payload: ActivationGrantRequest, request: Request):
        user = actor(request, 3)
        require_activation(user, manage=True)
        try:
            collaboration.set_grant(store.path, user, user_id, payload.enabled, payload.manager)
        except PermissionError as error:
            raise HTTPException(status_code=403, detail=str(error)) from error
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        return collaboration.grants(store.path)

    @router.put("/departments/{department_id}/materials")
    def set_department_materials(department_id: str, payload: DepartmentMaterialsRequest, request: Request):
        user = actor(request, 3)
        require_catalog_management(user)
        try:
            collaboration.set_department(store.path, department_id, payload.material_ids, user["id"])
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        return overview(request)

    @router.post("/excel-preview")
    async def excel_preview(request: Request, file: UploadFile = File(), sheet: str | None = Form(None), price_date: str | None = Form(None)):
        user = actor(request, 3)
        require_price_write(user)
        from api.procurement_excel import MAX_FILE, inspect_workbook, selected_prices
        try:
            content = await file.read(MAX_FILE + 1)
            if not file.filename or not file.filename.lower().endswith(".xlsx"):
                raise ValueError("请选择xlsx文件")
            result = inspect_workbook(content)
            if sheet and price_date:
                known = {m["code"]: m for m in store.overview()["materials"]}
                result["selection"] = selected_prices(content, sheet, price_date, known)
            return result
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @router.post("/import-preview")
    def preview(payload: DelimitedImportRequest, request: Request) -> dict[str, Any]:
        user = actor(request, 3)
        require_price_write(user)
        try:
            return store.preview_import(payload.content, payload.effective_date)
        except RuntimeError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @router.post("/imports", status_code=status.HTTP_201_CREATED)
    def confirm_import(payload: DelimitedImportRequest, request: Request) -> dict[str, Any]:
        user = actor(request, 3)
        require_price_write(user)
        if payload.price_confirmation is not None:
            require_activation(user)
        try:
            result = store.confirm_import(payload.source_name, payload.effective_date, payload.content, user["id"], payload.price_confirmation, payload.reason, revision=(payload.update_id, payload.updated_at))
        except RuntimeError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        authorization.audit(
            "procurement.import.confirmed",
            actor_user_id=user["id"],
            target_type="procurement_import",
            target_id=result["id"],
        )
        return result

    @router.post("/issues/{issue_id}/review")
    def review_issue(issue_id: str, payload: UpdateReasonRequest, request: Request) -> dict[str, Any]:
        user = actor(request, 3)
        require_activation(user)
        require_price_write(user)
        if payload.updated_at is None:
            raise HTTPException(status_code=409, detail="请刷新本轮概况后确认")
        try:
            issue = store.review_issue(issue_id, user["id"], payload.reason, updated_at=payload.updated_at)
        except ValueError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        if issue is None:
            raise HTTPException(status_code=404, detail="Issue not found")
        authorization.audit(
            "procurement.issue.reviewed",
            actor_user_id=user["id"],
            target_type="procurement_issue",
            target_id=issue_id,
        )
        return issue

    @router.get("/updates/current")
    def current_update(request: Request) -> dict[str, Any]:
        user = actor(request, 2)
        result = {"current": store.current_update(), "scheduled": store.scheduled_update()}
        return visible_payload(result, user)

    @router.post("/updates/{update_id}/submit")
    def submit_update(update_id: str, request: Request) -> dict[str, Any]:
        user = actor(request, 3)
        current = store.current_update()
        if current is None or current["id"] != update_id:
            raise HTTPException(status_code=404, detail="Update not found")
        try:
            result = store.submit(user["id"])
        except ValueError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        authorization.audit("procurement.update.submitted", actor_user_id=user["id"], target_type="procurement_update", target_id=update_id)
        return visible_payload(result, user)

    @router.post("/updates/{update_id}/return")
    def return_update(update_id: str, payload: UpdateReasonRequest, request: Request) -> dict[str, Any]:
        user = actor(request, 3)
        try:
            result = store.return_update(update_id, user["id"], payload.reason)
        except ValueError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        authorization.audit("procurement.update.returned", actor_user_id=user["id"], target_type="procurement_update", target_id=update_id)
        return visible_payload(result, user)

    @router.post("/updates/{update_id}/cancel")
    def cancel_update(update_id: str, payload: UpdateReasonRequest, request: Request) -> dict[str, Any]:
        user = actor(request, 3)
        require_activation(user, manage=True)
        try:
            result = store.cancel_update(update_id, user["id"], payload.reason)
        except ValueError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        authorization.audit("procurement.update.cancelled", actor_user_id=user["id"], target_type="procurement_update", target_id=update_id)
        return visible_payload(result, user)

    @router.post("/updates/{update_id}/issues/{issue_id}/review")
    def review_update_issue(update_id: str, issue_id: str, payload: UpdateReasonRequest, request: Request) -> dict[str, Any]:
        user = actor(request, 3)
        require_activation(user)
        require_price_write(user)
        if payload.updated_at is None:
            raise HTTPException(status_code=409, detail="请刷新本轮概况后确认")
        try:
            issue = store.review_issue(issue_id, user["id"], payload.reason, update_id, payload.updated_at)
        except ValueError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        if issue is None:
            raise HTTPException(status_code=404, detail="Issue not found in update")
        authorization.audit("procurement.update.risk_reviewed", actor_user_id=user["id"], target_type="procurement_issue", target_id=issue_id)
        return issue

    @router.post("/updates/{update_id}/publish")
    def publish_update(update_id: str, payload: PublishUpdateRequest, request: Request) -> dict[str, Any]:
        user = actor(request, 3)
        require_activation(user)
        require_price_write(user)
        try:
            result = store.publish_update(update_id, user["id"], payload.mode, payload.activate_at, revision=(payload.updated_at, payload.baseline_id))
        except RuntimeError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except ValueError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        authorization.audit(f"procurement.update.{payload.mode}", actor_user_id=user["id"], target_type="procurement_update", target_id=update_id)
        return visible_payload(result, user)

    @router.post("/updates/{update_id}/cancel-schedule")
    def cancel_schedule(update_id: str, payload: ScheduleCancelRequest, request: Request) -> dict[str, Any]:
        user = actor(request, 3)
        require_activation(user)
        if payload.copy_to_draft:
            require_price_write(user)
        try:
            result = store.cancel_schedule(update_id, user["id"], payload.reason, payload.copy_to_draft)
        except ValueError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        authorization.audit("procurement.update.schedule_cancelled", actor_user_id=user["id"], target_type="procurement_update", target_id=update_id)
        return visible_payload(result, user)

    @router.get("/price-history")
    def price_history(request: Request) -> list[dict[str, Any]]:
        user = actor(request, 2)
        return [
            authorization.filter_readable_fields(
                item,
                HISTORY_PRICE_KEYS,
                user["is_system_admin"],
                user["scope_levels"],
            )
            for item in store.price_history()
        ]

    @router.get("/history/batches")
    def history_batches(request: Request, include_archived: bool = False) -> list[dict[str, Any]]:
        user = actor(request, 2)
        permit_archived(user, include_archived)
        return [visible_payload(item, user, history_fields) for item in store.history_batches(include_archived)]

    @router.get("/history/batches/{batch_id}")
    def history_batch(batch_id: str, request: Request, include_archived: bool = False) -> dict[str, Any]:
        user = actor(request, 2)
        permit_archived(user, include_archived)
        batch = store.history_batch(batch_id, include_archived)
        if batch is None:
            raise HTTPException(status_code=404, detail="History batch not found")
        return visible_payload(batch, user, history_fields)

    @router.get("/history/materials")
    def history_materials(request: Request, include_archived: bool = False) -> list[dict[str, Any]]:
        user = actor(request, 2)
        permit_archived(user, include_archived)
        result = []
        for item in store.history_materials(include_archived):
            result.append(visible_payload(item, user, history_fields))
        return result

    @router.get("/materials/{material_id}")
    def material_detail(material_id: str, request: Request, include_archived: bool = False) -> dict[str, Any]:
        user = actor(request, 2)
        permit_archived(user, include_archived)
        detail = store.material_detail(material_id, include_archived)
        if detail is None:
            raise HTTPException(status_code=404, detail="Material not found")
        result = visible_payload(detail, user)
        result["changes"] = visible_payload({"changes": collaboration.saved_events(store.path, material_id=material_id)}, user)["changes"]
        result["history"] = [visible_payload(item, user, history_fields) for item in detail["history"]]
        return result

    @router.patch("/materials/{material_id}")
    def update_material(material_id: str, payload: MaterialIdentityRequest, request: Request) -> dict[str, Any]:
        user = actor(request, 3)
        require_catalog_management(user)
        current = store.material_detail(material_id)
        if current is None:
            raise HTTPException(status_code=404, detail="Material not found")
        code = payload.code.strip()
        if code != current["material"]["code"] and not user["is_system_admin"] and user["scope_levels"].get("procurement", 0) < 4:
            raise HTTPException(status_code=403, detail="Manager permission required to change material code")
        try:
            result = store.update_material_identity(material_id, code, payload.name, user["id"])
        except LookupError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except RuntimeError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        authorization.audit("procurement.material.updated", actor_user_id=user["id"], target_type="procurement_material", target_id=material_id)
        filtered = visible_payload(result, user)
        filtered["history"] = [visible_payload(item, user, history_fields) for item in result["history"]]
        return filtered

    @router.post("/materials", status_code=201)
    def create_material(payload: MaterialCreateRequest, request: Request):
        user = actor(request, 3)
        require_catalog_management(user)
        if payload.price is not None:
            require_price_write(user)
        try:
            return {"id": store.create_material(payload, user["id"])}
        except RuntimeError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @router.post("/materials/{material_id}/adjustments", status_code=status.HTTP_201_CREATED)
    def adjust_price(material_id: str, payload: PriceAdjustmentRequest, request: Request) -> dict[str, Any]:
        user = actor(request, 3)
        require_price_write(user)
        if payload.updated_at is None:
            raise HTTPException(status_code=409, detail="请刷新原料详情后再保存")
        if payload.price_confirmation is not None:
            require_activation(user)
        try:
            result = store.adjust_price(material_id, payload.price, payload.effective_date, payload.reason, user["id"], payload.target_history_id, payload.price_confirmation, updated_at=payload.updated_at)
        except LookupError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except RuntimeError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        authorization.audit("procurement.price.adjusted", actor_user_id=user["id"], target_type="procurement_material", target_id=material_id)
        return result

    @router.post("/prices/preview-adjustments")
    def preview_prices(payload: PricePreviewRequest, request: Request) -> dict[str, Any]:
        user = actor(request, 3)
        require_price_write(user)
        try:
            return store.preview_prices(payload)
        except LookupError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    @router.post("/prices/bulk-adjustments")
    def bulk_adjust_prices(payload: BulkPriceAdjustmentRequest, request: Request) -> dict[str, Any]:
        user = actor(request, 3)
        require_price_write(user)
        if payload.price_confirmation is not None:
            require_activation(user)
        try:
            update_id = store.bulk_adjust_prices(payload, user["id"])
        except LookupError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except RuntimeError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        authorization.audit("procurement.prices.adjusted", actor_user_id=user["id"], target_type="procurement_update", target_id=update_id)
        return overview(request)

    @router.get("/preferences")
    def preferences(request: Request) -> dict[str, Any]:
        user = actor(request, 2)
        return store.preferences(user["id"])

    @router.put("/preferences")
    def save_preferences(payload: ProcurementPreferencesRequest, request: Request) -> dict[str, Any]:
        user = actor(request, 2)
        try:
            return store.save_preferences(user["id"], payload.ledger_columns, payload.history_view, payload.ledger_view, payload.ledger_page_size)
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    def archive_item(kind: str, item_id: str, archived: bool, request: Request) -> dict[str, bool]:
        user = actor(request, 4)
        require_catalog_management(user)
        try:
            found = store.set_archive(kind, item_id, archived, user["id"])
        except ValueError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        if not found:
            raise HTTPException(status_code=404, detail="Item not found")
        authorization.audit(f"procurement.{kind}.{'archived' if archived else 'restored'}", actor_user_id=user["id"], target_type=f"procurement_{kind}", target_id=item_id)
        return {"ok": True}

    @router.post("/imports/{item_id}/archive")
    def archive_import(item_id: str, request: Request) -> dict[str, bool]:
        return archive_item("imports", item_id, True, request)

    @router.post("/imports/{item_id}/restore")
    def restore_import(item_id: str, request: Request) -> dict[str, bool]:
        return archive_item("imports", item_id, False, request)

    @router.post("/materials/{item_id}/archive")
    def archive_material(item_id: str, request: Request) -> dict[str, bool]:
        return archive_item("materials", item_id, True, request)

    @router.post("/materials/{item_id}/restore")
    def restore_material(item_id: str, request: Request) -> dict[str, bool]:
        return archive_item("materials", item_id, False, request)

    @router.post("/submit")
    def submit(request: Request) -> dict[str, Any]:
        user = actor(request, 3)
        try:
            submission = store.submit(user["id"])
        except ValueError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        authorization.audit(
            "procurement.prices.submitted",
            actor_user_id=user["id"],
            target_type="procurement_working_state",
            target_id="current",
        )
        return visible_payload(submission, user)

    @router.post("/batches/publish", status_code=status.HTTP_201_CREATED)
    def publish_batch(request: Request) -> dict[str, Any]:
        require_activation(actor(request, 3))
        raise HTTPException(status_code=409, detail="请使用带版本核对的启用确认入口")
        user = actor(request, 4)

    @router.get("/batches/{batch_id}")
    def get_batch(batch_id: str, request: Request) -> dict[str, Any]:
        user = actor(request, 2)
        batch = store.get_batch(batch_id)
        if batch is None:
            raise HTTPException(status_code=404, detail="Price batch not found")
        return visible_payload(batch, user)

    return router


def _parse_delimited(content: str) -> list[dict[str, Any]]:
    text = content.lstrip("\ufeff").strip()
    if not text:
        raise ValueError("导入内容不能为空")
    first_line = text.splitlines()[0]
    delimiter = "\t" if first_line.count("\t") > first_line.count(",") else ","
    reader = csv.DictReader(io.StringIO(text), delimiter=delimiter)
    if reader.fieldnames is None:
        raise ValueError("未识别到表头")
    header_map = {_normalize_header(name): name for name in reader.fieldnames if name is not None}
    aliases = {
        "code": ("编号", "原料编码", "编码"),
        "name": ("名称", "原料名称", "品名"),
        "unit": ("单位", "计量单位"),
        "latest_price": ("最新价", "最新价格"),
        "inventory_price": ("库存价", "库存价格"),
        "in_transit_price": ("在途价", "在途价格"),
        "previous_latest_price": ("上次最新价", "上次价格"),
    }
    columns: dict[str, str | None] = {}
    for key, candidates in aliases.items():
        columns[key] = next((header_map[candidate] for candidate in candidates if candidate in header_map), None)
    if any(columns[key] is None for key in ("code", "name", "unit")):
        raise ValueError("导入内容必须包含编号、名称和单位")
    if not any(columns[key] is not None for key in ("latest_price", "inventory_price", "in_transit_price")):
        raise ValueError("导入内容至少需要一个价格列")
    rows: list[dict[str, Any]] = []
    for index, raw in enumerate(reader, start=2):
        if not any(str(value or "").strip() for value in raw.values()):
            continue
        code = str(raw.get(columns["code"] or "", "")).strip()
        name = str(raw.get(columns["name"] or "", "")).strip()
        unit = str(raw.get(columns["unit"] or "", "")).strip()
        validation_issues = [] if code and name and unit else ["invalid_identity"]
        prices = {}
        for key in ("latest_price", "inventory_price", "in_transit_price", "previous_latest_price"):
            try:
                prices[key] = _price_from_row(raw, columns[key], index)
            except ValueError:
                prices[key] = None
                if "invalid_price" not in validation_issues:
                    validation_issues.append("invalid_price")
        rows.append({
            "code": code,
            "name": name,
            "unit": unit,
            **prices,
            "validation_issues": validation_issues,
            "source_row": index,
            "raw_price": str(raw.get(columns["latest_price"] or "") or ""),
        })
    if not rows:
        raise ValueError("导入内容没有有效数据行")
    return rows


def _price_from_row(raw: dict[str, str | None], column: str | None, line: int) -> Decimal | None:
    if column is None:
        return None
    value = str(raw.get(column) or "").strip()
    if not value:
        return None
    try:
        number = Decimal(value.replace(",", ""))
        _decimal_text(number)
    except InvalidOperation as error:
        raise ValueError(f"第 {line} 行的 {column} 不是有效数字") from error
    if not number.is_finite() or number < 0:
        raise ValueError(f"第 {line} 行的 {column} 不能为负数或无穷值")
    return number


def _normalize_header(value: str) -> str:
    return value.strip().replace("（元/kg）", "").replace("(元/kg)", "")


def _suggested_price(row: dict[str, Any]) -> Decimal | None:
    return _first_decimal(row["latest_price"], row["in_transit_price"], row["inventory_price"])


def _first_decimal(*values: Any) -> Decimal | None:
    return next((_decimal(value) for value in values if value is not None), None)


def _decimal(value: Any) -> Decimal | None:
    return None if value is None else Decimal(str(value))


def _decimal_text(value: Any) -> str | None:
    number = _decimal(value)
    if number is None:
        return None
    from api.procurement_excel import price_value
    result, kind = price_value(number)
    if kind != "number":
        raise ValueError("价格需为非负单值，最多18位整数和8位小数")
    return result


def _has_price_spike(current: Decimal | None, previous: Decimal | None) -> bool:
    if current is None or previous is None:
        return False
    if previous == 0:
        return current != 0
    return abs(current - previous) / abs(previous) > Decimal("0.15")


def _serialize_import_row(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "source_row": row.get("source_row"),
        "raw_price": row.get("raw_price"),
        "code": row["code"],
        "name": row["name"],
        "unit": row["unit"],
        "latest_price": _decimal_text(row["latest_price"]),
        "inventory_price": _decimal_text(row["inventory_price"]),
        "in_transit_price": _decimal_text(row["in_transit_price"]),
        "previous_latest_price": _decimal_text(row["previous_latest_price"]),
    }


def _material_from_row(row: tuple[Any, ...]) -> dict[str, Any]:
    latest, inventory, in_transit = row[4], row[5], row[6]
    return {
        "id": str(row[0]),
        "code": str(row[1]),
        "name": str(row[2]),
        "unit": str(row[3]),
        "latest_price": latest,
        "previous_latest_price": row[7],
        "inventory_price": inventory,
        "in_transit_price": in_transit,
        "suggested_price": _decimal_text(_first_decimal(latest, in_transit, inventory)),
        "updated_at": str(row[8]),
        "price_date": _price_date(str(row[9] or ""), str(row[8])),
    }


def _price_date(source_name: str, updated_at: str) -> str:
    return _recorded_at(source_name, updated_at)[:10]


def _recorded_at(source_name: str, created_at: str) -> str:
    match = re.search(r"\b(20\d{2}-\d{2}-\d{2})\b", source_name)
    return f"{match.group(1)}T00:00:00+00:00" if match else created_at


def _issue_from_row(row: tuple[Any, ...]) -> dict[str, Any]:
    kind = str(row[4])
    return {
        "id": str(row[0]),
        "material_id": str(row[1]),
        "material_code": str(row[2]),
        "material_name": str(row[3]),
        "kind": kind,
        "label": ISSUE_LABELS[kind],
        "status": str(row[5]),
        "created_at": str(row[6]),
        "reviewed_at": str(row[7]) if row[7] is not None else None,
    }


def _change(current: Any, previous: Any) -> float | None:
    if current is None or previous is None:
        return None
    current_number = Decimal(str(current))
    previous_number = Decimal(str(previous))
    if previous_number == 0:
        return 0.0 if current_number == 0 else None
    return float((current_number - previous_number) / abs(previous_number))


def _movement_counts(current: dict[str, dict[str, Any]], previous: dict[str, dict[str, Any]]) -> dict[str, int]:
    counts = {"up_count": 0, "down_count": 0, "flat_count": 0, "missing_count": 0}
    for code, row in current.items():
        change = _change(row["latest_price"], previous.get(code, {}).get("latest_price"))
        if row["latest_price"] is None:
            counts["missing_count"] += 1
        elif change is None or change == 0:
            counts["flat_count"] += 1
        elif change > 0:
            counts["up_count"] += 1
        else:
            counts["down_count"] += 1
    return counts
