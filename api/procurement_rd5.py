"""Administrator-only RD5 material intake and reproducible recipe preparation."""
from __future__ import annotations

import hashlib
import json
import sqlite3
from datetime import UTC, date, datetime
from decimal import Decimal
from pathlib import Path
from uuid import uuid4

from api import procurement_collaboration as collaboration
from api.research_formulas import DEFAULT_COMPOSITE, OMITTED_CODES, PRICE_SHEET, calculate, parse_workbook


def initialize(db: sqlite3.Connection) -> None:
    if not db.in_transaction:
        db.execute("BEGIN IMMEDIATE")
    db.execute("""CREATE TABLE procurement_inventory_v7 (
        material_id TEXT PRIMARY KEY REFERENCES procurement_materials(id),
        quantity TEXT, price TEXT, raw_price TEXT NOT NULL,
        source_sha256 TEXT NOT NULL, sheet TEXT NOT NULL, source_row INTEGER NOT NULL,
        imported_by TEXT NOT NULL, imported_at TEXT NOT NULL
    )""")
    db.execute("INSERT INTO procurement_inventory_v7 SELECT * FROM procurement_inventory")
    db.execute("DROP TABLE procurement_inventory")
    db.execute("ALTER TABLE procurement_inventory_v7 RENAME TO procurement_inventory")
    db.execute("""CREATE TABLE IF NOT EXISTS procurement_rd5_imports (
        sha256 TEXT PRIMARY KEY, imported_by TEXT NOT NULL, imported_at TEXT NOT NULL,
        result_json TEXT NOT NULL, package_json TEXT NOT NULL
    )""")
    db.execute("UPDATE schema_metadata SET value=7 WHERE key='workbench_procurement_schema_version'")


def _receipt(db, digest):
    if not db.execute("SELECT 1 FROM sqlite_master WHERE name='procurement_rd5_imports'").fetchone():
        return None
    return db.execute("SELECT result_json,package_json FROM procurement_rd5_imports WHERE sha256=?", (digest,)).fetchone()


