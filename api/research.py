"""Research formulas, frozen cost events and optimistic shared drafts.

Purchase writers enqueue frozen inputs in their own transaction. Calculation and
history insertion happen later, so a calculation failure cannot undo a purchase.
"""
from __future__ import annotations

import hashlib
import json
import psycopg
from collections import OrderedDict
from copy import deepcopy
from datetime import UTC, datetime
from decimal import Decimal, ROUND_HALF_UP, localcontext
from uuid import uuid4
from threading import Lock, Semaphore

from fastapi import APIRouter, HTTPException, Request, Query, Response
from pydantic import BaseModel, ConfigDict, Field
from starlette.responses import JSONResponse

from api import procurement_collaboration as activation_grants
from api.identity import IdentityStore, SESSION_COOKIE_NAME
from api.research_formulas import calculate, number, decimal_text, input_number, ERP_CONCENTRATIONS
from api.postgres import transaction
from api.research_access import ResearchAccess

ADJUSTMENT_REASONS = ("配方优化", "实际投料修正", "收率修正", "成本核对修正", "临时成本测算", "其他")

# Include deletions and every committed update without loading large JSON/TOAST values.
OVERVIEW_TABLES = (
    "research_formulas", "research_drafts", "research_cost_records", "research_events",
    "research_backfill_records", "research_backfill_runs", "research_meta",
    "procurement_price_batches", "procurement_price_batch_items", "procurement_materials",
    "procurement_departments", "procurement_department_materials", "identity_users",
    "identity_user_scopes", "organization_memberships", "organization_departments",
    "research_activation_grants",
)
OVERVIEW_INSTANCE = str(uuid4())  # Reload open tabs after a service/program restart too.
MATERIAL_TABLES = OVERVIEW_TABLES + (
    "procurement_inventory", "procurement_material_sources", "procurement_snapshot_sources",
    "procurement_saved_changes", "procurement_updates", "procurement_update_events",
    "procurement_price_history", "procurement_imports",
)


def packed(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest(value):
    return hashlib.sha256(packed(value).encode()).hexdigest()


def overview_summary(payload):
    # Overview consumers only need series values; frozen formula evidence is fetched on opening history.
    fields = {'id', 'latest_cost', 'inventory_cost', 'effective_date', 'recorded_at', 'record_type'}
    return {**payload, 'versions': [
        {**version, 'products': [{k:v for k,v in row.items() if k in fields} for row in version['products']]}
        for version in payload['versions']
    ]}


def now():
    return datetime.now(UTC).isoformat()


def capture(db):
    package = json.loads(db.execute("SELECT payload FROM research_meta WHERE id=1").fetchone()[0])
    inventory_overrides = package.get("inventory_price_overrides", {})
    package = {k:package[k] for k in ("materials", "default_composite", "source_sha256", "source_filename", "erp_inventory_fallback_codes") if k in package}
    package["recipes"] = [json.loads(r[0]) for r in db.execute("SELECT formula FROM research_formulas WHERE lifecycle='active' ORDER BY position")]
    package["current_policy"] = {"material_replacements": {"CF020C": "CF020D"}}
    if "erp_inventory_fallback_codes" in package:
        package["current_policy"]["erp_inventory_fallback_codes"] = package["erp_inventory_fallback_codes"]
    batch = db.execute("SELECT id,version,price_date FROM procurement_price_batches ORDER BY version DESC LIMIT 1").fetchone()
    prices = {r[0]: {"latest_price": r[1], "inventory_price": r[2]} for r in db.execute("""
        SELECT m.code,b.latest_price,i.price FROM procurement_materials m
        LEFT JOIN procurement_price_batch_items b ON b.material_id=m.id AND b.batch_id=%s
        LEFT JOIN procurement_inventory i ON i.material_id=m.id WHERE m.archived_at IS NULL
        """, (batch[0] if batch else None,))}
    inventory_sources = {code:(sha,raw) for code,sha,raw in db.execute("SELECT m.code,i.source_sha256,i.raw_price FROM procurement_inventory i JOIN procurement_materials m ON m.id=i.material_id")} if inventory_overrides else {}
    for code, override in inventory_overrides.items():
        # A new inventory import expires this batch's independently confirmed calculation price.
        if code in prices and inventory_sources.get(code,(None,None))[0] == override["source_sha256"]:
            prices[code].update(inventory_price=override["price"], inventory_basis=override["basis"],
                                ERP_inventory_price=inventory_sources[code][1] or prices[code]["inventory_price"])
    return {"package": package, "prices": prices,
            "purchase_period": None if batch is None else {"id": batch[0], "version": batch[1], "price_date": batch[2]}}


def enqueue(db, reason):
    # Called by every formal price activation and stock import, including CLI paths.
    if not db.execute("SELECT 1 FROM research_meta").fetchone():
        return
    db.execute("INSERT INTO research_events(id,recorded_at,reason,inputs,status,attempts,error) VALUES (%s,%s,%s,%s,'pending',0,NULL)",
               (str(uuid4()), now(), reason, packed(capture(db))))


def evaluate(inputs):
    return {policy: calculate(inputs["package"], inputs["prices"], price_policy=policy)
            for policy in ("latest", "inventory")}


def signatures(inputs, results, *, include_basis=True):
    recipes = {r["id"]: r for r in inputs["package"]["recipes"]}
    cache = {}
    def visit(ref):
        if ref in cache:
            return cache[ref]
        recipe = recipes[ref]
        lines = []
        for left, right in zip(results["latest"][ref]["lines"], results["inventory"][ref]["lines"]):
            item = {k: left[k] for k in ("kind", "ref", "quantity")}
            if left.get('price_ref'):
                item['price_ref'] = left['price_ref']
            if left.get('price_refs'):
                item['price_refs'] = left['price_refs']
                item['reference_inputs'] = [[[v['code'], v['unit_cost']] for v in line.get('price_reference_values', [])] for line in (left, right)]
            if Decimal(left["quantity"]) != 0:
                item["inputs"] = visit(left["ref"]) if left["kind"] != "material" else [
                    [line["unit_cost"], {"historical_latest":"latest", "current_latest_fallback":"latest", "current_inventory_fallback":"inventory"}.get(line["basis"],line["basis"])] if include_basis else line['unit_cost'] for line in (left, right)]
                if any(line["basis"] == "erp_inventory_fallback" for line in (left, right)):
                    item["fallback_inputs"] = [line["unit_cost"] for line in (left, right)]
            lines.append(item)
        cache[ref] = digest({"yield": recipe["yield"], "lines": lines,
            **({"price_review_pending": sorted(set(results["latest"][ref].get("price_review_pending", [])) | set(results["inventory"][ref].get("price_review_pending", [])))} if any(results[p][ref].get("price_review_pending") for p in ("latest", "inventory")) else {}),
            **({"adjustment": {k:recipe.get(k) for k in ("manual_costs", "adjustment_reason", "adjustment_note", "edited_by", "activated_by")}} if "adjustment_reason" in recipe else {}),
            **({"owner": recipe.get("owner"), "ratios": [line.get("ratio") for line in recipe["lines"]], "ratio_linked": recipe.get("ratio_linked", True), "ratio_base": recipe.get("ratio_base")} if any("ratio" in line for line in recipe["lines"]) else {}),
            **({"department": recipe.get("department"), "source_kind": recipe["source_kind"], "yield_source": recipe.get("yield_source")} if recipe.get("source_kind") else {})})
        return cache[ref]
    return visit


def signature(inputs, results, key, *, include_basis=True):
    return signatures(inputs, results, include_basis=include_basis)(key)


def record_signature(payload):
    return signature({'package':{'recipes':payload['graph']}},payload['calculations'],payload['id'],include_basis=False)


def comparison_price(value):
    if value is None:
        return None
    value = Decimal(value)
    with localcontext() as context:
        context.prec = max(context.prec, value.adjusted() + 4)
        return value.quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)


