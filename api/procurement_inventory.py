"""Current inventory from a complete source report, independent of price rounds."""
from __future__ import annotations

import hashlib
import json
import sqlite3
from datetime import UTC, datetime
from pathlib import Path

from api.procurement_collaboration import admin_event
from api.procurement_excel import TOTAL, price_value, read_workbook, text


def initialize(db: sqlite3.Connection) -> None:
    if not db.in_transaction:
        db.execute("BEGIN IMMEDIATE")
    db.execute("""CREATE TABLE procurement_inventory (
        material_id TEXT PRIMARY KEY REFERENCES procurement_materials(id),
        quantity TEXT NOT NULL, price TEXT, raw_price TEXT NOT NULL,
        source_sha256 TEXT NOT NULL, sheet TEXT NOT NULL, source_row INTEGER NOT NULL,
        imported_by TEXT NOT NULL, imported_at TEXT NOT NULL
    )""")
    for user_id, raw in db.execute("SELECT user_id, ledger_columns FROM procurement_user_preferences").fetchall():
        columns = ["inventory_quantity", *("inventory_price" if col == "previous_latest_price" else col for col in json.loads(raw))]
        db.execute("UPDATE procurement_user_preferences SET ledger_columns=? WHERE user_id=?",
                   (json.dumps(list(dict.fromkeys(columns))), user_id))
    db.execute("UPDATE schema_metadata SET value=6 WHERE key='workbench_procurement_schema_version'")


def _preview(db: sqlite3.Connection, content: bytes) -> dict:
    sheets = read_workbook(content)
    if TOTAL not in sheets:
        raise ValueError("需要原料行情总表")
    header, *source_rows = sheets[TOTAL]
    header = [text(cell) for cell in header]
    columns = {}
    for key, names in {"code": {"品名", "编号", "原料编号"}, "quantity": {"库存数量", "库存量"}, "price": {"库存价格", "库存价"}}.items():
        matches = [i for i, cell in enumerate(header) if cell in names]
        if len(matches) != 1:
            raise ValueError(f"总表需要唯一的{next(iter(sorted(names)))}列")
        columns[key] = matches[0]
    catalog = db.execute("SELECT id,code,unit FROM procurement_materials WHERE archived_at IS NULL ORDER BY code,id").fetchall()
    known = {code: (material_id, unit) for material_id, code, unit in catalog}
    if len(known) != len(catalog):
        raise ValueError("现有原料编号重复，请先核对目录")
    rows, seen = [], set()
    for row_number, source in enumerate(source_rows, 2):
        code = text(source[columns["code"]])
        if not code:
            if any(text(value) for value in source):
                raise ValueError(f"第{row_number}行缺少原料编号")
            continue
        if code in seen or code not in known:
            raise ValueError(f"第{row_number}行原料编号重复或不在现有台账：{code}")
        seen.add(code)
        material_id, unit = known[code]
        if unit != "kg":
            raise ValueError(f"{code} 的台账单位不是 kg，不能直接使用本报表")
        quantity, quantity_kind = price_value(source[columns["quantity"]])
        raw_price = text(source[columns["price"]])
        price, price_kind = price_value(raw_price)
        if quantity_kind != "number" or price_kind not in {"number", "missing"}:
            raise ValueError(f"第{row_number}行库存数量或库存价无效：{code}")
        rows.append({"material_id": material_id, "code": code, "quantity": quantity,
                     "price": None if price == "0" else price, "raw_price": raw_price, "source_row": row_number})
    if not rows or seen != set(known):
        raise ValueError("报表未完整匹配现有在用原料，请核对后重新预检")
    return {"sha256": hashlib.sha256(content).hexdigest(),
            "catalog_sha256": hashlib.sha256(json.dumps(catalog, ensure_ascii=False).encode()).hexdigest(),
            "sheet": TOTAL, "matched": len(rows), "priced": sum(row["price"] is not None for row in rows),
            "missing_price": sum(row["price"] is None for row in rows),
            "zero_quantity": sum(row["quantity"] == "0" for row in rows), "rows": rows}


def inventory_preview(path: Path, content: bytes) -> dict:
    with sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True) as db:
        return _preview(db, content)


def import_inventory(path: Path, source: Path, actor_id: str, *, expected_sha256: str, expected_catalog_sha256: str) -> dict:
    content = source.read_bytes()
    digest = hashlib.sha256(content).hexdigest()
    if digest != expected_sha256:
        raise ValueError("文件已变化，请重新预检")
    stored = path.parent / "controlled-work" / "procurement-sources" / f"{digest}.xlsx"
    created_archive = False
    try:
        with sqlite3.connect(path) as db:
            db.execute("BEGIN IMMEDIATE")
            admin = db.execute("SELECT access_level,is_active FROM identity_users WHERE id=?", (actor_id,)).fetchone()
            if admin != (5, 1):
                raise PermissionError("库存导入仅限有效系统管理员")
            preview = _preview(db, content)
            if preview["catalog_sha256"] != expected_catalog_sha256:
                raise ValueError("原料匹配已变化，请重新预检")
            stored.parent.mkdir(parents=True, exist_ok=True)
            if stored.exists() and stored.read_bytes() != content:
                raise ValueError("来源归档校验失败")
            if not stored.exists():
                with stored.open("xb") as stream:
                    created_archive = True
                    stream.write(content)
            now = datetime.now(UTC).isoformat()
            db.execute("INSERT OR IGNORE INTO procurement_source_imports VALUES (?,?,?,?,?)",
                       (digest, source.name, str(stored), actor_id, now))
            updated = 0
            for row in preview["rows"]:
                values = (row["quantity"], row["price"], row["raw_price"], digest, TOTAL, row["source_row"])
                old = db.execute("SELECT quantity,price,raw_price,source_sha256,sheet,source_row FROM procurement_inventory WHERE material_id=?",
                                 (row["material_id"],)).fetchone()
                if old == values:
                    continue
                db.execute("""INSERT INTO procurement_inventory VALUES (?,?,?,?,?,?,?,?,?)
                    ON CONFLICT(material_id) DO UPDATE SET quantity=excluded.quantity,price=excluded.price,
                    raw_price=excluded.raw_price,source_sha256=excluded.source_sha256,sheet=excluded.sheet,
                    source_row=excluded.source_row,imported_by=excluded.imported_by,imported_at=excluded.imported_at""",
                           (row["material_id"], *values, actor_id, now))
                updated += 1
            result = {key: value for key, value in preview.items() if key != "rows"}
            result["updated"] = updated
            if updated:
                admin_event(db, actor_id, "inventory.imported", digest, result)
                from api.research import enqueue
                enqueue(db, "库存价格更新")
            return result
    except Exception:
        if created_archive:
            stored.unlink(missing_ok=True)
        raise
