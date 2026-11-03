"""Bounded, local XLSX extraction and atomic initial historical migration."""
from __future__ import annotations

import csv
import hashlib
import io
import json
import re
import zipfile
from collections import Counter
from datetime import UTC, date, datetime
from decimal import Decimal, DecimalException
from xml.etree.ElementTree import ParseError
from pathlib import Path
from uuid import uuid4

from openpyxl import Workbook, load_workbook
from openpyxl.comments import Comment
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

from api.postgres import transaction

TOTAL = "原料行情总表"
DEPARTMENTS = ["研发一部", "研发二部", "研发三部", "研发四部", "研发五部", "宏昊生物"]
MAX_FILE = 8 * 1024 * 1024


def import_template(price_date: date) -> bytes:
    book = Workbook()
    sheet = book.active
    sheet.title = TOTAL
    sheet.append(["原料编号", "采购员", "库存数量", "库存价格", price_date])
    sheet["E1"].number_format = 'yyyy-mm-dd" 行情价格"'
    descriptions = ["填写系统中已有的原料编号，每个编号一行。", "填写负责该原料的采购员，导入后显示为修改人；空白使用导入账号。", "单位 kg，填写非负数字；导入库存价格时必填。",
                    "单位元/kg，含税；空白或0视为缺价，不再重复加税。", "此列填写行情价格（元/kg，含税）；将本表头日期改为实际报价日期。行情空白沿用原价。"]
    for cell, description in zip(sheet[1], descriptions):
        cell.font = Font(name="微软雅黑", size=11, bold=True, color="FFFFFF")
        cell.fill = PatternFill("solid", fgColor="344054")
        cell.alignment = Alignment(vertical="center")
        cell.comment = Comment(description, "宏昊工作台")
        sheet.column_dimensions[cell.column_letter].width = 25
    sheet.row_dimensions[1].height = 30
    sheet.freeze_panes = "A2"
    notes = book.create_sheet("填写说明")
    for line in ["原料价格导入模板", "在“原料行情总表”第2行起填写数据，每个原料一行。", *descriptions,
                 "不要更改前四列表头；行情价格列表头保留为Excel日期。", "请将公式转换为数值后导入。模板不含示例业务数据。"]:
        notes.append([line])
    notes.column_dimensions["A"].width = 95
    for row in notes:
        row[0].font = Font(name="微软雅黑", size=11)
        row[0].alignment = Alignment(wrap_text=True, vertical="center")
        notes.row_dimensions[row[0].row].height = 28
    stream = io.BytesIO()
    book.save(stream)
    book.close()
    return stream.getvalue()


def read_workbook(content: bytes) -> dict:
    if len(content) > MAX_FILE:
        raise ValueError("Excel 文件不能超过8MB")
    try:
        with zipfile.ZipFile(io.BytesIO(content)) as archive:
            infos = archive.infolist()
            if len(infos) > 2000 or sum(i.file_size for i in infos) > 64 * 1024 * 1024:
                raise ValueError("Excel 解压后内容过大")
            if any("vbaproject" in i.filename.lower() or "externallinks/" in i.filename.lower() for i in infos):
                raise ValueError("不接受宏或外部链接")
        workbook = load_workbook(io.BytesIO(content), read_only=True, data_only=False, keep_links=False)
        result = {}
        try:
            if len(workbook.worksheets) > 30:
                raise ValueError("工作表数量过多")
            for sheet in workbook:
                if sheet.max_row > 10000 or sheet.max_column > 100:
                    raise ValueError("工作表范围过大")
                rows = []
                for row in sheet.iter_rows():
                    if any(cell.data_type == "f" for cell in row):
                        raise ValueError("请将公式转换为值后导入")
                    rows.append([cell.value for cell in row])
                if rows:
                    result[sheet.title] = rows
        finally:
            workbook.close()
        return result
    except (zipfile.BadZipFile, KeyError, OSError, ParseError, TypeError, IndexError) as error:
        raise ValueError("无法读取有效的xlsx文件") from error