def comparison(current, previous):
    if previous is None:
        return {"percent": None, "reason": "首次正式记录，暂无上期成本"}
    if current is None or previous.get("latest_cost") is None:
        return {"percent": None, "reason": "本期或上期缺少价格，暂无对比"}
    old, current = comparison_price(previous["latest_cost"]), comparison_price(current)
    if old == 0:
        return {"percent": None, "reason": "上期成本为零，无法计算百分比"}
    return {"percent": float((current - old) / old * 100),
            "reason": f"行情优先成本（按两位小数比较）：{old:.2f} → {current:.2f}"}


class ResearchStore:
    def __init__(self, url: str):
        self.url = url
        self._detail_calculation = None
        self._detail_calculation_lock = Lock()

    def initialize(self):
        with transaction(self.url, write=True) as db:
            version = db.execute("SELECT value FROM schema_metadata WHERE key='workbench_research_schema_version'").fetchone()
            if not version or str(version[0]) != "2":
                raise ValueError("研发存储版本不兼容，请先完成数据库迁移")
            if db.execute("SELECT 1 FROM research_meta").fetchone():
                return
            row = db.execute("SELECT package_json FROM procurement_rd5_imports ORDER BY imported_at DESC LIMIT 1").fetchone()
            if not row:
                raise ValueError("缺少研发五部已核对的配方准备数据")
            package = json.loads(row[0])
            historical = set(package.get("current_policy", {}).get("historical_recipe_ids", []))
            if not historical:
                raise ValueError("尚未确认现行复配与历史试算范围")
            db.execute("INSERT INTO research_meta(id,payload) VALUES(1,%s)", (packed(package),))
            for pos, recipe in enumerate(package["recipes"]):
                if recipe["id"] in historical:
                    continue
                recipe = dict(recipe, revision=1)
                for line in recipe["lines"]:
                    if line["kind"] == "material" and line["ref"] == "CF401B":
                        line.update(kind="composite", ref=package["default_composite"])
                db.execute("INSERT INTO research_formulas(id,position,revision,formula,draft_sequence) VALUES(%s,%s,1,%s,0)", (recipe["id"], pos, packed(recipe)))
                db.execute("INSERT INTO research_formula_versions(id,revision,formula,actor,recorded_at) VALUES(%s,1,%s,NULL,%s)", (recipe["id"], packed(recipe), now()))
            enqueue(db, "首次产品成本基线")

    def process_events(self):
        processed = 0
        # Commit each frozen event atomically so readers cannot observe mixed cost periods.
        while True:
            event_id = None
            try:
                with transaction(self.url, write=True) as db:
                    event = db.execute("SELECT id,recorded_at,reason,inputs FROM research_events WHERE status!='done' ORDER BY _order LIMIT 1").fetchone()
                    if not event:
                        return processed
                    event_id, recorded_at, reason, raw = event
                    inputs = json.loads(raw)
                    results = evaluate(inputs)
                    graph = inputs["package"]["recipes"]
                    lookup = {r['id']:r for r in graph}
                    positions = {r['id']:i for i,r in enumerate(graph)}
                    signed = signatures(inputs, results)
                    compared = signatures(inputs, results, include_basis=False)
                    previous = dict(db.execute("SELECT DISTINCT ON (product_id) product_id,payload FROM research_cost_records ORDER BY product_id,sequence DESC"))
                    inserts = []
                    insert_sql = "INSERT INTO research_cost_records(event_id,product_id,signature,payload) VALUES(%s,%s,%s,%s)"
                    def dependency_ids(key, found=None):
                        found = set() if found is None else found
                        if key not in found:
                            found.add(key)
                            for line in results["latest"][key]["lines"]:
                                if line["kind"] != "material":
                                    dependency_ids(line["ref"], found)
                        return found
                    for formula in graph:
                        key = formula["id"]
                        sig = signed(key)
                        old = json.loads(previous[key]) if key in previous else None
                        if old and record_signature(old) == compared(key):
                            continue
                        left, right = results["latest"][key], results["inventory"][key]
                        dependencies = dependency_ids(key)
                        payload = {**formula, "latest_cost": left["cost"], "inventory_cost": right["cost"],
                            "latest": left, "inventory": right, "change": comparison(left["cost"], old),
                            "recorded_at": recorded_at, "reason": reason, "event_id": event_id,
                            "missing_materials": sorted(set(left["missing_materials"] + right["missing_materials"])),
                            "status": "missing" if left["missing_materials"] or right["missing_materials"] else "ready",
                            "formula": formula, "graph": [lookup[k] for k in sorted(dependencies,key=positions.__getitem__)],
                            "calculations": {p:{k:values[k] for k in dependencies} for p,values in results.items()}}
                        inserts.append((event_id,key,sig,packed(payload)))
                        if len(inserts) == 200:
                            db.cursor().executemany(insert_sql,inserts)
                            inserts.clear()
                    if inserts:
                        db.cursor().executemany(insert_sql,inserts)
                    db.execute("UPDATE research_events SET status='done',attempts=attempts+1,error=NULL WHERE id=%s", (event_id,))
                    processed += 1
            except (ValueError, KeyError, ArithmeticError, psycopg.Error) as error:
                if event_id:
                    with transaction(self.url, write=True) as db:
                        db.execute("UPDATE research_events SET status='failed',attempts=attempts+1,error=%s WHERE id=%s", (str(error)[:1000],event_id))
                raise

    def _options(self, db, access=None):
        formulas = [json.loads(r[0]) for r in db.execute("SELECT formula FROM research_formulas WHERE lifecycle='active' ORDER BY position")]
        expanded = any(r.get('source_kind') == 'erp_bom' for r in formulas)
        scope = "" if expanded else "AND EXISTS(SELECT 1 FROM procurement_department_materials dm JOIN procurement_departments d ON d.id=dm.department_id WHERE dm.material_id=m.id AND d.name='研发五部')"
        materials = [{"code": r[0]} for r in db.execute(f"SELECT m.code FROM procurement_materials m WHERE m.archived_at IS NULL AND m.code NOT IN ('CF020C','CF401B') {scope} ORDER BY m.code")]
        department_scope = "d.name LIKE '研发%'" if expanded else "d.name='研发五部'"
        owners = {r[0] for r in db.execute(f"SELECT u.display_name FROM identity_users u JOIN organization_memberships m ON m.user_id=u.id JOIN organization_departments d ON d.id=m.department_id WHERE {department_scope} AND u.is_active=1")}
        access = access or ResearchAccess(db)
        owned = [json.loads(raw) for raw, in db.execute('SELECT formula FROM research_formulas') if access.allows(json.loads(raw))]
        reference_ids = {line['ref'] for formula in owned for line in formula['lines'] if line['kind']!='material'}
        if not access.admin:
            owners = {name for name,dept in db.execute('SELECT u.display_name,m.department_id FROM identity_users u JOIN organization_memberships m ON m.user_id=u.id WHERE u.is_active=1') if dept in access.departments}
        return {"owners": sorted(owners | {r["owner"] for r in owned if r["kind"]=='recipe' and r.get('owner')}), "materials": materials, **{name: [{"id": r["id"], "name": r["name"], **({'restricted_reference':True} if not access.allows(r) else {})} for r in formulas if r["kind"] == kind and (access.allows(r) or r['id'] in reference_ids)]
                for name, kind in (("recipes", "recipe"), ("composites", "composite"))}}

    def _rows(self, db, actor=None, key=None, histories=None):
        from api.research_history import purchase_periods,linked_histories,SUMMARY_PAYLOAD
        periods = purchase_periods(db) if histories is None else None
        access = ResearchAccess(db, actor)
        visible = access.visible_ids(db) if not access.admin else set()
        params = ((key,) if key is not None else ()) + ((list(visible),) if not access.admin else ())
        records = {key: raw for key, raw in db.execute(f"""SELECT DISTINCT ON (product_id) product_id,{SUMMARY_PAYLOAD}
            FROM research_cost_records WHERE product_id IN (SELECT id FROM research_formulas WHERE lifecycle='active')
            {'AND product_id=%s' if key is not None else ''}
            {'AND product_id=ANY(%s)' if not access.admin else ''}
            ORDER BY product_id,sequence DESC""", params)} if histories is None else {
                key: next((row for row in rows if row.get('record_type')=='formal'), None)
                for key,rows in histories.items()}
        rows = []
        pending = db.execute("SELECT status FROM research_events WHERE status!='done' ORDER BY _order LIMIT 1").fetchone()
        formulas = [(json.loads(raw),has_draft) for raw,has_draft in db.execute(f"SELECT f.formula,EXISTS(SELECT 1 FROM research_drafts d WHERE d.id=f.id) FROM research_formulas f WHERE f.lifecycle='active' {'AND f.id=%s' if key is not None else ''} {'AND f.id=ANY(%s)' if not access.admin else ''} ORDER BY f.position", params)]
        formulas = [(formula,has_draft) for formula,has_draft in formulas if formula['kind']=='recipe' and access.allows(formula)]
        histories = histories if histories is not None else linked_histories(db,[formula['id'] for formula,_ in formulas],periods,summary=True)
        for formula,has_draft in formulas:
            record = records.get(formula["id"])
            payload = (json.loads(record) if isinstance(record,str) else dict(record)) if record else dict(formula, latest_cost=None,inventory_cost=None,change={"percent":None,"reason":"首次核算中"},missing_materials=[])
            if record and not isinstance(record,str):
                for derived in ('record_type','effective_date','product_id','comparison_basis','purchase_version'):
                    payload.pop(derived,None)
            payload = {k:v for k,v in payload.items() if k not in {"graph","calculations","formula","source_hashes"}}
            payload = access.project(payload, visible)
            payload["cost_details"] = {p: {k:payload.get(p, {}).get(k) for k in ("cost_source", "auto_cost", "difference")} for p in ("latest", "inventory")}
            for key in ("graph", "calculations", "formula", "latest", "inventory"):
                payload.pop(key, None)
            payload.update(has_draft=bool(has_draft), revision=formula["revision"])
            linked = histories.get(formula['id'],[])
            if linked:
                payload.update(change=linked[0]['change'],comparison_basis=linked[0].get('comparison_basis'),
                               includes_backfill=any(r['record_type']=='backfill' for r in linked))
            if pending:
                payload["status"] = "failed" if pending[0] == "failed" else "updating"
            rows.append(payload)
        return {"products": rows, "pending": bool(pending)}

    def listing(self, actor=None, histories=None):
        with transaction(self.url) as db:
            return self._rows(db, actor, histories=histories)

    def overview(self, actor=None, series=False):
        from api.research_history import linked_histories, version_history
        with transaction(self.url) as db:
            access=ResearchAccess(db,actor)
            visible=access.visible_ids(db) if not access.admin else None
            keys=[r[0] for r in db.execute('SELECT product_id FROM research_cost_records UNION SELECT product_id FROM research_backfill_records') if visible is None or r[0] in visible]
            histories=linked_histories(db,keys,summary=True,series=series)
            history = version_history(db,access=None if access.admin else access,histories=histories,series=True) if series else self.history(actor=actor,histories=histories)
            result={**self.listing(actor,histories),**history,**self.formulas(actor)}
            # Lists need input counts; full inputs remain in permission-checked product details.
            for row in result['products']+result['formulas']:
                if isinstance(row.get('lines'),list):row['lines']=len(row['lines'])
            return result

    def overview_etag(self, actor, tables=OVERVIEW_TABLES):
        with transaction(self.url) as db:
            access = ResearchAccess(db, actor)
            if not access.admin and access.level < 2:
                raise PermissionError("没有此项研发操作权限")
            versions = db.execute("SELECT table_name,version FROM honghao_meta.read_versions WHERE table_name=ANY(%s)", (list(tables),)).fetchall()
            if len(versions) != len(tables):
                raise RuntimeError("读取版本标记不完整，请检查数据库迁移")
            # Equal live scopes have the same representation; identity never substitutes for authorization.
            return 'W/"' + digest([OVERVIEW_INSTANCE, access.admin, access.level, access.departments, sorted(versions)]) + '"'

    def material_prices(self, actor=None):
        from api.procurement import ProcurementStore

        procurement = ProcurementStore(self.url)
        # Reuse procurement's official snapshot after the conditional read detects a change.
        overview = procurement.overview()
        with transaction(self.url) as db:
            package = capture(db)["package"]
            access = ResearchAccess(db,actor)
        formulas = {formula["id"]: formula for formula in package["recipes"]}
        replacements = package["current_policy"]["material_replacements"]
        used, visited = set(), set()

        def visit(key):
            if key in visited or key not in formulas or not access.allows(formulas[key]):
                return
            visited.add(key)
            for line in formulas[key]["lines"]:
                if Decimal(str(line["quantity"])) == 0:
                    continue
                kind, ref = line["kind"], line["ref"]
                if kind == "material":
                    ref = replacements.get(ref, ref)
                    if ref == "CF401B":
                        kind, ref = "composite", package["default_composite"]
                if kind == "material":
                    used.add(ref)
                    if formulas[key].get('source_kind') == 'erp_bom':
                        price_refs = line.get('price_refs') or [line.get('price_ref', ref)]
                        used.update('CF232' if code in ERP_CONCENTRATIONS or code == '回收2' else code for code in price_refs)
                else:
                    visit(ref)

        for formula in package["recipes"]:
            if formula["kind"] == "recipe":
                visit(formula["id"])

        batch = overview["batches"][0] if overview["batches"] else None
        authors = activation_grants.price_authorship(self.url)["batches"].get(batch["id"], {}) if batch else {}
        materials = []
        for item in overview["materials"]:
            author = authors.get(item["id"])
            modifier = {"kind": author["kind"], "name": author["name"], "id": str(author["id"]) if author["id"] else None} if author else None
            person = {"id": modifier["id"] or modifier["name"], "name": modifier["name"]} if modifier and modifier["name"] else None
            materials.append({key: item.get(key) for key in (
                "id", "code", "name", "unit", "inventory_quantity", "inventory_price", "published_price",
                "previous_published_price", "published_price_date", "updated_at", "inventory_source"
            )} | {"price_date": item.get("published_price_date") or "", "price_modifier": modifier,
                 "participants": [person] if person else [], "in_formula_scope": item["code"] in used})
        return {
            "batch": {"version": batch["version"], "price_date": batch["price_date"]} if batch else None,
            "batches": [{"id": row["id"], "comparison": {"added_material_ids": (row.get("comparison") or {}).get("added_material_ids", [])}} for row in overview["batches"]],
            "ledger_comparison": overview["ledger_comparison"],
            "materials": materials,
        }

    def material_price_detail(self, material_id):
        from api.procurement import ProcurementStore

        detail = ProcurementStore(self.url).material_detail(material_id)
        if detail is None:
            return None
        return {"material": detail["material"], "comparison": detail["comparison"],
                "official_history": detail["official_history"], "sources": [], "adjustments": []}

    def export_costs(self, actor=None):
        from api.research_export import build_cost_workbook

        with transaction(self.url) as db:
            products = self._rows(db, actor)["products"]
            access = ResearchAccess(db, actor)
            visible = access.visible_ids(db) if not access.admin else set()
            rows = []
            for product in products:
                record = db.execute("SELECT payload FROM research_cost_records WHERE product_id=%s ORDER BY sequence DESC LIMIT 1", (product["id"],)).fetchone()
                payload = access.project(json.loads(record[0]), visible) if record else {}
                rows.append({"product": product, "formula": payload.get("formula", product),
                             "latest": payload.get("latest"), "inventory": payload.get("inventory")})
        return build_cost_workbook(rows)

    def backfill_history(self):
        from api.research_history import backfill
        with transaction(self.url, write=True) as db:
            return backfill(db)

    def _linked_history(self, db, key, periods=None):
        from api.research_history import linked_history
        return linked_history(db,key,periods)

    def formulas(self, actor=None):
        with transaction(self.url) as db:
            rows=[]
            access = ResearchAccess(db, actor)
            visible = access.visible_ids(db) if not access.admin else set()
            for raw,lifecycle,revision,has_draft in db.execute('SELECT f.formula,f.lifecycle,f.revision,EXISTS(SELECT 1 FROM research_drafts d WHERE d.id=f.id) FROM research_formulas f ORDER BY position'):
                formula=json.loads(raw)
                if formula['kind']=='recipe' and access.allows(formula):
                    if lifecycle=='draft':
                        draft=db.execute('SELECT formula FROM research_drafts WHERE id=%s',(formula['id'],)).fetchone()
                        if draft:
                            formula=json.loads(draft[0])
                    rows.append(access.project(dict({k:v for k,v in formula.items() if k!="source_hashes"},lifecycle=lifecycle,revision=revision,has_draft=bool(has_draft) or lifecycle=='draft'),visible))
            departments = [{'id':ident,'name':name} for ident,name in db.execute("SELECT id,name FROM organization_departments WHERE parent_id IS NULL AND (name LIKE '研发%' OR name='浙江实验室') ORDER BY (name='研发五部') DESC,name")] if access.admin else [{'id':ident,'name':value['name']} for ident,value in sorted(access.departments.items(),key=lambda item:(not item[1]['primary'],item[1]['name']))]
            return {'formulas':rows,'owners':self._options(db,access)['owners'],'departments':departments}

    def create_formula(self, body, actor):
        name,owner=body['name'].strip(),body['owner'].strip()
        if not name or len(name)>200 or any(ord(c)<32 for c in name):
            raise ValueError('请填写有效产品内编（最多200字）')
        if name.upper() in {'CF020C','CF401B'}:
            raise ValueError('该内编属于停购原料或已确认复配，不能另建产品配方')
        with transaction(self.url, write=True) as db:
            activation_grants.require_current(self.url, actor, 'can_edit', 'research')
            access = ResearchAccess(db, actor)
            department_id,department_name = access.creation_department(db,body.get('department_id'))
            owners=self._options(db,access)['owners']
            if owner not in owners:
                raise ValueError('请选择已有负责人')
            if db.execute("SELECT 1 FROM research_formulas WHERE translate(trim(formula::jsonb->>'name'),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')=translate(%s,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')",(name,)).fetchone():
                raise ValueError('产品内编已存在，请维护原配方')
            key='recipe:'+str(uuid4())
            formula={'id':key,'name':name,'owner':owner,'kind':'recipe','yield':'1','lines':[],'source_row':None,'sheet':None,'revision':0}
            formula.update(department_id=department_id,department=department_name)
            position=db.execute('SELECT COALESCE(MAX(position),0)+1 FROM research_formulas').fetchone()[0]
            db.execute("INSERT INTO research_formulas(id,position,revision,formula,lifecycle) VALUES(%s,%s,0,%s,'draft')",(key,position,packed(formula)))
            return dict(formula,lifecycle='draft')

    def _references(self, db, key):
        return [{'id':r['id'],'name':r['name']} for raw, in db.execute("SELECT formula FROM research_formulas WHERE lifecycle='active' AND id!=%s ORDER BY _order",(key,))
                for r in [json.loads(raw)] if any(line['kind']!='material' and line['ref']==key for line in r['lines'])]

    def delete_formula(self, key, body, actor):
        with transaction(self.url, write=True) as db:
            activation_grants.require_current(self.url, actor, "can_edit", "research")
            row = db.execute('SELECT revision,draft_sequence,lifecycle,formula FROM research_formulas WHERE id=%s', (key,)).fetchone()
            if not row:
                raise KeyError('产品不存在')
            ResearchAccess(db,actor).require(json.loads(row[3]))
            if row[1] != body['revision']:
                raise RuntimeError('草稿已变化，请重新核对')
            if row[0] != 0 or row[2] != 'draft' or json.loads(row[3])['kind'] != 'recipe' or db.execute('SELECT 1 FROM research_formula_versions WHERE id=%s', (key,)).fetchone():
                raise ValueError('仅可删除从未启用的新配方')
            for raw, in db.execute('SELECT formula FROM research_formulas WHERE id!=%s UNION ALL SELECT formula FROM research_drafts WHERE id!=%s', (key,key)):
                recipe = json.loads(raw)
                if any(line['kind'] != 'material' and line['ref'] == key for line in recipe['lines']):
                    raise ValueError('仍被配方或草稿引用，不能删除')
            db.execute('DELETE FROM research_drafts WHERE id=%s', (key,))
            db.execute('DELETE FROM research_formulas WHERE id=%s', (key,))
        return {'status':'deleted'}

    def deactivate(self, key, body, actor):
        with transaction(self.url, write=True) as db:
            activation_grants.require_current(self.url, actor, "can_manage_catalog", "research")
            row=db.execute('SELECT revision,formula,lifecycle FROM research_formulas WHERE id=%s',(key,)).fetchone()
            if not row:
                raise KeyError('产品不存在')
            ResearchAccess(db,actor).require(json.loads(row[1]))
            if row[0]!=body['revision'] or row[2]!='active':
                raise RuntimeError('配方状态已变化，请重新核对')
            formula=json.loads(row[1])
            if formula['kind']!='recipe':
                raise ValueError('已确认复配方案不可停用')
            references=self._references(db,key)
            if references:
                raise ValueError('仍被在用配方引用，不能停用')
            # Sequence invalidates any previously reviewed draft even if its formula is unchanged.
            db.execute("UPDATE research_formulas SET lifecycle='inactive',draft_sequence=draft_sequence+1 WHERE id=%s",(key,))
            db.execute("UPDATE research_drafts SET revision=(SELECT draft_sequence FROM research_formulas WHERE id=%s),simulation_token='' WHERE id=%s",(key,key))
            enqueue(db,'配方停用：'+formula['name'])
            return {'status':'inactive'}

    def detail_etag(self, key, actor):
        with transaction(self.url) as db:
            row = db.execute("SELECT formula FROM research_formulas WHERE id=%s", (key,)).fetchone()
            if not row:
                raise KeyError("产品不存在")
            ResearchAccess(db, actor).require(json.loads(row[0]))
            # Detail includes actor-specific activation capabilities and current inventory inputs.
            return 'W/"' + digest([key, actor['id'], self.overview_etag(actor, MATERIAL_TABLES)]) + '"'

    def detail(self, key, actor=None):
        with transaction(self.url) as db:
            row = db.execute("SELECT formula,draft_sequence,lifecycle FROM research_formulas WHERE id=%s", (key,)).fetchone()
            if not row:
                raise KeyError("产品不存在")
            formula = json.loads(row[0])
            access = ResearchAccess(db,actor)
            access.require(formula)
            visible = access.visible_ids(db) if not access.admin else set()
            history = access.project([r for r in self._linked_history(db,key) if access.allows(r.get('formula',r))],visible)
            current = next((r for r in history if r['record_type']=='formal'),{})
            product = next(iter(self._rows(db,actor,key)["products"]), dict(formula, **{k:current.get(k) for k in ("latest_cost","inventory_cost","change","status")}))
            pending = db.execute("SELECT status FROM research_events WHERE status!='done' ORDER BY _order LIMIT 1").fetchone()
            if pending:
                product["status"] = "failed" if pending[0] == "failed" else "updating"
            product.update(lifecycle=row[2],revision=formula['revision'])
            draft = db.execute("SELECT revision,formula,simulation_token,simulation FROM research_drafts WHERE id=%s", (key,)).fetchone()
            product['has_draft']=bool(draft) or row[2]=='draft'
            inputs = capture(db)
            if not any(r['id']==key for r in inputs['package']['recipes']):
                inputs['package']['recipes'].append(formula)
            options = self._options(db,access)
            visible_codes = {r["code"] for r in options["materials"]}
            live = None
            if row[2]=='active' and not pending:
                fingerprint = digest(inputs)
                with self._detail_calculation_lock:
                    if self._detail_calculation is None or self._detail_calculation[0] != fingerprint:
                        self._detail_calculation = (fingerprint, evaluate(inputs))
                    # Share pure arithmetic only; callers and permission projection get private copies.
                    live = {policy:deepcopy(values[key]) for policy,values in self._detail_calculation[1].items()}
            return access.project({"product": product, "latest": current.get("latest"), "inventory": current.get("inventory"),
                "recipes": [formula], "prices": {k:v for k,v in inputs["prices"].items() if k in visible_codes}, "history": history,
                "draft_revision": row[1], "draft": {"revision": draft[0],"formula":json.loads(draft[1]),"simulation_token":draft[2],"simulation":json.loads(draft[3]) if draft[3] else None} if draft else None,
                "options": options,"referenced_by":self._references(db,key),
                **({'latest':live['latest'],'inventory':live['inventory']} if live else {})},visible)

    def history(self, event_id=None, actor=None, product_id=None, summary=False, histories=None):
        from api.research_history import version_history
        with transaction(self.url) as db:
            access = ResearchAccess(db,actor)
            return version_history(db,event_id,access=None if access.admin else access,product_id=product_id,summary=summary,histories=histories)

    def trials(self, actor=None):
        with transaction(self.url) as db:
            package = json.loads(db.execute("SELECT payload FROM research_meta").fetchone()[0])
            access = ResearchAccess(db,actor)
            visible = access.visible_ids(db) if not access.admin else set()
        historical = package["current_policy"]["historical_recipe_ids"]
        return access.project({"recipes":[dict(r, latest=package["source_replay"].get(r["id"])) for r in package["recipes"] if r["kind"] == "recipe" and r["id"] in historical and access.allows(r)]}, visible | {r['id'] for r in package['recipes'] if r['id'] in historical and access.allows(r)})

    def _simulate(self, db, key, body, actor=None):
        row = db.execute("SELECT formula,revision,draft_sequence,lifecycle FROM research_formulas WHERE id=%s", (key,)).fetchone()
        if not row:
            raise KeyError("产品不存在")
        original = json.loads(row[0])
        access = ResearchAccess(db,actor)
        access.require(original)
        if not access.admin and access.level < 3:
            raise PermissionError('没有研发编辑权限')
        if body["draft_revision"] != row[2]:
            raise RuntimeError("草稿已被其他人修改，请保留输入并重新核对")
        if original["kind"] != "recipe":
            raise ValueError("已确认复配方案不可在产品编辑中修改")
        formula = deepcopy(original)
        reason = body["formula"].get("adjustment_reason", "").strip()
        note = body["formula"].get("adjustment_note", "").strip()
        first_formula = row[1] == 0 and row[3] == "draft"
        if first_formula and not reason:
            reason = "新增配方"
        if (reason not in ADJUSTMENT_REASONS and not (first_formula and reason == "新增配方")) or (reason == "其他" and not note):
            raise ValueError("请选择调整原因；选择其他时须填写说明")
        if len(note) > 1000:
            raise ValueError("调整说明不能超过1000字")
        manual = body["formula"].get("manual_costs", {})
        if not isinstance(manual, dict) or set(manual) - {"latest", "inventory"}:
            raise ValueError("无效成本口径")
        formula.update(adjustment_reason=reason, adjustment_note=note,
            manual_costs={p: decimal_text(number(v, "手动成本")) if v is not None else None for p,v in manual.items()})
        formula["yield"] = decimal_text(number(body["formula"]["yield"], "收率", positive=True))
        if original.get('yield_source') and Decimal(formula['yield']) != Decimal(original['yield']):
            formula['yield_source'] = {'kind': 'manual_edit'}
        formula["ratio_linked"] = body["formula"].get("ratio_linked", True)
        base = body["formula"].get("ratio_base")
        if base is not None:
            formula["ratio_base"] = decimal_text(number(base, "联动基准投料", positive=True))
        formula["lines"] = []
        options = self._options(db,access)
        owner = body["formula"].get("owner")
        if owner is not None:
            if owner not in options["owners"]:
                raise ValueError("请选择已有负责人")
            formula["owner"] = owner
        allowed = {"material": {r["code"] for r in options["materials"]}, "recipe": {r["id"] for r in options["recipes"]}, "composite":{r["id"] for r in options["composites"]}}
        if not 1 <= len(body["formula"]["lines"]) <= 500:
            raise ValueError("投料明细应为1至500条")
        for pos, raw in enumerate(body["formula"]["lines"]):
            kind, ref = raw["kind"], raw["ref"]
            if kind not in allowed or ref not in allowed[kind]:
                raise ValueError("投料引用已失效或不在在用原料范围：" + ref)
            quantity = decimal_text(input_number(raw["quantity"], raw, "投料量"))
            # A reordered source row retains its verified provenance; client text cannot invent source cells.
            old = next((line for line in original["lines"] if raw.get("source_row") is not None and line.get("source_row") == raw["source_row"]), {})
            line = deepcopy(old) if (old.get("kind"),old.get("ref")) == (kind,ref) else {"source_row":None,"source_cells":{}}
            name = ref if kind == "material" else next(r["name"] for r in options["recipes"]+options["composites"] if r["id"] == ref)
            line.update(kind=kind,ref=ref,code=name,quantity=quantity)
            ratio = raw.get("ratio")
            if ratio is not None:
                line["ratio"] = decimal_text(input_number(ratio, raw, "配方比例"))
            else:
                line.pop("ratio", None)
            formula["lines"].append(line)
        inputs = capture(db)
        before = evaluate(inputs)
        formula["revision"] = row[1] + 1
        inputs["package"]["recipes"] = [r for r in inputs["package"]["recipes"] if r['id']!=key]+[formula]
        after = evaluate(inputs)
        affected = []
        lookup = {r["id"]:r for r in inputs["package"]["recipes"]}
        def uses(recipe, target, seen):
            if recipe["id"] == target:
                return True
            if recipe["id"] in seen:
                return False
            seen.add(recipe["id"])
            return any(line["kind"] != "material" and uses(lookup[line["ref"]],target,seen) for line in recipe["lines"])
        for r in inputs["package"]["recipes"]:
            if r["kind"] == "recipe" and uses(r,key,set()):
                affected.append({"id":r["id"],"name":r["name"]})
        blocking = sorted(set(m for r in affected for policy in after if after[policy][r["id"]]["cost"] is None for m in after[policy][r["id"]]["missing_materials"]))
        token = digest({"inputs":inputs,"draft_revision":row[2]})
        blank={'cost':None,'yield':original['yield'],'total_input':'0','output_quantity':'0','lines':[],'missing_materials':[]}
        confirmed_yield = formula.get('source_kind') == 'erp_bom' and formula.get('yield_source', {}).get('kind') in {'mes_mean','bom_ratio_sum','user_confirmed'}
        return {"latest":after["latest"][key],"inventory":after["inventory"][key],"current_latest":before["latest"].get(key,blank),"current_inventory":before["inventory"].get(key,blank),
                "affected":affected,"simulation_token":token,"blocking":blocking,"warnings":["收率超过100%，请核对；原表值予以保留"] if Decimal(formula["yield"]) > 1 and not confirmed_yield else [],"formula":formula}

    def simulate(self, key, body, actor=None):
        with transaction(self.url) as db:
            result = self._simulate(db,key,body,actor)
            access = ResearchAccess(db,actor)
            visible = access.visible_ids(db) if not access.admin else set()
            return access.project(result,visible)

    def save(self, key, body, actor):
        with transaction(self.url, write=True) as db:
            activation_grants.require_current(self.url, actor, "can_edit", "research")
            result = self._simulate(db,key,body,actor)
            if body["simulation_token"] != result["simulation_token"]:
                raise RuntimeError("试算后价格或配方已变化，请重新试算")
            revision = body["draft_revision"] + 1
            db.execute("UPDATE research_formulas SET draft_sequence=%s WHERE id=%s", (revision,key))
            # New revision produces a new review token; activation checks it against current frozen inputs.
            result = self._simulate(db,key,dict(body,draft_revision=revision),actor)
            db.execute("INSERT INTO research_drafts(id,revision,formula,simulation_token,actor,updated_at,simulation) VALUES(%s,%s,%s,%s,%s,%s,%s) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,formula=excluded.formula,simulation_token=excluded.simulation_token,actor=excluded.actor,updated_at=excluded.updated_at,simulation=excluded.simulation",
                       (key,revision,packed(result["formula"]),result["simulation_token"],actor,now(),packed({k:v for k,v in result.items() if k != "formula"})))
            return {"revision":revision,"simulation_token":result["simulation_token"]}

    def discard(self, key, revision, actor):
        with transaction(self.url, write=True) as db:
            activation_grants.require_current(self.url, actor, "can_edit", "research")
            formula = db.execute('SELECT formula FROM research_formulas WHERE id=%s',(key,)).fetchone()
            if not formula:
                raise KeyError('产品不存在')
            ResearchAccess(db,actor).require(json.loads(formula[0]))
            row = db.execute("SELECT revision FROM research_drafts WHERE id=%s", (key,)).fetchone()
            if not row or row[0] != revision:
                raise RuntimeError("草稿已变化，请重新核对")
            db.execute("DELETE FROM research_drafts WHERE id=%s", (key,))
            db.execute("UPDATE research_formulas SET draft_sequence=draft_sequence+1 WHERE id=%s", (key,))
        return {"status":"discarded"}

    def activate(self, key, body, actor):
        with transaction(self.url, write=True) as db:
            activation_grants.require_current(self.url, actor, "can_activate", "research")
            formula_row = db.execute('SELECT formula FROM research_formulas WHERE id=%s',(key,)).fetchone()
            if not formula_row:
                raise KeyError('产品不存在')
            ResearchAccess(db,actor).require(json.loads(formula_row[0]))
            draft = db.execute("SELECT revision,formula,actor FROM research_drafts WHERE id=%s", (key,)).fetchone()
            if not draft or draft[0] != body["revision"]:
                raise RuntimeError("草稿已变化，请重新核对")
            result = self._simulate(db,key,{"formula":json.loads(draft[1]),"draft_revision":draft[0]},actor)
            if body["simulation_token"] != result["simulation_token"]:
                raise RuntimeError("试算后价格或配方已变化，请重新试算确认")
            if result["blocking"]:
                raise ValueError("引用链缺少价格，不能启用")
            formula = result["formula"]
            formula.update(edited_by=draft[2], activated_by=actor)
            for field, user_id in (("editor_name", draft[2]), ("activator_name", actor)):
                person = db.execute("SELECT display_name FROM identity_users WHERE id=%s", (user_id,)).fetchone()
                formula[field] = person[0] if person else user_id
            db.execute("UPDATE research_formulas SET revision=%s,formula=%s,draft_sequence=draft_sequence+1,lifecycle='active' WHERE id=%s", (formula["revision"],packed(formula),key))
            db.execute("INSERT INTO research_formula_versions(id,revision,formula,actor,recorded_at) VALUES(%s,%s,%s,%s,%s)", (key,formula["revision"],packed(formula),actor,now()))
            db.execute("DELETE FROM research_drafts WHERE id=%s", (key,))
            enqueue(db,"配方启用："+formula["name"])
        return {"status":"updating"}