def _state_digest(db):
    state = {}
    for table in ("procurement_materials", "procurement_material_aliases", "procurement_inventory",
                  "procurement_departments", "procurement_department_materials", "procurement_price_batches",
                  "procurement_price_batch_items", "procurement_updates", "procurement_update_items"):
        state[table] = sorted(db.execute(f"SELECT * FROM {table}").fetchall(), key=repr)
    return hashlib.sha256(json.dumps(state, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def _plan(db, package):
    catalog = {r[1]: {"id": r[0], "archived": r[3] is not None, "unit": r[2]} for r in
               db.execute("SELECT id,code,unit,archived_at FROM procurement_materials")}
    aliases = dict(db.execute("SELECT alias_code,material_id FROM procurement_material_aliases"))
    department = db.execute("SELECT id FROM procurement_departments WHERE name='研发五部'").fetchone()
    if not department:
        raise ValueError("研发五部分流不存在")
    related = {line["code"] for recipe in package["recipes"] for line in recipe["lines"] if line["kind"] == "material"}
    rows = []
    for item in package["materials"]:
        code = item["code"]
        old = catalog.get(code)
        if code in aliases and (old is None or aliases[code] != old["id"]):
            raise ValueError(f"{code} 与历史别名冲突，请先核对")
        if old and not old["archived"]:
            action = "keep"
        elif code in OMITTED_CODES:
            if code in related:
                raise ValueError(f"已排除的原料 {code} 被配方引用，请重新确认范围")
            action = "omit"
        elif item["latest_price"] is not None or item["inventory_price"] is not None or code in related:
            action = "restore" if old else "create"
        else:
            action = "omit"
        if action != "omit" and old and old["unit"] != "kg":
            raise ValueError(f"{code} 的现有单位不是 kg")
        rows.append({**item, "action": action, "material_id": old["id"] if old else None})
    included = [r for r in rows if r["action"] != "omit"]
    selected = [r for r in included if r["action"] != "keep"]
    active_count = sum(not r["archived"] for r in catalog.values())
    current_links = {r[0] for r in db.execute("SELECT material_id FROM procurement_department_materials WHERE department_id=?", (department[0],))}
    existing_new_links = {r["material_id"] for r in included if r["material_id"]} - current_links
    return {"sha256": package["source_sha256"], "state_sha256": _state_digest(db), "department_id": department[0],
        "counts": {"keep": sum(r["action"] == "keep" for r in rows), "restore": sum(r["action"] == "restore" for r in rows),
            "create": sum(r["action"] == "create" for r in rows), "omit": sum(r["action"] == "omit" for r in rows),
            "active_before": active_count, "active_after": active_count + len(selected),
            "department_before": len(current_links), "department_after": len(current_links) + len(existing_new_links) + sum(r["action"] == "create" for r in rows),
            "latest_prices": sum(r["latest_price"] is not None for r in selected),
            "inventory_prices": sum(r["inventory_price"] not in (None, "0") for r in selected),
            "recipes": sum(r["kind"] == "recipe" for r in package["recipes"]),
            "recipe_lines": sum(len(r["lines"]) for r in package["recipes"] if r["kind"] == "recipe"),
            "composites": sum(r["kind"] == "composite" for r in package["recipes"])}, "rows": rows}


def preview(path: Path, content: bytes) -> dict:
    package = parse_workbook(content)
    with sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True) as db:
        receipt = _receipt(db, package["source_sha256"])
        if receipt:
            return {**json.loads(receipt[0]), "already_imported": True}
        return _plan(db, package)


def import_rd5(path: Path, source: Path, actor_id: str, *, expected_sha256: str,
               expected_state_sha256: str, effective_date: date) -> dict:
    from api.procurement import ProcurementStore

    content = source.read_bytes()
    if hashlib.sha256(content).hexdigest() != expected_sha256:
        raise ValueError("文件已变化，请重新预检")
    package = parse_workbook(content)
    stored = path.parent / "controlled-work" / "procurement-sources" / f"{expected_sha256}.xlsx"
    created_archive = False
    try:
        with sqlite3.connect(path) as db:
            db.execute("BEGIN IMMEDIATE")
            admin = db.execute("SELECT access_level,is_active FROM identity_users WHERE id=?", (actor_id,)).fetchone()
            if admin != (5, 1):
                raise PermissionError("研发五部导入仅限有效系统管理员")
            collaboration.require_current(path, actor_id, "can_activate")
            receipt = _receipt(db, expected_sha256)
            if receipt:
                return {**json.loads(receipt[0]), "already_imported": True}
            version = db.execute("SELECT value FROM schema_metadata WHERE key='workbench_procurement_schema_version'").fetchone()
            if not version or int(version[0]) != 7:
                raise ValueError("请先升级采购数据结构至版本7")
            plan = _plan(db, package)
            if plan["state_sha256"] != expected_state_sha256:
                raise ValueError("目录、分流或价格状态已变化，请重新预检")
            if db.execute("SELECT 1 FROM procurement_updates WHERE status NOT IN ('published','cancelled')").fetchone():
                raise ValueError("存在未完成的采购价格批次，请先处理后再导入")
            selected = [r for r in plan["rows"] if r["action"] in {"restore", "create"}]
            if not selected:
                raise ValueError("没有待补入原料，请核对来源及导入记录")
            now = datetime.now(UTC).isoformat()
            stored.parent.mkdir(parents=True, exist_ok=True)
            if stored.exists() and stored.read_bytes() != content:
                raise ValueError("来源归档校验失败")
            if not stored.exists():
                with stored.open("xb") as stream:
                    created_archive = True
                    stream.write(content)
            db.execute("INSERT OR IGNORE INTO procurement_source_imports VALUES (?,?,?,?,?)",
                       (expected_sha256, source.name, str(stored), actor_id, now))
            added_links = []
            for row in plan["rows"]:
                if row["action"] == "omit":
                    continue
                if row["action"] == "create":
                    row["material_id"] = str(uuid4())
                    db.execute("INSERT INTO procurement_materials(id,code,name,unit,updated_at) VALUES (?,?,?,'kg',?)",
                               (row["material_id"], row["code"], row["code"], now))
                elif row["action"] == "restore":
                    db.execute("UPDATE procurement_materials SET archived_at=NULL,archived_by=NULL,updated_at=? WHERE id=?", (now, row["material_id"]))
                if row["action"] != "keep":
                    if db.execute("SELECT 1 FROM procurement_inventory WHERE material_id=?", (row["material_id"],)).fetchone():
                        raise ValueError(f"{row['code']} 已有库存记录，请核对后单独处理")
                    stock = row["inventory_price"]
                    db.execute("INSERT INTO procurement_inventory VALUES (?,?,?,?,?,?,?,?,?)",
                        (row["material_id"], None, None if stock == "0" else stock, stock or "", expected_sha256,
                         PRICE_SHEET, row["source_row"], actor_id, now))
                    collaboration.admin_event(db, actor_id, "material." + ("restored" if row["action"] == "restore" else "created"),
                                              row["material_id"], {"code": row["code"], "source_sha256": expected_sha256})
                if db.execute("INSERT OR IGNORE INTO procurement_department_materials VALUES (?,?)", (plan["department_id"], row["material_id"])).rowcount:
                    added_links.append(row["material_id"])
            collaboration.admin_event(db, actor_id, "department.changed", plan["department_id"], {"added": added_links, "removed": []})

            store = ProcurementStore(path)
            reason = "研发五部原料补齐，保留已有原料价格，录入新增原料初始价格"
            for row in selected:
                if row["latest_price"] is not None:
                    store._adjust_price(db, row["material_id"], Decimal(row["latest_price"]), effective_date, reason, actor_id, None, record_event=False)
            update = store._editable_update(db)
            batch = None
            if update:
                update_id = str(update[0])
                db.execute("UPDATE procurement_updates SET source_name=? WHERE id=?", (source.name, update_id))
                db.execute("UPDATE procurement_imports SET source_name=? WHERE update_id=?", (source.name, update_id))
                event_id = store._event(db, update_id, "rd5_prices_imported", actor_id, reason)
                collaboration.record_changes(db, event_id, update_id, actor_id, effective_date.isoformat(),
                    [(r["material_id"], None, r["latest_price"]) for r in selected if r["latest_price"] is not None])
                # Use the existing validation, snapshot freezing and activation implementation in this transaction.
                batch = store._activate_update(db, update_id, actor_id, now)
                for row in selected:
                    if row["latest_price"] is not None:
                        db.execute("""UPDATE procurement_snapshot_sources SET sheet=?,cell=?,sha256=?
                                      WHERE batch_id=? AND material_id=?""",
                                   (PRICE_SHEET, f"C{row['source_row']}", expected_sha256, batch["id"], row["material_id"]))
            prices = {r[0]: {"material_id": r[1], "latest_price": r[2], "inventory_price": r[3]} for r in db.execute(
                """SELECT m.code,m.id,b.latest_price,i.price FROM procurement_materials m
                   LEFT JOIN procurement_price_batch_items b ON b.material_id=m.id AND b.batch_id=?
                   LEFT JOIN procurement_inventory i ON i.material_id=m.id WHERE m.archived_at IS NULL""", (store._latest_batch_id(db),))}
            package.update(source_filename=source.name, effective_date=effective_date.isoformat(), imported_at=now,
                           price_batch_id=store._latest_batch_id(db), material_mapping=plan["rows"], price_inputs=prices)
            for recipe in package["recipes"]:
                for line in recipe["lines"]:
                    if line["kind"] == "material":
                        line["material_id"] = prices.get(line["code"], {}).get("material_id")
                        if line["material_id"] is None:
                            raise ValueError(f"配方原料未纳入在用目录：{line['code']}")
            package["current_calculation"] = calculate(package, prices)
            result = {"sha256": expected_sha256, "counts": plan["counts"], "batch": batch,
                      "effective_date": effective_date.isoformat(), "imported_at": now,
                      "blocked_recipes": [r["name"] for r in package["recipes"] if r["kind"] == "recipe" and package["current_calculation"][r["id"]]["cost"] is None]}
            db.execute("INSERT INTO procurement_rd5_imports VALUES (?,?,?,?,?)",
                       (expected_sha256, actor_id, now, json.dumps(result, ensure_ascii=False), json.dumps(package, ensure_ascii=False)))
            collaboration.admin_event(db, actor_id, "rd5.imported", expected_sha256, result)
            return result
    except Exception:
        if created_archive:
            stored.unlink(missing_ok=True)
        raise


def revise_preparation(path: Path, digest: str, *, actor_id: str | None = None,
                       expected_state_sha256: str | None = None) -> dict:
    """Apply the confirmed 2026-09-12 formula scope, without reimporting procurement data."""
    from api.procurement import ProcurementStore

    with sqlite3.connect(path.resolve().as_uri() + "?mode=" + ("rw" if actor_id else "ro"), uri=True) as db:
        if actor_id:
            db.execute("BEGIN IMMEDIATE")
            admin = db.execute("SELECT access_level,is_active FROM identity_users WHERE id=?", (actor_id,)).fetchone()
            if admin != (5, 1):
                raise PermissionError("配方准备修订仅限有效系统管理员")
            collaboration.require_current(path, actor_id, "can_activate")
        receipt = _receipt(db, digest)
        if not receipt:
            raise ValueError("尚未完成该来源的导入")
        source = db.execute("SELECT stored_path FROM procurement_source_imports WHERE sha256=?", (digest,)).fetchone()
        if not source or hashlib.sha256(Path(source[0]).read_bytes()).hexdigest() != digest:
            raise ValueError("来源归档校验失败")
        state = hashlib.sha256((_state_digest(db) + receipt[1]).encode()).hexdigest()
        if actor_id and state != expected_state_sha256:
            raise ValueError("配方、目录或价格状态已变化，请重新预检")
        if db.execute("SELECT 1 FROM procurement_updates WHERE status NOT IN ('published','cancelled')").fetchone():
            raise ValueError("存在未完成的采购价格批次，请先处理")
        package = json.loads(receipt[1])
        variants = ("CF026+CF020C", "CF026+CF020D", "CF026K+CF020C")
        historical = ["composite:CF401B:" + name for name in variants] + [
            "recipe:K172-C（" + name.replace("CF", "") + "）" for name in variants]
        ids = {r["id"] for r in package["recipes"]}
        if not {*historical, DEFAULT_COMPOSITE} <= ids:
            raise ValueError("未找到本次确认的 CF401B 方案及三组 K172-C 旧试算")
        policy = {"confirmed_on": "2026-09-12", "historical_recipe_ids": historical,
                  "material_replacements": {"CF020C": "CF020D"}}
        batch_id = ProcurementStore(path)._latest_batch_id(db)
        prices = {r[0]: {"material_id": r[1], "latest_price": r[2], "inventory_price": r[3]} for r in db.execute(
            """SELECT m.code,m.id,b.latest_price,i.price FROM procurement_materials m
               LEFT JOIN procurement_price_batch_items b ON b.material_id=m.id AND b.batch_id=?
               LEFT JOIN procurement_inventory i ON i.material_id=m.id WHERE m.archived_at IS NULL""", (batch_id,))}
        if "CF020D" not in prices:
            raise ValueError("替代原料 CF020D 不在在用台账中")
        package.update(current_policy=policy, default_composite=DEFAULT_COMPOSITE, price_inputs=prices, price_batch_id=batch_id)
        package["current_calculation"] = calculate(package, prices)
        active = [r for r in package["recipes"] if r["id"] not in historical]
        counts = {"recipes": sum(r["kind"] == "recipe" for r in active),
                  "recipe_lines": sum(len(r["lines"]) for r in active if r["kind"] == "recipe"),
                  "composites": sum(r["kind"] == "composite" for r in active),
                  "historical_recipes": 3, "historical_composites": 3}
        if counts["composites"] != 1:
            raise ValueError("当前 CF401B 必须仅保留一种复配方案")
        unchanged = package == json.loads(receipt[1])
        result = {"sha256": digest, "state_sha256": state, "already_current": unchanged,
                  "counts": counts, "policy": policy,
                  "blocked_recipes": [r["name"] for r in active if package["current_calculation"][r["id"]]["cost"] is None]}
        if actor_id and not unchanged:
            package["revised_at"] = datetime.now(UTC).isoformat()
            package["revised_by"] = actor_id
            db.execute("UPDATE procurement_rd5_imports SET package_json=? WHERE sha256=?",
                       (json.dumps(package, ensure_ascii=False), digest))
            collaboration.admin_event(db, actor_id, "rd5.preparation_revised", digest, result)
        return result


def export_preparation(path: Path, digest: str, output: Path) -> dict:
    with sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True) as db:
        receipt = _receipt(db, digest)
        batch = db.execute("SELECT version FROM procurement_price_batches WHERE id=?",
                           (json.loads(receipt[1])["price_batch_id"],)).fetchone() if receipt else None
    if not receipt:
        raise ValueError("尚未完成该来源的导入")
    result, package = map(json.loads, receipt)
    active = [r for r in package["recipes"] if r["id"] in package["current_calculation"]]
    historical = [r for r in package["recipes"] if r["id"] not in package["current_calculation"]]
    current_counts = {"recipes": sum(r["kind"] == "recipe" for r in active),
                      "recipe_lines": sum(len(r["lines"]) for r in active if r["kind"] == "recipe"),
                      "composites": sum(r["kind"] == "composite" for r in active)}
    output.mkdir(parents=True, exist_ok=True)
    json_path = output / "rd5-preparation.json"
    review_path = output / "研发五部数据核对.md"
    json_path.write_text(json.dumps(package, ensure_ascii=False, indent=2), encoding="utf-8")

    def cell(value):
        return "—" if value is None else str(value).replace("|", "\\|").replace("\n", " ")

    def display_number(value):
        return None if value is None else format(Decimal(value), ".6f").rstrip("0").rstrip(".")

    review = ["# 研发五部原料与配方核对", "", f"来源：{package['source_filename']}；价格生效日期：{package['effective_date']}。",
        f"文件 SHA-256：`{digest}`。核算采用正式价格版本：v{batch[0] if batch else '—'}。",
        f"导入时在用原料 {result['counts']['active_after']} 项；研发五部分流 {result['counts']['department_after']} 项；原表配方 {result['counts']['recipes']} 组、投料 {result['counts']['recipe_lines']} 行，复配方案 {result['counts']['composites']} 种。",
        f"当前有效配方 {current_counts['recipes']} 组、投料 {current_counts['recipe_lines']} 行，复配方案 {current_counts['composites']} 种。",
        "现有原料沿用台账价格；新增原料使用录入价格。普通原料最新价优先，其次库存价；复配和产品引用逐层计算。",
        f"核算记录时间：{package.get('revised_at', package['imported_at'])}。导出不自动刷新价格；后续重新计算时应重新读取正式价格和库存价格。清单小数最多显示六位，数据包保留计算精度。", "",
        "## 原料补齐清单", "", "| 原料 | 操作 | 表内最新价 | 表内库存价 | 当前核算取价 | 来源行 |", "|---|---|---:|---:|---:|---:|"]
    for row in package["material_mapping"]:
        if row["action"] not in {"restore", "create"}:
            continue
        p = package["price_inputs"][row["code"]]
        taken = p["latest_price"] if p["latest_price"] is not None else p["inventory_price"]
        if row["code"] == "CF401B":
            taken = package["current_calculation"][package["default_composite"]]["cost"]
        review.append("| " + " | ".join(cell(x) for x in (row["code"], "恢复" if row["action"] == "restore" else "新建", row["latest_price"], row["inventory_price"], display_number(taken), row["source_row"])) + " |")
    review += ["", "## 已有原料映射", "", "以下原料沿用原 ID、台账价格、库存数量和来源，研发表数值仅保留作核对。CF830 本次补上研发五部分流关联。", "",
               "| 原料 | 原表核算价 | 台账最新价 | 台账库存价 | 来源行 |", "|---|---:|---:|---:|---:|"]
    for row in package["material_mapping"]:
        if row["action"] == "keep":
            p = package["price_inputs"][row["code"]]
            review.append("| " + " | ".join(cell(x) for x in (row["code"], row["source_calculation_price"], p["latest_price"], p["inventory_price"], row["source_row"])) + " |")
    review += ["", "## 配方核算结果", "", "成本单位：元/kg。原表复算列仅用于追溯原文件；含 CF020C 的原表结果使用了缺价当零，不作为有效成本。", "",
               "| 配方 | 负责人 | 收率 | 原表复算 | 当前核算 | 差额 | 缺价原料 | 来源 |", "|---|---|---:|---:|---:|---:|---|---|"]
    for recipe in active:
        current = package["current_calculation"][recipe["id"]]
        original = package["source_replay"][recipe["id"]]
        delta = Decimal(current["cost"]) - Decimal(original["cost"]) if current["cost"] is not None and original["cost"] is not None else None
        review.append("| " + " | ".join(cell(x) for x in (recipe["name"], recipe["owner"], display_number(Decimal(recipe["yield"]) * 100) + "%", display_number(original["cost"]), display_number(current["cost"]), display_number(delta), "、".join(current["missing_materials"]) or "—", f"{recipe['sheet']} 第{recipe['source_row']}行")) + " |")
    if historical:
        review += ["", "## 历史试算（不列入当前有效配方）", "", "以下仅保留原表试算，不提供现行成本。CF020C 已停购，现行用料由 CF020D 替代；原始投料和公式保持原样。", "",
                   "| 历史试算 | 原表复算（元/kg） | 来源 |", "|---|---:|---|"]
        for recipe in historical:
            review.append("| " + " | ".join(cell(x) for x in (recipe["name"], display_number(package["source_replay"][recipe["id"]]["cost"]), f"{recipe['sheet']} 第{recipe['source_row']}行")) + " |")
    review += ["", "## 产品及复配引用关系", "", "| 上层配方 | 引用类型 | 投料产物或方案 | 来源行 |", "|---|---|---|---:|"]
    for recipe in active:
        for line in package["current_calculation"][recipe["id"]]["lines"]:
            if line["kind"] in {"recipe", "composite"}:
                target = line["ref"].split(":", 1)[1]
                review.append(f"| {cell(recipe['name'])} | {'产品' if line['kind'] == 'recipe' else '复配方案'} | {cell(target)} | {line['source_row']} |")
    review += ["", "## 核对事项", "", "- 新增原料库存数量未知，全部留空；原表实际投料不作为库存数量。",
               "- 分流页面的待定价按最新采购价统计；有库存价的项目仍可按本次规则参与配方核算。",
               "- CF401B采用CF026K 3000 kg＋CF020D 300 kg，收率99.5%；不将复配成本回写采购报价或库存价格。",
               *(["- 2026-09-12 确认仅保留上述复配方案，另外三种方案及对应三组 K172-C 转为历史试算。CF020C 停购、现行用料改用 CF020D；采购台账及历史来源保留。"] if package.get("current_policy") else
                 ["- CF020C缺价，两种相关K172-C配方及两种复配方案待补价。"]),
               *["- " + note for note in package["notes"]],
               "- 未纳入项目：" + "、".join(r["code"] for r in package["material_mapping"] if r["action"] == "omit") + "。"]
    review_path.write_text("\n".join(review) + "\n", encoding="utf-8")
    return {"package": str(json_path.resolve()), "review": str(review_path.resolve()), "counts": result["counts"], "current_counts": current_counts}