def text(value) -> str:
    return "" if value is None else str(value).strip()


def day(value) -> str | None:
    if isinstance(value, (date, datetime)):
        return value.isoformat()[:10]
    match = re.fullmatch(r"(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})", text(value))
    if match:
        try:
            return date(*map(int, match.groups())).isoformat()
        except ValueError:
            return None
    return None


def price_value(value) -> tuple[str | None, str]:
    raw = text(value)
    if not raw:
        return None, "missing"
    try:
        number = Decimal(raw)
        if number.is_finite() and number >= 0 and len(raw) <= 64 and -8 <= number.as_tuple().exponent <= 18 and number.adjusted() < 18:
            rendered = format(number, "f")
            return (rendered.rstrip("0").rstrip(".") if "." in rendered else rendered), "number"
    except DecimalException:
        pass
    return None, "range" if re.fullmatch(r"\d+(?:\.\d+)?\s*[-~～]\s*\d+(?:\.\d+)?", raw) else "invalid"


def inspect_workbook(content: bytes) -> dict:
    sheets = read_workbook(content)
    return {"sheets": [{"name": name, "dates": [d for v in rows[0] if (d := day(v))], "rows": len(rows)-1} for name, rows in sheets.items()], "default_sheet": TOTAL if TOTAL in sheets else next(iter(sheets), "")}


def selected_prices(content: bytes, sheet: str, price_date: str, known: dict) -> dict:
    sheets = read_workbook(content)
    if sheet not in sheets:
        raise ValueError("工作表不存在")
    rows = sheets[sheet]
    dates = [day(v) for v in rows[0]]
    if price_date not in dates:
        raise ValueError("所选日期不存在，请核对表头")
    column = dates.index(price_date)
    if dates.count(price_date) != 1:
        raise ValueError("价格日期列重复，请核对表头")
    headers = [text(v) for v in rows[0]]
    columns = {}
    for key, aliases in {"code": {"品名", "编号", "原料编号", "原料编码"},
                         "inventory_quantity": {"库存数量", "库存量"},
                         "inventory_price": {"库存价格", "库存价"}, "purchaser": {"采购员", "采购人"}}.items():
        matches = [i for i, value in enumerate(headers) if value in aliases]
        if len(matches) > 1 or (key == "code" and not matches):
            raise ValueError("原料编号和库存字段需要唯一表头")
        columns[key] = matches[0] if matches else None
    stock = columns["inventory_price"] is not None
    if stock and columns["inventory_quantity"] is None:
        raise ValueError("导入库存价格需要库存数量列")
    code_column = columns["code"]
    codes = Counter(text(r[code_column]) for r in rows[1:] if text(r[code_column]))
    result = []
    csv_rows = []
    for n, row in enumerate(rows[1:], 2):
        code = text(row[code_column])
        if not code:
            continue
        raw = text(row[column])
        value, kind = price_value(raw)
        state = "duplicate" if codes[code]>1 else "unknown" if code not in known else kind
        purchaser = text(row[columns["purchaser"]]) if columns["purchaser"] is not None else ""
        inventory = {}
        if stock:
            quantity, quantity_kind = price_value(row[columns["inventory_quantity"]])
            price, price_kind = price_value(row[columns["inventory_price"]])
            inventory = {"inventory_quantity": quantity, "inventory_price": price,
                         "raw_inventory_quantity": text(row[columns["inventory_quantity"]]), "raw_inventory_price": text(row[columns["inventory_price"]])}
            if state not in {"duplicate", "unknown"}:
                if quantity_kind != "number" or price_kind not in {"number", "missing"} or known[code]["unit"] != "kg":
                    state = "invalid"
                elif kind == "missing":
                    state = "stock_only"
        if len(purchaser)>100 or any(ord(c)<32 for c in purchaser):
            state = "invalid"
        result.append({"purchaser": purchaser, "row": n, "code": code, "name": known.get(code, {}).get("name", code), "unit": known.get(code, {}).get("unit", "kg"), "raw_price": raw, "price": value, "state": state, **inventory})
        if state in {"number", "stock_only"}:
            item = known[code]
            csv_rows.append([code, item["name"], item["unit"], value, purchaser, *([inventory["inventory_quantity"], inventory["inventory_price"]] if stock else [])])
    stream = io.StringIO()
    writer = csv.writer(stream)
    writer.writerow(["编号", "名称", "单位", "行情价格", "采购员", *(["库存数量", "库存价格"] if stock else [])])
    writer.writerows(csv_rows)
    return {"rows": result, "content": stream.getvalue(), "valid": len(csv_rows),
            "blocked": sum(r["state"] in {"duplicate", "unknown", "range", "invalid"} for r in result),
            "unreported": sum(r["state"] == "missing" for r in result)}


