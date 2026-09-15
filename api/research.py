"""Research formulas, frozen cost events and optimistic shared drafts.

Purchase writers enqueue frozen inputs in their own transaction. Calculation and
history insertion happen later, so a calculation failure cannot undo a purchase.
"""
from __future__ import annotations

import hashlib
import json
import psycopg
from copy import deepcopy
from datetime import UTC, datetime
from decimal import Decimal, ROUND_HALF_UP, localcontext
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Request, Query
from pydantic import BaseModel, ConfigDict, Field

from api import procurement_collaboration as activation_grants
from api.research_formulas import calculate, number, decimal_text
from api.postgres import transaction

ADJUSTMENT_REASONS = ("配方优化", "实际投料修正", "收率修正", "成本核对修正", "临时成本测算", "其他")


def packed(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest(value):
    return hashlib.sha256(packed(value).encode()).hexdigest()


def now():
    return datetime.now(UTC).isoformat()


def capture(db):
    package = json.loads(db.execute("SELECT payload FROM research_meta WHERE id=1").fetchone()[0])
    package = {k:package[k] for k in ("materials", "default_composite", "source_sha256", "source_filename") if k in package}
    package["recipes"] = [json.loads(r[0]) for r in db.execute("SELECT formula FROM research_formulas WHERE lifecycle='active' ORDER BY position")]
    package["current_policy"] = {"material_replacements": {"CF020C": "CF020D"}}
    batch = db.execute("SELECT id FROM procurement_price_batches ORDER BY version DESC LIMIT 1").fetchone()
    prices = {r[0]: {"latest_price": r[1], "inventory_price": r[2]} for r in db.execute("""
        SELECT m.code,b.latest_price,i.price FROM procurement_materials m
        LEFT JOIN procurement_price_batch_items b ON b.material_id=m.id AND b.batch_id=%s
        LEFT JOIN procurement_inventory i ON i.material_id=m.id WHERE m.archived_at IS NULL
        """, (batch[0] if batch else None,))}
    return {"package": package, "prices": prices}


def enqueue(db, reason):
    # Called by every formal price activation and stock import, including CLI paths.
    if not db.execute("SELECT 1 FROM research_meta").fetchone():
        return
    db.execute("INSERT INTO research_events(id,recorded_at,reason,inputs,status,attempts,error) VALUES (%s,%s,%s,%s,'pending',0,NULL)",
               (str(uuid4()), now(), reason, packed(capture(db))))


def evaluate(inputs):
    return {policy: calculate(inputs["package"], inputs["prices"], price_policy=policy)
            for policy in ("latest", "inventory")}


def signature(inputs, results, key, *, include_basis=True):
    recipes = {r["id"]: r for r in inputs["package"]["recipes"]}
    cache = {}
    def visit(ref):
        if ref in cache:
            return cache[ref]
        recipe = recipes[ref]
        lines = []
        for left, right in zip(results["latest"][ref]["lines"], results["inventory"][ref]["lines"]):
            item = {k: left[k] for k in ("kind", "ref", "quantity")}
            if Decimal(left["quantity"]) > 0:
                item["inputs"] = visit(left["ref"]) if left["kind"] != "material" else [
                    [line["unit_cost"], {"historical_latest":"latest", "current_latest_fallback":"latest", "current_inventory_fallback":"inventory"}.get(line["basis"],line["basis"])] if include_basis else line['unit_cost'] for line in (left, right)]
            lines.append(item)
        cache[ref] = digest({"yield": recipe["yield"], "lines": lines,
            **({"adjustment": {k:recipe.get(k) for k in ("manual_costs", "adjustment_reason", "adjustment_note", "edited_by", "activated_by")}} if "adjustment_reason" in recipe else {}),
            **({"owner": recipe.get("owner"), "ratios": [line.get("ratio") for line in recipe["lines"]], "ratio_linked": recipe.get("ratio_linked", True), "ratio_base": recipe.get("ratio_base")} if any("ratio" in line for line in recipe["lines"]) else {})})
        return cache[ref]
    return visit(key)


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
            "reason": f"最新优先成本（按两位小数比较）：{old:.2f} → {current:.2f}"}