class FormulaLine(BaseModel):
    model_config = ConfigDict(extra="ignore")
    kind: str = Field(max_length=20)
    ref: str = Field(min_length=1,max_length=250)
    code: str = Field(default="",max_length=250)
    quantity: str = Field(max_length=64)
    ratio: str | None = Field(default=None,max_length=64)
    source_row: int | None = None


class FormulaBody(BaseModel):
    model_config = ConfigDict(extra="ignore")
    owner: str | None = Field(default=None,max_length=100)
    adjustment_reason: str = Field(default="",max_length=100)
    adjustment_note: str = Field(default="",max_length=1000)
    manual_costs: dict[str, str | None] = Field(default_factory=dict)
    ratio_linked: bool = True
    ratio_base: str | None = Field(default=None,max_length=64)
    yield_: str = Field(alias="yield",max_length=64)
    lines: list[FormulaLine] = Field(min_length=1,max_length=500)


class SimulationBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    formula: FormulaBody
    draft_revision: int = Field(ge=0)
    simulation_token: str = Field(default="",max_length=64)


class RevisionBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: int = Field(ge=1)
    simulation_token: str = Field(default="",max_length=64)


class DeleteFormulaBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: int = Field(ge=0)


class ActivationGrantBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool
    manager: bool | None = None


