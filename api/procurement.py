from __future__ import annotations

import csv
import io
import sqlite3
from collections import Counter
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, Field

from api.authorization import AuthorizationStore
from api.settings import Settings


PROCUREMENT_SCHEMA_VERSION = 1
PRICE_FIELD_ID = "procurement.material_unit_price"
PRICE_KEYS = {
    "latest_price": PRICE_FIELD_ID,
    "inventory_price": PRICE_FIELD_ID,
    "in_transit_price": PRICE_FIELD_ID,
    "suggested_price": PRICE_FIELD_ID,
    "recommended_price": PRICE_FIELD_ID,
}
HISTORY_PRICE_KEYS = {
    "latest_price": "procurement.supplier_quote",
    "inventory_price": "procurement.supplier_quote",
    "in_transit_price": "procurement.supplier_quote",
}
ISSUE_LABELS = {
    "missing_price": "缺少可用价格",
    "duplicate_code": "导入内容存在重复编码",
    "unit_conflict": "计量单位冲突",
    "price_spike": "最新价波动超过 15%",
}


class DelimitedImportRequest(BaseModel):
    source_name: str = Field(min_length=1, max_length=120)
    content: str = Field(min_length=1, max_length=1_000_000)


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
                    ("workbench_procurement_schema_version", PROCUREMENT_SCHEMA_VERSION),
                )
                version = (PROCUREMENT_SCHEMA_VERSION,)
            if int(version[0]) != PROCUREMENT_SCHEMA_VERSION:
                raise RuntimeError("Unsupported procurement workbench schema version")

    def schema_version(self) -> int:
        with sqlite3.connect(self.path) as connection:
            row = connection.execute(
                "SELECT value FROM schema_metadata WHERE key = ?",
                ("workbench_procurement_schema_version",),
            ).fetchone()
        if row is None:
            raise RuntimeError("Procurement workbench schema is not initialized")
        return int(row[0])

    def preview_import(self, content: str) -> dict[str, Any]:
        existing = self._materials_by_code()
        rows = _parse_delimited(content)
        counts = Counter(row["code"] for row in rows)
        preview_rows = []
        for row in rows:
            issues: list[str] = []
            current = existing.get(row["code"])
            if counts[row["code"]] > 1:
                issues.append("duplicate_code")
            if current is not None and current["unit"] != row["unit"]:
                issues.append("unit_conflict")
            suggested = _suggested_price(row)
            if suggested is None:
                issues.append("missing_price")
            previous = current["latest_price"] if current is not None else row["previous_latest_price"]
            if _has_price_spike(row["latest_price"], previous):
                issues.append("price_spike")
            preview_rows.append({
                **_serialize_import_row(row),
                "suggested_price": _decimal_text(suggested),
                "issues": issues,
                "importable": not any(issue in {"duplicate_code", "unit_conflict"} for issue in issues),
            })
        return {
            "received_count": len(preview_rows),
            "importable_count": sum(1 for row in preview_rows if row["importable"]),
            "skipped_count": sum(1 for row in preview_rows if not row["importable"]),
            "rows": preview_rows,
        }

    def confirm_import(self, source_name: str, content: str, actor_user_id: str) -> dict[str, Any]:
        preview = self.preview_import(content)
        if preview["skipped_count"]:
            raise ValueError("存在重复编码或计量单位冲突，请修正后重新检查")
        import_id = str(uuid4())
        now = datetime.now(UTC).isoformat()
        imported_count = 0
        with sqlite3.connect(self.path) as connection:
            for row in preview["rows"]:
                if not row["importable"]:
                    continue
                existing = connection.execute(
                    "SELECT id, latest_price FROM procurement_materials WHERE code = ?",
                    (row["code"],),
                ).fetchone()
                material_id = str(existing[0]) if existing else str(uuid4())
                previous_latest = str(existing[1]) if existing and existing[1] is not None else row["previous_latest_price"]
                connection.execute(
                    """
                    INSERT INTO procurement_materials (
                        id, code, name, unit, latest_price, inventory_price, in_transit_price,
                        previous_latest_price, last_import_id, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(code) DO UPDATE SET
                        name = excluded.name,
                        unit = excluded.unit,
                        latest_price = excluded.latest_price,
                        inventory_price = excluded.inventory_price,
                        in_transit_price = excluded.in_transit_price,
                        previous_latest_price = procurement_materials.latest_price,
                        last_import_id = excluded.last_import_id,
                        updated_at = excluded.updated_at
                    """,
                    (
                        material_id,
                        row["code"],
                        row["name"],
                        row["unit"],
                        row["latest_price"],
                        row["inventory_price"],
                        row["in_transit_price"],
                        previous_latest,
                        import_id,
                        now,
                    ),
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
                        now,
                    ),
                )
                self._sync_issue(connection, material_id, "missing_price", "missing_price" in row["issues"], now)
                self._sync_issue(connection, material_id, "price_spike", "price_spike" in row["issues"], now)
                imported_count += 1
            connection.execute(
                "INSERT INTO procurement_imports VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    import_id,
                    source_name.strip(),
                    preview["received_count"],
                    imported_count,
                    preview["received_count"] - imported_count,
                    actor_user_id,
                    now,
                ),
            )
            connection.execute(
                "UPDATE procurement_working_state SET latest_import_id = ?, submitted_by = NULL, submitted_at = NULL WHERE id = 1",
                (import_id,),
            )
        return {
            "id": import_id,
            "source_name": source_name.strip(),
            "received_count": preview["received_count"],
            "imported_count": imported_count,
            "skipped_count": preview["received_count"] - imported_count,
            "created_at": now,
        }

    def overview(self) -> dict[str, Any]:
        with sqlite3.connect(self.path) as connection:
            material_rows = connection.execute(
                """
                SELECT id, code, name, unit, latest_price, inventory_price, in_transit_price,
                       previous_latest_price, updated_at
                FROM procurement_materials ORDER BY code
                """
            ).fetchall()
            issue_rows = connection.execute(
                """
                SELECT issues.id, issues.material_id, materials.code, materials.name,
                       issues.kind, issues.status, issues.created_at, issues.reviewed_at
                FROM procurement_issues AS issues
                JOIN procurement_materials AS materials ON materials.id = issues.material_id
                ORDER BY CASE issues.status WHEN 'open' THEN 0 WHEN 'reviewed' THEN 1 ELSE 2 END,
                         issues.created_at DESC
                """
            ).fetchall()
            batch_rows = connection.execute(
                "SELECT id, version, published_at, item_count FROM procurement_price_batches ORDER BY version DESC"
            ).fetchall()
            working_state = connection.execute(
                "SELECT submitted_by, submitted_at FROM procurement_working_state WHERE id = 1"
            ).fetchone()
        materials = [_material_from_row(row) for row in material_rows]
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
            "issues": issues,
            "batches": [
                {"id": str(row[0]), "version": int(row[1]), "published_at": str(row[2]), "item_count": int(row[3])}
                for row in batch_rows
            ],
            "working_state": {
                "status": "submitted" if working_state and working_state[1] else ("ready" if materials and not open_issues else "draft"),
                "submitted_by": str(working_state[0]) if working_state and working_state[0] is not None else None,
                "submitted_at": str(working_state[1]) if working_state and working_state[1] is not None else None,
            },
        }

    def submit(self, actor_user_id: str) -> dict[str, Any]:
        now = datetime.now(UTC).isoformat()
        with sqlite3.connect(self.path) as connection:
            if int(connection.execute("SELECT COUNT(*) FROM procurement_materials").fetchone()[0]) == 0:
                raise ValueError("没有可提交的原料数据")
            open_issue_count = int(connection.execute(
                "SELECT COUNT(*) FROM procurement_issues WHERE status = 'open'"
            ).fetchone()[0])
            if open_issue_count:
                raise ValueError(f"仍有 {open_issue_count} 个未解决问题，不能提交")
            connection.execute(
                "UPDATE procurement_working_state SET submitted_by = ?, submitted_at = ? WHERE id = 1",
                (actor_user_id, now),
            )
        return {"status": "submitted", "submitted_by": actor_user_id, "submitted_at": now}

    def review_issue(self, issue_id: str, actor_user_id: str) -> dict[str, Any] | None:
        now = datetime.now(UTC).isoformat()
        with sqlite3.connect(self.path) as connection:
            issue = connection.execute(
                "SELECT kind, status FROM procurement_issues WHERE id = ?",
                (issue_id,),
            ).fetchone()
            if issue is None:
                return None
            if str(issue[0]) != "price_spike":
                raise ValueError("该问题必须通过补充或修正数据解决")
            if str(issue[1]) == "open":
                connection.execute(
                    "UPDATE procurement_issues SET status = 'reviewed', reviewed_by = ?, reviewed_at = ? WHERE id = ?",
                    (actor_user_id, now, issue_id),
                )
        return next(issue for issue in self.overview()["issues"] if issue["id"] == issue_id)

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

    def publish_batch(self, actor_user_id: str) -> dict[str, Any]:
        now = datetime.now(UTC).isoformat()
        with sqlite3.connect(self.path) as connection:
            open_issue_count = int(connection.execute(
                "SELECT COUNT(*) FROM procurement_issues WHERE status = 'open'"
            ).fetchone()[0])
            if open_issue_count:
                raise ValueError(f"仍有 {open_issue_count} 个未解决问题，不能发布")
            working_state = connection.execute(
                "SELECT submitted_by, submitted_at FROM procurement_working_state WHERE id = 1"
            ).fetchone()
            if working_state is None or working_state[1] is None:
                raise ValueError("当前价格工作稿尚未提交")
            if str(working_state[0]) == actor_user_id:
                raise ValueError("提交人与发布人不能是同一账号")
            materials = connection.execute(
                "SELECT id, code, name, unit, latest_price, inventory_price, in_transit_price FROM procurement_materials ORDER BY code"
            ).fetchall()
            if not materials:
                raise ValueError("没有可发布的原料数据")
            version = int(connection.execute(
                "SELECT COALESCE(MAX(version), 0) + 1 FROM procurement_price_batches"
            ).fetchone()[0])
            batch_id = str(uuid4())
            connection.execute(
                "INSERT INTO procurement_price_batches VALUES (?, ?, ?, ?, ?)",
                (batch_id, version, actor_user_id, now, len(materials)),
            )
            connection.executemany(
                "INSERT INTO procurement_price_batch_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                [
                    (
                        batch_id,
                        str(row[0]),
                        str(row[1]),
                        str(row[2]),
                        str(row[3]),
                        row[4],
                        row[5],
                        row[6],
                        _decimal_text(_first_decimal(row[4], row[6], row[5])),
                    )
                    for row in materials
                ],
            )
            connection.execute(
                "UPDATE procurement_working_state SET submitted_by = NULL, submitted_at = NULL WHERE id = 1"
            )
        return {"id": batch_id, "version": version, "published_at": now, "item_count": len(materials)}

    def get_batch(self, batch_id: str) -> dict[str, Any] | None:
        with sqlite3.connect(self.path) as connection:
            batch = connection.execute(
                "SELECT id, version, published_at, item_count FROM procurement_price_batches WHERE id = ?",
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
        return {
            "id": str(batch[0]),
            "version": int(batch[1]),
            "published_at": str(batch[2]),
            "item_count": int(batch[3]),
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
                "SELECT code, unit, latest_price FROM procurement_materials"
            ).fetchall()
        return {
            str(row[0]): {"unit": str(row[1]), "latest_price": _decimal(row[2])}
            for row in rows
        }

    @staticmethod
    def _sync_issue(connection: sqlite3.Connection, material_id: str, kind: str, present: bool, now: str) -> None:
        if present:
            connection.execute(
                "INSERT OR IGNORE INTO procurement_issues VALUES (?, ?, ?, 'open', ?, NULL, NULL)",
                (str(uuid4()), material_id, kind, now),
            )
        else:
            connection.execute(
                "UPDATE procurement_issues SET status = 'resolved' WHERE material_id = ? AND kind = ? AND status = 'open'",
                (material_id, kind),
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
            raise HTTPException(status_code=403, detail="Price field write permission required")

    def visible_payload(payload: dict[str, Any], user: dict[str, Any]) -> dict[str, Any]:
        return authorization.filter_readable_fields(
            payload,
            PRICE_KEYS,
            user["is_system_admin"],
            user["scope_levels"],
        )

    @router.get("/overview")
    def overview(request: Request) -> dict[str, Any]:
        user = actor(request, 2)
        result = store.overview()
        result["materials"] = [visible_payload(material, user) for material in result["materials"]]
        return result

    @router.post("/import-preview")
    def preview(payload: DelimitedImportRequest, request: Request) -> dict[str, Any]:
        user = actor(request, 3)
        require_price_write(user)
        try:
            return store.preview_import(payload.content)
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @router.post("/imports", status_code=status.HTTP_201_CREATED)
    def confirm_import(payload: DelimitedImportRequest, request: Request) -> dict[str, Any]:
        user = actor(request, 3)
        require_price_write(user)
        try:
            result = store.confirm_import(payload.source_name, payload.content, user["id"])
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
    def review_issue(issue_id: str, request: Request) -> dict[str, Any]:
        user = actor(request, 4)
        try:
            issue = store.review_issue(issue_id, user["id"])
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
        return submission

    @router.post("/batches/publish", status_code=status.HTTP_201_CREATED)
    def publish_batch(request: Request) -> dict[str, Any]:
        user = actor(request, 4)
        try:
            batch = store.publish_batch(user["id"])
        except ValueError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        authorization.audit(
            "procurement.batch.published",
            actor_user_id=user["id"],
            target_type="procurement_price_batch",
            target_id=batch["id"],
        )
        return batch

    @router.get("/batches/{batch_id}")
    def get_batch(batch_id: str, request: Request) -> dict[str, Any]:
        user = actor(request, 2)
        batch = store.get_batch(batch_id)
        if batch is None:
            raise HTTPException(status_code=404, detail="Price batch not found")
        batch["items"] = [visible_payload(item, user) for item in batch["items"]]
        return batch

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
        if not code or not name or not unit:
            raise ValueError(f"第 {index} 行缺少编号、名称或单位")
        rows.append({
            "code": code,
            "name": name,
            "unit": unit,
            "latest_price": _price_from_row(raw, columns["latest_price"], index),
            "inventory_price": _price_from_row(raw, columns["inventory_price"], index),
            "in_transit_price": _price_from_row(raw, columns["in_transit_price"], index),
            "previous_latest_price": _price_from_row(raw, columns["previous_latest_price"], index),
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
    return format(number.normalize(), "f")


def _has_price_spike(current: Decimal | None, previous: Decimal | None) -> bool:
    if current is None or previous is None:
        return False
    if previous == 0:
        return current != 0
    return abs(current - previous) / abs(previous) > Decimal("0.15")


def _serialize_import_row(row: dict[str, Any]) -> dict[str, Any]:
    return {
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
        "inventory_price": inventory,
        "in_transit_price": in_transit,
        "suggested_price": _decimal_text(_first_decimal(latest, in_transit, inventory)),
        "updated_at": str(row[8]),
    }


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
