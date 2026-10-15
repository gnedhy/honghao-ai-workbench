"""Apply a hash-pinned ERP candidate to an isolated copy, preserving frozen history."""
from __future__ import annotations

import hashlib
import json
import shutil
import sqlite3
from pathlib import Path
from uuid import uuid4

from api.postgres import transaction
from api.research import capture, enqueue, evaluate, now, packed
from api.organization import legacy_department


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def apply_candidate(url: str, candidate: Path, data_dir: Path, expected_inputs_sha256: str) -> dict:
    with transaction(url, write=True) as db:
        database, environment = db.execute('SELECT current_database(),environment FROM honghao_meta.database_identity').fetchone()
        if environment != 'acceptance' or not database.startswith('honghao_acceptance_erp_'):
            raise ValueError('本工具仅允许本轮独立验收库，拒绝正式库及其他测试库')
        actor = db.execute('SELECT id FROM identity_users WHERE access_level=5 AND is_active=1 ORDER BY _order LIMIT 1').fetchone()[0]
        return {**_apply_candidate(db, candidate, data_dir, expected_inputs_sha256, actor,
                                  reason='ERP统一导入隔离验收'), 'formal_database_written': False}


def _apply_candidate(db, candidate: Path, data_dir: Path, expected_inputs_sha256: str, actor: str, *, reason: str) -> dict:
    # Target policy belongs to the guarded entry points; all business changes share their transaction.
    raw = (candidate/'成本试算输入.json').read_bytes()
    if hashlib.sha256(raw).hexdigest() != expected_inputs_sha256:
        raise ValueError('候选计算输入发生变化，须重新验收')
    inputs = json.loads(raw)
    scope = read_json(candidate/'拟导入范围.json')
    approved = read_json(candidate/'业务确认-20261007.json')
    for code,review in approved.get('inventory_price_reviews',{}).items():
        if review.get('apply_to_current_inventory') is True and inputs['prices'].get(code,{}).get('inventory_price') != review.get('calculation_unit_price'):
            raise ValueError(f'{code} 当前库存价修正确认与候选核算价不一致')
    source = sqlite3.connect(f'file:{(candidate/"研发数据分析.db").resolve().as_posix()}?mode=ro', uri=True)
    try:
        sources = list(source.execute('SELECT kind,filename,sha256,sheet FROM sources'))
        materials = list(source.execute('SELECT code,unit,quantity,erp_inventory_price,evidence_json FROM material_candidates ORDER BY code'))
        material_codes={r[0] for r in materials}
        for code,audit in inputs.get('price_input_audit',{}).items():
            if code not in material_codes:
                materials.append((code,'kg',None,audit['ERP_inventory_price'],packed(audit)))
                material_codes.add(code)
        for code,price in inputs['prices'].items():
            if code not in material_codes:
                if price['inventory_price'] is not None:
                    raise ValueError(f'{code} 缺少库存价来源，拒绝推定取价')
                materials.append((code,None,None,None,packed({'取价核对':'1007 ERP未匹配，旧库存价不冒充当前库存价'})))
        expected_costs = {(c,p): cost for c,p,cost in source.execute('SELECT product,policy,cost FROM trial_costs')}
    finally:
        source.close()
    if len(scope['ERP_product_codes']) != 2371 or len(expected_costs) != 4742:
        raise ValueError('本批应为2371个ERP产品、4742项双成本核对，候选范围不符')
    stamp=now()
    archive=data_dir/'controlled-work'/'procurement-sources'
    if db.execute("SELECT 1 FROM research_drafts LIMIT 1").fetchone() or db.execute("SELECT 1 FROM research_events WHERE status!='done' LIMIT 1").fetchone():
        raise ValueError('现有草稿或核算队列待处理，拒绝覆盖')
    metadata=json.loads(db.execute('SELECT payload FROM research_meta WHERE id=1').fetchone()[0])
    if metadata.get('erp_import',{}).get('inputs_sha256') == expected_inputs_sha256:
        raise ValueError('本批已导入，拒绝重复执行')
    before=capture(db)
    old={r[0]:(r[1],r[2]) for r in db.execute('SELECT id,revision,formula FROM research_formulas')}
    catalog={c:(mid,unit) for mid,c,unit in db.execute('SELECT id,code,unit FROM procurement_materials WHERE archived_at IS NULL')}
    archived={c:(mid,unit) for mid,c,unit in db.execute('SELECT id,code,unit FROM procurement_materials WHERE archived_at IS NOT NULL')}
    for code,price in inputs['prices'].items():
        if before['prices'].get(code,{}).get('latest_price') != price.get('latest_price'):
            raise ValueError(f'{code} 最新采购价已变动，须重新复算')
    archive.mkdir(parents=True,exist_ok=True)
    for kind,filename,sha,sheet in sources:
        original=candidate/'来源原件'/filename
        if not original.exists():
            original=next((p for p in (candidate/'来源原件').iterdir() if hashlib.sha256(p.read_bytes()).hexdigest()==sha),None)
        if original is None or hashlib.sha256(original.read_bytes()).hexdigest()!=sha:
            raise ValueError(f'原件校验失败: {filename}')
        stored=archive/(sha+original.suffix)
        if stored.exists() and hashlib.sha256(stored.read_bytes()).hexdigest()!=sha:
            raise ValueError('已归档原件冲突')
        if not stored.exists():
            shutil.copy2(original,stored)
        db.execute('INSERT INTO procurement_source_imports(sha256,filename,stored_path,imported_by,imported_at) VALUES(%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING',(sha,filename,str(stored),actor,stamp))
    stock_sha=next(r[2] for r in sources if r[0]=='erp_stock')
    inventory_changes=[]
    for n,(code,unit,qty,erp_price,evidence) in enumerate(materials,1):
        is_new=code not in catalog
        if is_new:
            if code in archived:
                mid,old_unit=archived[code]
                db.execute('UPDATE procurement_materials SET archived_at=NULL,archived_by=NULL,updated_at=%s WHERE id=%s',(stamp,mid))
                catalog[code]=(mid,old_unit)
            else:
                mid=str(uuid4())
                db.execute("INSERT INTO procurement_materials(id,code,name,unit,updated_at) VALUES(%s,%s,%s,%s,%s)",(mid,code,code,unit or 'kg',stamp))
                catalog[code]=(mid,unit or 'kg')
        mid,current_unit=catalog[code]
        if unit and unit != current_unit:
            raise ValueError(f'{code} 单位不同，须核对')
        ev=json.loads(evidence)
        provenance={'source':'ERP 库存','catalog_source':'采购维护' if not is_new else 'ERP 库存' if qty is not None or erp_price is not None else 'ERP BOM',
                    'as_of':'2026-10-07','evidence':ev}
        db.execute('INSERT INTO procurement_material_sources(material_id,sheet,source_row,raw_json,sha256) VALUES(%s,%s,%s,%s,%s)',(mid,'ERP库存汇总',n,packed(['',code,provenance]),stock_sha))
        override=inputs['prices'].get(code,{}).get('inventory_basis')
        review=approved.get('inventory_price_reviews',{}).get(code,{})
        current_price=review['calculation_unit_price'] if review.get('apply_to_current_inventory') is True else erp_price
        old_stock=db.execute('SELECT quantity,price FROM procurement_inventory WHERE material_id=%s',(mid,)).fetchone()
        db.execute('''INSERT INTO procurement_inventory(material_id,quantity,price,raw_price,source_sha256,sheet,source_row,imported_by,imported_at)
            VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT(material_id) DO UPDATE SET quantity=excluded.quantity,price=excluded.price,
            raw_price=excluded.raw_price,source_sha256=excluded.source_sha256,sheet=excluded.sheet,source_row=excluded.source_row,imported_by=excluded.imported_by,imported_at=excluded.imported_at''',
            (mid,qty,current_price,erp_price or '',stock_sha,'ERP库存汇总',n,actor,stamp))
        inventory_changes.append({'code':code,'new_material':is_new and code not in archived,'reactivated':code in archived,'before':old_stock,'quantity':qty,'ERP_inventory_price':erp_price,
                                  'current_inventory_price':current_price,'calculation_inventory_price':inputs['prices'][code]['inventory_price'],'basis':override or 'inventory'})
    overrides={c:{'price':v['inventory_price'],'basis':v['inventory_basis'],'source_sha256':stock_sha}
               for c,v in inputs['prices'].items() if v.get('inventory_basis')}
    metadata.update(erp_inventory_fallback_codes=inputs['package']['erp_inventory_fallback_codes'],inventory_price_overrides=overrides,
                    erp_import={'inputs_sha256':expected_inputs_sha256,'candidate':candidate.name,'imported_at':stamp,'decisions':approved})
    # Keep original metadata recipes and source replay for the historical-trial consumer.
    metadata['materials']=inputs['package']['materials']
    db.execute('UPDATE research_meta SET payload=%s WHERE id=1',(packed(metadata),))
    formulas=[]
    departments = {name:legacy_department(db,name) for name in sorted({r['department'] for r in inputs['package']['recipes'] if r.get('source_kind')=='erp_bom'})}
    for position,recipe in enumerate(inputs['package']['recipes']):
        key=recipe['id']
        if recipe.get('source_kind')!='erp_bom':
            if key not in old or json.loads(old[key][1]) != recipe:
                raise ValueError(f'保留配方已变更: {key}')
            continue
        revision=old[key][0]+1 if key in old else 1
        recipe=dict(recipe,revision=revision,department_id=departments[recipe['department']])
        db.execute('''INSERT INTO research_formulas(id,position,revision,formula) VALUES(%s,%s,%s,%s)
            ON CONFLICT(id) DO UPDATE SET position=excluded.position,revision=excluded.revision,formula=excluded.formula''',(key,position,revision,packed(recipe)))
        db.execute('INSERT INTO research_formula_versions(id,revision,formula,actor,recorded_at) VALUES(%s,%s,%s,%s,%s)',(key,revision,packed(recipe),actor,stamp))
        formulas.append({'code':recipe['name'],'id':key,'action':'新增' if key not in old else 'ERP新版本','revision':revision,'department':recipe.get('department'),'owner':recipe.get('owner'),'yield':recipe['yield']})
    actual=capture(db)
    price_differences=[(c,k,v.get(k),actual['prices'].get(c,{}).get(k)) for c,v in inputs['prices'].items()
                       for k in ('latest_price','inventory_price') if v.get(k)!=actual['prices'].get(c,{}).get(k)]
    if price_differences:
        raise ValueError(f'实库价格与候选不一致: {price_differences[:20]}')
    results=evaluate(actual)
    differences=[(code,policy,cost,results[policy]['recipe:'+code]['cost']) for (code,policy),cost in expected_costs.items() if results[policy]['recipe:'+code]['cost']!=cost]
    if differences:
        raise ValueError(f'实库复算与已确认候选不一致: {differences[:8]}')
    enqueue(db,reason+' · '+candidate.name)
    return {'candidate':candidate.name,'input_sha256':expected_inputs_sha256,'formulas':formulas,'inventory':inventory_changes,
            'dual_cost_checks':len(expected_costs),'new_products':sum(f['action']=='新增' for f in formulas),'updated_products':sum(f['action']!='新增' for f in formulas),
            'preserved_existing':len(inputs['package']['recipes'])-len(formulas),'sources':len(sources)}