def history_preview(content: bytes) -> dict:
    sheets = read_workbook(content)
    if TOTAL not in sheets or not all(name in sheets for name in DEPARTMENTS):
        raise ValueError("首次迁入需要原料行情总表及六个部门子表")
    rows = sheets[TOTAL]
    dates = [(i, d) for i,v in enumerate(rows[0]) if (d := day(v))]
    total_codes = [text(r[1]) for r in rows[1:] if len(r)>1 and text(r[1])]
    if len(set(total_codes)) != len(total_codes) or len(set(d for _,d in dates)) != len(dates):
        raise ValueError("总表原料编号或日期重复")
    codes = {text(r[1]) for name in [TOTAL, *DEPARTMENTS] for r in sheets[name][1:] if len(r)>1 and text(r[1])}
    anomalies = [{"sheet": TOTAL, "cell": f"{get_column_letter(i+1)}{n}", "code": text(row[1]), "date": d, "value": text(row[i]), "kind": price_value(row[i])[1]}
                 for n,row in enumerate(rows[1:],2) if text(row[1]) for i,d in dates if price_value(row[i])[1] in {"range","invalid"}]
    return {"material_count": len(codes), "history_material_count": len(total_codes), "dates": sorted(d for _,d in dates),
            "departments": [{"name": name, "count": len({text(r[1]) for r in sheets[name][1:] if text(r[1])})} for name in DEPARTMENTS],
            "anomalies": anomalies, "sha256": hashlib.sha256(content).hexdigest()}