class NewFormulaBody(BaseModel):
    model_config = ConfigDict(extra='forbid')
    name: str = Field(min_length=1,max_length=200)
    owner: str = Field(min_length=1,max_length=100)
    department_id: str | None = Field(default=None,max_length=100)


def create_research_router(store, settings):
    router = APIRouter(prefix="/api/workbenches/research",tags=["research"])
    # shortcut: fixed stripes may serialize unrelated scopes; expand only if profiling shows collisions.
    overview_locks = [Lock() for _ in range(64)]
    overview_cache_lock = Lock()
    overview_cache = OrderedDict()
    detail_cache = OrderedDict()
    detail_cache_bytes = 0
    read_slots = Semaphore(2)  # Leave connections for authentication and cost writers.
    def actor(request, level=2):
        if settings.workbench_modes["research"] != "active":
            raise HTTPException(404,"研发工作台未启用")
        if getattr(request.app.state,"research_error",None):
            raise HTTPException(503,"研发工作台暂时不可用")
        user = getattr(request.state,"current_user",None)
        if not user:
            raise HTTPException(401,"请登录")
        if not user["is_system_admin"] and user["scope_levels"].get("research",0) < level:
            raise HTTPException(403,"没有此项研发操作权限")
        return user
    def read_actor(request):
        # A queued reader may have been logged out or downgraded while waiting.
        request.state.current_user = IdentityStore(store.url).user_for_session(request.cookies.get(SESSION_COOKIE_NAME, ""))
        return actor(request)
    def run(fn,*args):
        try:
            return fn(*args)
        except PermissionError as error:
            raise HTTPException(403,str(error)) from error
        except KeyError as error:
            raise HTTPException(404,str(error)) from error
        except RuntimeError as error:
            raise HTTPException(409,str(error)) from error
        except (ValueError, ArithmeticError) as error:
            raise HTTPException(422,str(error)) from error
    @router.get("/activation-grants")
    def grants(request:Request, offset:int=Query(0,ge=0), limit:int=Query(10,ge=1,le=50)):
        user=actor(request,3)
        if not activation_grants.capabilities(store.url,user,"research")["can_manage_grants"]:
            raise HTTPException(403,"无启用授权管理权限")
        return activation_grants.grants(store.url,"research",offset,limit,actor=user)
    @router.put("/activation-grants/{user_id}")
    def set_grant(user_id:str,body:ActivationGrantBody,request:Request):
        user=actor(request,3)
        run(activation_grants.set_grant,store.url,user,user_id,body.enabled,body.manager,"research")
        return activation_grants.grants(store.url,"research",actor=user)
    @router.get("/products")
    def products(request:Request):
        return store.listing(actor(request))
    @router.get("/material-prices")
    def material_prices(request:Request,response:Response):
        with transaction(store.url):
            user=read_actor(request)
            tag=run(store.overview_etag,user,MATERIAL_TABLES)
            headers={"ETag":tag,"Cache-Control":"no-store","Vary":"Cookie"}
            if tag in [value.strip() for value in request.headers.get("if-none-match", "").split(",")]:
                return Response(status_code=304,headers=headers)
            payload=run(store.material_prices,user)
        return JSONResponse(payload,headers=headers)
    @router.get("/material-prices/{material_id}")
    def material_price_detail(material_id:str,request:Request,response:Response):
        actor(request)
        detail = run(store.material_price_detail,material_id)
        if detail is None:
            raise HTTPException(404,"原料不存在")
        response.headers["Cache-Control"] = "no-store"
        return detail
    @router.get("/products/export")
    def export_costs(request:Request):
        user=actor(request)
        return Response(run(store.export_costs,user), media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                        headers={"Content-Disposition": "attachment; filename=research-costs.xlsx", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})
    @router.get('/formulas')
    def formulas(request:Request):
        return store.formulas(actor(request))
    @router.post('/formulas')
    def create_formula(body:NewFormulaBody,request:Request):
        user=actor(request,3)
        return run(store.create_formula,body.model_dump(),user['id'])
    @router.post('/products/{key}/deactivate')
    def deactivate(key:str,body:RevisionBody,request:Request):
        user=actor(request,4)
        return run(store.deactivate,key,body.model_dump(),user['id'])
    @router.get("/pages/{kind}")
    def pages(request:Request, kind:str, page:int=Query(1,ge=1), page_size:int=Query(50,ge=1,le=200),
              search:str=Query('',max_length=200), owner:str=Query('',max_length=200), department:str=Query('',max_length=200),
              status:str=Query('',pattern='^(|ready|missing|updating|failed|active|draft|inactive)$'),
              draft:str=Query('',pattern='^(|yes|no)$'), movement:str=Query('',pattern='^(|up|down|flat|none)$'),
              yield_warning:bool=False, sort:str=Query('name',pattern='^(name|department|owner|status|latest_cost|inventory_cost|change|yield|lines)$'), asc:bool=True):
        from api.research_pages import page_rows
        if kind not in ('products','formulas'):
            raise HTTPException(404,'列表不存在')
        user=actor(request)
        query=dict(kind=kind,page=page,page_size=page_size,search=search,owner=owner,department=department,status=status,draft=draft,movement=movement,yield_warning=yield_warning,sort=sort,asc=asc)
        # Coalesce snapshot rebuilds; queued readers recheck live authorization before using cached data.
        scope=[kind,user['is_system_admin'],user['scope_levels'].get('research',0),sorted((d['id'],d['is_primary']) for d in user.get('departments',[]) if d['name'].startswith('研发') or d['name']=='浙江实验室')]
        with overview_locks[int(digest(scope),16) % len(overview_locks)], read_slots:
            with transaction(store.url):
                user=read_actor(request)
                version=run(store.overview_etag,user)
                tag='W/"'+digest([version,query])+'"'
                headers={'ETag':tag,'Cache-Control':'no-store','Vary':'Cookie'}
                if tag in [v.strip() for v in request.headers.get('if-none-match','').split(',')]:
                    return Response(status_code=304,headers=headers)
                cache_key=version+':page:'+kind
                with overview_cache_lock:
                    body=overview_cache.get(cache_key)
                if body is None:
                    # shortcut: rebuild the scoped list per revision; use indexed projections if cold reads exceed budget.
                    payload=store.formulas(user) if kind=='formulas' else store.listing(user)
                    for row in payload[kind]:
                        if isinstance(row.get('lines'),list): row['lines']=len(row['lines'])
                    body=JSONResponse(payload).body
                    with overview_cache_lock:
                        overview_cache[cache_key]=body
                        while len(overview_cache)>16 or sum(len(v) for v in overview_cache.values())>64*1024*1024:
                            overview_cache.popitem(last=False)
                payload=json.loads(body)
                result=page_rows(payload[kind],**query)
                result.update(pending=payload.get('pending',False),departments=payload.get('departments',[]),creation_owners=payload.get('owners',[]))
        return JSONResponse(result,headers=headers)
    @router.get("/overview")
    def overview(request:Request,summary:bool=False):
        user=actor(request)
        validators = [tag.strip() for tag in request.headers.get("if-none-match", "").split(",")]
        if request.headers.get("if-none-match"):
            # An unchanged reader need not queue behind another department's full rebuild.
            with transaction(store.url):
                user = read_actor(request)
                etag = run(store.overview_etag,user)
                if summary:etag = etag[:-1] + ":summary\""
                if etag in validators:
                    return Response(status_code=304, headers={"ETag":etag,"Cache-Control":"no-store","Vary":"Cookie"})
        scope = [user['is_system_admin'],user['scope_levels'].get('research',0),sorted((d['id'],d['is_primary']) for d in user.get('departments',[]) if d['name'].startswith('研发') or d['name']=='浙江实验室')]
        scope_lock = overview_locks[int(digest(scope),16) % len(overview_locks)]
        # Wait without a database connection; readers of one version/scope build only once.
        with scope_lock, read_slots:
            with transaction(store.url):
                user = read_actor(request)
                etag = run(store.overview_etag,user)
                if summary:etag = etag[:-1] + ":summary\""
                headers = {"ETag": etag, "Cache-Control": "no-store", "Vary": "Cookie"}
                if etag in validators:
                    return Response(status_code=304, headers=headers)
                with overview_cache_lock:
                    body = overview_cache.get(etag)
                    if body is not None:overview_cache.move_to_end(etag)
                if body is None:
                    payload = store.overview(user,series=True) if summary else store.overview(user)
            if body is None:
                # Store output is already JSON-native; encode after releasing the read snapshot.
                body = JSONResponse(payload).body
                with overview_cache_lock:
                    overview_cache[etag] = body
                    overview_cache.move_to_end(etag)
                    while len(overview_cache) > 16 or sum(len(value) for value in overview_cache.values()) > 64*1024*1024:
                        overview_cache.popitem(last=False)
        return Response(body, media_type="application/json", headers=headers)
    @router.delete("/products/{key}")
    def delete_formula(key:str,body:DeleteFormulaBody,request:Request):
        user=actor(request,3)
        return run(store.delete_formula,key,body.model_dump(),user["id"])
    @router.get("/products/{key}")
    def detail(key:str,request:Request):
        nonlocal detail_cache_bytes
        user=actor(request)
        validators = [tag.strip() for tag in request.headers.get("if-none-match", "").split(",")]
        if validators:
            with transaction(store.url):
                user = read_actor(request)
                etag = run(store.detail_etag,key,user)
                if etag in validators:
                    return Response(status_code=304,headers={"ETag":etag,"Cache-Control":"no-store","Vary":"Cookie"})
        # Coalesce one actor/product rebuild without holding a database connection while waiting.
        with overview_locks[int(digest([user['id'],key]),16) % len(overview_locks)], read_slots:
            with transaction(store.url):
                user = read_actor(request)
                etag = run(store.detail_etag,key,user)
                headers = {"ETag":etag,"Cache-Control":"no-store","Vary":"Cookie"}
                with overview_cache_lock:
                    body = detail_cache.get(etag)
                    if body is not None:detail_cache.move_to_end(etag)
                if body is None:
                    payload = {**run(store.detail,key,user),"capabilities":activation_grants.capabilities(store.url,user,"research")}
            if body is None:
                body = JSONResponse(payload).body
                with overview_cache_lock:
                    # Bound bytes as well as entries: long formula histories must not grow process memory indefinitely.
                    if len(body) <= 16 * 1024 * 1024:
                        detail_cache[etag] = body
                        detail_cache_bytes += len(body)
                        while len(detail_cache)>32 or detail_cache_bytes>16*1024*1024:
                            _, removed = detail_cache.popitem(last=False)
                            detail_cache_bytes -= len(removed)
        return Response(body,media_type="application/json",headers=headers)
    @router.get("/history")
    def history(request:Request):
        return store.history(actor=actor(request))
    @router.get("/history/{key}")
    def history_detail(key:str,request:Request,product_id:str|None=None,summary:bool=False):
        return run(store.history,key,actor(request),product_id,summary)
    @router.get("/trials")
    def trials(request:Request):
        return store.trials(actor(request))
    @router.post("/products/{key}/simulate")
    def simulate(key:str,body:SimulationBody,request:Request):
        user=actor(request,3)
        return run(store.simulate,key,body.model_dump(by_alias=True),user)
    @router.put("/products/{key}/draft")
    def save(key:str,body:SimulationBody,request:Request):
        user=actor(request,3)
        return run(store.save,key,body.model_dump(by_alias=True),user["id"])
    @router.delete("/products/{key}/draft")
    def discard(key:str,body:RevisionBody,request:Request):
        user=actor(request,3)
        return run(store.discard,key,body.revision,user["id"])
    @router.post("/products/{key}/activate")
    def activate(key:str,body:RevisionBody,request:Request):
        user=actor(request,3)
        if not activation_grants.capabilities(store.url,user,"research")["can_activate"]:
            raise HTTPException(403,"没有研发成本启用权限")
        return run(store.activate,key,body.model_dump(),user["id"])
    return router