class ResearchStore:
    def __init__(self, url: str):
        self.url = url

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
        # ponytail: one transaction writer processes the small RD5 graph; split workers only if throughput requires it.
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
                        sig = signature(inputs, results, key)
                        old = db.execute("SELECT signature,payload FROM research_cost_records WHERE product_id=%s ORDER BY sequence DESC LIMIT 1", (key,)).fetchone()
                        if old and record_signature(json.loads(old[1])) == signature(inputs,results,key,include_basis=False):
                            continue
                        left, right = results["latest"][key], results["inventory"][key]
                        dependencies = dependency_ids(key)
                        payload = {**formula, "latest_cost": left["cost"], "inventory_cost": right["cost"],
                            "latest": left, "inventory": right, "change": comparison(left["cost"], json.loads(old[1]) if old else None),
                            "recorded_at": recorded_at, "reason": reason, "event_id": event_id,
                            "missing_materials": sorted(set(left["missing_materials"] + right["missing_materials"])),
                            "status": "missing" if left["missing_materials"] or right["missing_materials"] else "ready",
                            "formula": formula, "graph": [r for r in graph if r["id"] in dependencies],
                            "calculations": {p:{k:v for k,v in values.items() if k in dependencies} for p,values in results.items()}}
                        db.execute("INSERT INTO research_cost_records(event_id,product_id,signature,payload) VALUES(%s,%s,%s,%s)", (event_id,key,sig,packed(payload)))
                    db.execute("UPDATE research_events SET status='done',attempts=attempts+1,error=NULL WHERE id=%s", (event_id,))
                    processed += 1
            except (ValueError, KeyError, ArithmeticError, psycopg.Error) as error:
                if event_id:
                    with transaction(self.url, write=True) as db:
                        db.execute("UPDATE research_events SET status='failed',attempts=attempts+1,error=%s WHERE id=%s", (str(error)[:1000],event_id))
                raise

    def _options(self, db):
        materials = [{"code": r[0]} for r in db.execute("""SELECT m.code FROM procurement_materials m
            JOIN procurement_department_materials dm ON dm.material_id=m.id
            JOIN procurement_departments d ON d.id=dm.department_id
            WHERE d.name='研发五部' AND m.archived_at IS NULL AND m.code NOT IN ('CF020C','CF401B') ORDER BY m.code""")]
        formulas = [json.loads(r[0]) for r in db.execute("SELECT formula FROM research_formulas WHERE lifecycle='active' ORDER BY position")]
        owners = {r[0] for r in db.execute("SELECT u.display_name FROM identity_users u JOIN organization_memberships m ON m.user_id=u.id JOIN organization_departments d ON d.id=m.department_id WHERE d.name='研发五部' AND u.is_active=1")}
        return {"owners": sorted(owners | {json.loads(r[0])["owner"] for r in db.execute("SELECT formula FROM research_formulas") if json.loads(r[0])["kind"] == "recipe" and json.loads(r[0]).get("owner")}), "materials": materials, **{name: [{"id": r["id"], "name": r["name"]} for r in formulas if r["kind"] == kind]
                for name, kind in (("recipes", "recipe"), ("composites", "composite"))}}

    def _rows(self, db):
        rows = []
        pending = db.execute("SELECT status FROM research_events WHERE status!='done' ORDER BY _order LIMIT 1").fetchone()
        for formula_raw, has_draft in db.execute("SELECT f.formula,EXISTS(SELECT 1 FROM research_drafts d WHERE d.id=f.id) FROM research_formulas f WHERE f.lifecycle='active' ORDER BY f.position"):
            formula = json.loads(formula_raw)
            if formula["kind"] != "recipe":
                continue
            record = db.execute("SELECT payload FROM research_cost_records WHERE product_id=%s ORDER BY sequence DESC LIMIT 1", (formula["id"],)).fetchone()
            payload = json.loads(record[0]) if record else dict(formula, latest_cost=None,inventory_cost=None,change={"percent":None,"reason":"首次核算中"},missing_materials=[])
            payload["cost_details"] = {p: {k:payload.get(p, {}).get(k) for k in ("cost_source", "auto_cost", "difference")} for p in ("latest", "inventory")}
            for key in ("graph", "calculations", "formula", "latest", "inventory"):
                payload.pop(key, None)
            payload.update(has_draft=bool(has_draft), revision=formula["revision"])
            linked = self._linked_history(db, formula['id'])
            if linked:
                payload.update(change=linked[0]['change'],comparison_basis=linked[0].get('comparison_basis'),
                               includes_backfill=any(r['record_type']=='backfill' for r in linked))
            if pending:
                payload["status"] = "failed" if pending[0] == "failed" else "updating"
            rows.append(payload)
        return {"products": rows, "pending": bool(pending)}

    def listing(self):
        with transaction(self.url) as db:
            return self._rows(db)

    def backfill_history(self):
        from api.research_history import backfill
        with transaction(self.url, write=True) as db:
            return backfill(db)

    def _linked_history(self, db, key):
        from api.research_history import linked_history
        return linked_history(db,key)

    def formulas(self):
        with transaction(self.url) as db:
            rows=[]
            for raw,lifecycle,revision,has_draft in db.execute('SELECT f.formula,f.lifecycle,f.revision,EXISTS(SELECT 1 FROM research_drafts d WHERE d.id=f.id) FROM research_formulas f ORDER BY position'):
                formula=json.loads(raw)
                if formula['kind']=='recipe':
                    if lifecycle=='draft':
                        draft=db.execute('SELECT formula FROM research_drafts WHERE id=%s',(formula['id'],)).fetchone()
                        if draft:
                            formula=json.loads(draft[0])
                    rows.append(dict(formula,lifecycle=lifecycle,revision=revision,has_draft=bool(has_draft) or lifecycle=='draft'))
            return {'formulas':rows,'owners':self._options(db)['owners']}

    def create_formula(self, body, actor):
        name,owner=body['name'].strip(),body['owner'].strip()
        if not name or len(name)>200 or any(ord(c)<32 for c in name):
            raise ValueError('请填写有效产品内编（最多200字）')
        if name.upper() in {'CF020C','CF401B'}:
            raise ValueError('该内编属于停购原料或已确认复配，不能另建产品配方')
        with transaction(self.url, write=True) as db:
            activation_grants.require_current(self.url, actor, 'can_edit', 'research')
            owners=self._options(db)['owners']
            if owner not in owners:
                raise ValueError('请选择已有负责人')
            if db.execute("SELECT 1 FROM research_formulas WHERE translate(trim(formula::jsonb->>'name'),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')=translate(%s,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')",(name,)).fetchone():
                raise ValueError('产品内编已存在，请维护原配方')
            key='recipe:'+str(uuid4())
            formula={'id':key,'name':name,'owner':owner,'kind':'recipe','yield':'1','lines':[],'source_row':None,'sheet':None,'revision':0}
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
            if row[1] != body['revision']:
                raise RuntimeError('草稿已变化，请重新核对')
            if row[0] != 0 or row[2] != 'draft' or json.loads(row[3])['kind'] != 'recipe' or db.execute('SELECT 1 FROM research_formula_versions WHERE id=%s', (key,)).fetchone():
                raise ValueError('仅可删除从未启用的新配方')
            for raw, in db.execute('SELECT formula FROM research_formulas WHERE id!=%s UNION ALL SELECT formula FROM research_drafts WHERE id!=%s', (key,key)):
                recipe = json.loads(raw)
                if any(line['kind'] != 'material' and line['ref'] == key for line in recipe['lines']):
                    raise ValueError('仍被配方或草稿引用，不能删除：' + recipe['name'])
            db.execute('DELETE FROM research_drafts WHERE id=%s', (key,))
            db.execute('DELETE FROM research_formulas WHERE id=%s', (key,))
        return {'status':'deleted'}

    def deactivate(self, key, body, actor):
        with transaction(self.url, write=True) as db:
            activation_grants.require_current(self.url, actor, "can_manage_catalog", "research")
            row=db.execute('SELECT revision,formula,lifecycle FROM research_formulas WHERE id=%s',(key,)).fetchone()
            if not row:
                raise KeyError('产品不存在')
            if row[0]!=body['revision'] or row[2]!='active':
                raise RuntimeError('配方状态已变化，请重新核对')
            formula=json.loads(row[1])
            if formula['kind']!='recipe':
                raise ValueError('已确认复配方案不可停用')
            references=self._references(db,key)
            if references:
                raise ValueError('仍被在用配方引用，不能停用：'+'、'.join(r['name'] for r in references))
            # Sequence invalidates any previously reviewed draft even if its formula is unchanged.
            db.execute("UPDATE research_formulas SET lifecycle='inactive',draft_sequence=draft_sequence+1 WHERE id=%s",(key,))
            db.execute("UPDATE research_drafts SET revision=(SELECT draft_sequence FROM research_formulas WHERE id=%s),simulation_token='' WHERE id=%s",(key,key))
            enqueue(db,'配方停用：'+formula['name'])
            return {'status':'inactive'}

    def detail(self, key):
        with transaction(self.url) as db:
            row = db.execute("SELECT formula,draft_sequence,lifecycle FROM research_formulas WHERE id=%s", (key,)).fetchone()
            if not row:
                raise KeyError("产品不存在")
            formula = json.loads(row[0])
            history = self._linked_history(db,key)
            current = next((r for r in history if r['record_type']=='formal'),{})
            product = next((r for r in self._rows(db)["products"] if r["id"] == key), dict(formula, **{k:current.get(k) for k in ("latest_cost","inventory_cost","change","status")}))
            pending = db.execute("SELECT status FROM research_events WHERE status!='done' ORDER BY _order LIMIT 1").fetchone()
            if pending:
                product["status"] = "failed" if pending[0] == "failed" else "updating"
            product.update(lifecycle=row[2],revision=formula['revision'])
            draft = db.execute("SELECT revision,formula,simulation_token,simulation FROM research_drafts WHERE id=%s", (key,)).fetchone()
            product['has_draft']=bool(draft) or row[2]=='draft'
            inputs = capture(db)
            if not any(r['id']==key for r in inputs['package']['recipes']):
                inputs['package']['recipes'].append(formula)
            options = self._options(db)
            visible_codes = {r["code"] for r in options["materials"]}
            live = evaluate(inputs) if row[2]=='active' and not pending else None
            return {"product": product, "latest": current.get("latest"), "inventory": current.get("inventory"),
                "recipes": inputs["package"]["recipes"], "prices": {k:v for k,v in inputs["prices"].items() if k in visible_codes}, "history": history,
                "draft_revision": row[1], "draft": {"revision": draft[0],"formula":json.loads(draft[1]),"simulation_token":draft[2],"simulation":json.loads(draft[3]) if draft[3] else None} if draft else None,
                "options": options,"referenced_by":self._references(db,key),
                **({'latest':live['latest'][key],'inventory':live['inventory'][key]} if live else {})}

    def history(self, event_id=None):
        from api.research_history import version_history
        with transaction(self.url) as db:
            return version_history(db,event_id)

    def trials(self):
        with transaction(self.url) as db:
            package = json.loads(db.execute("SELECT payload FROM research_meta").fetchone()[0])
        historical = package["current_policy"]["historical_recipe_ids"]
        return {"recipes":[dict(r, latest=package["source_replay"].get(r["id"])) for r in package["recipes"] if r["kind"] == "recipe" and r["id"] in historical]}

    def _simulate(self, db, key, body):
        row = db.execute("SELECT formula,revision,draft_sequence,lifecycle FROM research_formulas WHERE id=%s", (key,)).fetchone()
        if not row:
            raise KeyError("产品不存在")
        if body["draft_revision"] != row[2]:
            raise RuntimeError("草稿已被其他人修改，请保留输入并重新核对")
        original = json.loads(row[0])
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
        formula["ratio_linked"] = body["formula"].get("ratio_linked", True)
        base = body["formula"].get("ratio_base")
        if base is not None:
            formula["ratio_base"] = decimal_text(number(base, "联动基准投料", positive=True))
        formula["lines"] = []
        options = self._options(db)
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
                raise ValueError("投料引用已失效或不在研发五部范围：" + ref)
            quantity = decimal_text(number(raw["quantity"], "投料量"))
            # A reordered source row retains its verified provenance; client text cannot invent source cells.
            old = next((line for line in original["lines"] if raw.get("source_row") is not None and line.get("source_row") == raw["source_row"]), {})
            line = deepcopy(old) if (old.get("kind"),old.get("ref")) == (kind,ref) else {"source_row":None,"source_cells":{}}
            name = ref if kind == "material" else next(r["name"] for r in options["recipes"]+options["composites"] if r["id"] == ref)
            line.update(kind=kind,ref=ref,code=name,quantity=quantity)
            ratio = raw.get("ratio")
            if ratio is not None:
                line["ratio"] = decimal_text(number(ratio, "配方比例"))
            else:
                line.pop("ratio", None)
            formula["lines"].append(line)
        inputs = capture(db)
        before = evaluate(inputs)
        formula["revision"] = row[1] + 1
        inputs["package"]["recipes"] = [r for r in inputs["package"]["recipes"] if r['id']!=key]+[formula]
        after = evaluate(inputs)
        affected = []
        def uses(recipe, target, seen):
            if recipe["id"] == target:
                return True
            if recipe["id"] in seen:
                return False
            seen.add(recipe["id"])
            lookup = {r["id"]:r for r in inputs["package"]["recipes"]}
            return any(line["kind"] != "material" and uses(lookup[line["ref"]],target,seen) for line in recipe["lines"])
        for r in inputs["package"]["recipes"]:
            if r["kind"] == "recipe" and uses(r,key,set()):
                affected.append({"id":r["id"],"name":r["name"]})
        blocking = sorted(set(m for r in affected for policy in after if after[policy][r["id"]]["cost"] is None for m in after[policy][r["id"]]["missing_materials"]))
        token = digest({"inputs":inputs,"draft_revision":row[2]})
        blank={'cost':None,'yield':original['yield'],'total_input':'0','output_quantity':'0','lines':[],'missing_materials':[]}
        return {"latest":after["latest"][key],"inventory":after["inventory"][key],"current_latest":before["latest"].get(key,blank),"current_inventory":before["inventory"].get(key,blank),
                "affected":affected,"simulation_token":token,"blocking":blocking,"warnings":["收率超过100%，请核对；原表值予以保留"] if Decimal(formula["yield"]) > 1 else [],"formula":formula}

    def simulate(self, key, body):
        with transaction(self.url) as db:
            return self._simulate(db,key,body)

    def save(self, key, body, actor):
        with transaction(self.url, write=True) as db:
            activation_grants.require_current(self.url, actor, "can_edit", "research")
            result = self._simulate(db,key,body)
            if body["simulation_token"] != result["simulation_token"]:
                raise RuntimeError("试算后价格或配方已变化，请重新试算")
            revision = body["draft_revision"] + 1
            db.execute("UPDATE research_formulas SET draft_sequence=%s WHERE id=%s", (revision,key))
            # New revision produces a new review token; activation checks it against current frozen inputs.
            result = self._simulate(db,key,dict(body,draft_revision=revision))
            db.execute("INSERT INTO research_drafts(id,revision,formula,simulation_token,actor,updated_at,simulation) VALUES(%s,%s,%s,%s,%s,%s,%s) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,formula=excluded.formula,simulation_token=excluded.simulation_token,actor=excluded.actor,updated_at=excluded.updated_at,simulation=excluded.simulation",
                       (key,revision,packed(result["formula"]),result["simulation_token"],actor,now(),packed({k:v for k,v in result.items() if k != "formula"})))
            return {"revision":revision,"simulation_token":result["simulation_token"]}

    def discard(self, key, revision, actor):
        with transaction(self.url, write=True) as db:
            activation_grants.require_current(self.url, actor, "can_edit", "research")
            row = db.execute("SELECT revision FROM research_drafts WHERE id=%s", (key,)).fetchone()
            if not row or row[0] != revision:
                raise RuntimeError("草稿已变化，请重新核对")
            db.execute("DELETE FROM research_drafts WHERE id=%s", (key,))
            db.execute("UPDATE research_formulas SET draft_sequence=draft_sequence+1 WHERE id=%s", (key,))
        return {"status":"discarded"}

    def activate(self, key, body, actor):
        with transaction(self.url, write=True) as db:
            activation_grants.require_current(self.url, actor, "can_activate", "research")
            draft = db.execute("SELECT revision,formula,actor FROM research_drafts WHERE id=%s", (key,)).fetchone()
            if not draft or draft[0] != body["revision"]:
                raise RuntimeError("草稿已变化，请重新核对")
            result = self._simulate(db,key,{"formula":json.loads(draft[1]),"draft_revision":draft[0]})
            if body["simulation_token"] != result["simulation_token"]:
                raise RuntimeError("试算后价格或配方已变化，请重新试算确认")
            if result["blocking"]:
                raise ValueError("缺少价格，不能启用：" + "、".join(result["blocking"]))
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