def import_history(url: str, source: Path, actor_id: str, *, data_dir: Path, expected_sha256: str) -> dict:
    content = source.read_bytes()
    preview = history_preview(content)
    if preview["sha256"] != expected_sha256:
        raise ValueError("文件已变化，请重新预检")
    sheets = read_workbook(content)
    digest = preview["sha256"]
    now = datetime.now(UTC).isoformat()
    stored = data_dir / "controlled-work" / "procurement-sources" / f"{digest}.xlsx"
    created_archive = False
    try:
        with transaction(url, write=True) as db:
            admin = db.execute("SELECT access_level,is_active FROM identity_users WHERE id=%s", (actor_id,)).fetchone()
            if not admin or admin != (5,1):
                raise PermissionError("首次迁入仅限有效管理员")
            if db.execute("SELECT 1 FROM procurement_source_imports WHERE sha256=%s", (digest,)).fetchone():
                raise ValueError("这份文件已迁入，不可重复执行")
            if db.execute("SELECT 1 FROM procurement_materials LIMIT 1").fetchone():
                raise ValueError("首次迁入必须使用空采购库，不覆盖现有业务数据")
            stored.parent.mkdir(parents=True, exist_ok=True)
            if stored.exists() and stored.read_bytes() != content:
                raise ValueError("来源归档校验失败")
            if not stored.exists():
                with stored.open("xb") as stream:
                    created_archive = True
                    stream.write(content)
            db.execute("INSERT INTO procurement_source_imports (sha256, filename, stored_path, imported_by, imported_at) VALUES (%s,%s,%s,%s,%s)", (digest, source.name, str(stored), actor_id, now))
            ids = {}
            for name in [TOTAL, *DEPARTMENTS]:
                for n,row in enumerate(sheets[name][1:],2):
                    code = text(row[1]) if len(row)>1 else ""
                    if not code:
                        continue
                    if code not in ids:
                        ids[code] = str(uuid4())
                        db.execute("INSERT INTO procurement_materials(id,code,name,unit,updated_at) VALUES (%s,%s,%s,'kg',%s)", (ids[code], code, code, now))
                    db.execute("INSERT INTO procurement_material_sources (material_id, sheet, source_row, raw_json, sha256) VALUES (%s,%s,%s,%s,%s)", (ids[code],name,n,json.dumps(row,ensure_ascii=False,default=str),digest))
            for position,name in enumerate(DEPARTMENTS):
                group = str(uuid4())
                db.execute("INSERT INTO procurement_departments (id, name, position) VALUES (%s,%s,%s)", (group,name,position))
                db.cursor().executemany("INSERT INTO procurement_department_materials (department_id, material_id) VALUES (%s,%s)", [(group,ids[code]) for code in {text(r[1]) for r in sheets[name][1:] if text(r[1])}])
            rows = sheets[TOTAL]
            columns = sorted([(i, day(v)) for i,v in enumerate(rows[0]) if day(v)], key=lambda item:item[1])
            previous = {}
            prior_batch = None
            for version,(column,price_date) in enumerate(columns,1):
                batch = str(uuid4())
                reported = 0
                for n,row in enumerate(rows[1:],2):
                    code = text(row[1])
                    if not code:
                        continue
                    raw = text(row[column])
                    if raw:
                        reported += 1
                        value,kind = price_value(raw)
                        previous[code] = (value,kind,price_date,raw,f"{get_column_letter(column+1)}{n}")
                    value,kind,origin_day,raw,cell = previous.get(code,(None,"missing",None,None,None))
                    db.execute("INSERT INTO procurement_price_batch_items (batch_id, material_id, code, name, unit, latest_price, inventory_price, in_transit_price, recommended_price) VALUES (%s,%s,%s,%s,'kg',%s,NULL,NULL,%s)", (batch,ids[code],code,code,value,value))
                    db.execute("INSERT INTO procurement_snapshot_sources (batch_id, material_id, price_date, raw_price, price_kind, sheet, cell, sha256) VALUES (%s,%s,%s,%s,%s,%s,%s,%s)", (batch,ids[code],origin_day,raw,kind,TOTAL,cell,digest))
                db.execute("INSERT INTO procurement_price_batches(id,version,published_by,published_at,item_count,price_date,source_name,base_batch_id) VALUES (%s,%s,%s, %s,%s,%s,%s,%s)",
                           (batch,version,actor_id,now,preview["history_material_count"],price_date,source.name,prior_batch))
                db.execute("INSERT INTO procurement_batch_provenance (batch_id, origin, sha256, imported_at, imported_by, reported_count) VALUES (%s,'historical_import',%s,%s,%s,%s)", (batch,digest,now,actor_id,reported))
                prior_batch = batch
            for code,(value,kind,origin_day,raw,cell) in previous.items():
                db.execute("UPDATE procurement_materials SET latest_price=%s WHERE id=%s", (value,ids[code]))
            # Only source-attributed values are stored; no invented historical user actions.
            from api.procurement_collaboration import admin_event
            admin_event(db,actor_id,"history.imported",digest,{
                "sha256": digest,
                "material_count": preview["material_count"],
                "history_material_count": preview["history_material_count"],
                "version_count": len(preview["dates"]),
                "anomaly_count": len(preview["anomalies"]),
            })
    except Exception:
        if created_archive and stored.is_file():
            stored.unlink()
        raise
    return preview