def create_research_router(store, settings):
    router = APIRouter(prefix="/api/workbenches/research",tags=["research"])
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
        return activation_grants.grants(store.url,"research",offset,limit)
    @router.put("/activation-grants/{user_id}")
    def set_grant(user_id:str,body:ActivationGrantBody,request:Request):
        user=actor(request,3)
        run(activation_grants.set_grant,store.url,user,user_id,body.enabled,body.manager,"research")
        return activation_grants.grants(store.url,"research")
    @router.get("/products")
    def products(request:Request):
        actor(request)
        return store.listing()
    @router.get('/formulas')
    def formulas(request:Request):
        actor(request)
        return store.formulas()
    @router.post('/formulas')
    def create_formula(body:NewFormulaBody,request:Request):
        user=actor(request,3)
        return run(store.create_formula,body.model_dump(),user['id'])
    @router.post('/products/{key}/deactivate')
    def deactivate(key:str,body:RevisionBody,request:Request):
        user=actor(request,4)
        return run(store.deactivate,key,body.model_dump(),user['id'])
    @router.get("/overview")
    def overview(request:Request):
        actor(request)
        return {**store.listing(),**store.history()}
    @router.delete("/products/{key}")
    def delete_formula(key:str,body:DeleteFormulaBody,request:Request):
        user=actor(request,3)
        return run(store.delete_formula,key,body.model_dump(),user["id"])
    @router.get("/products/{key}")
    def detail(key:str,request:Request):
        user=actor(request)
        return {**run(store.detail,key),"capabilities":activation_grants.capabilities(store.url,user,"research")}
    @router.get("/history")
    def history(request:Request):
        actor(request)
        return store.history()
    @router.get("/history/{key}")
    def history_detail(key:str,request:Request):
        actor(request)
        return run(store.history,key)
    @router.get("/trials")
    def trials(request:Request):
        actor(request)
        return store.trials()
    @router.post("/products/{key}/simulate")
    def simulate(key:str,body:SimulationBody,request:Request):
        actor(request,3)
        return run(store.simulate,key,body.model_dump(by_alias=True))
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
