"""Apply a reviewed price/cost reconciliation without changing frozen originals."""
import json
from decimal import Decimal

from api.research import now, packed


def apply(db, plan, costs, actor):
    """Caller holds the business write transaction; every baseline is checked first."""
    if db.execute('SELECT access_level,is_active FROM identity_users WHERE id=%s', (actor,)).fetchone() != (5, 1):
        raise PermissionError('仅限有效系统管理员')
    evidence = packed(plan)
    existing = db.execute('SELECT evidence FROM procurement_reconciliations WHERE id=%s', (plan['id'],)).fetchone()
    if existing:
        if existing[0] != evidence:
            raise ValueError('更正编号已被不同方案使用')
        return {'status': 'unchanged'}
    if db.execute("SELECT 1 FROM research_events WHERE status!='done'").fetchone():
        raise ValueError('请先完成已有成本更新')
    if len({(p['batch_id'],p['material_id']) for p in plan['prices']}) != len(plan['prices']):
        raise ValueError('更正方案存在重复原料期次')
    for p in plan['prices']:
        price = Decimal(p['after'])
        if not price.is_finite() or not 0 <= price < Decimal('1000000000'):
            raise ValueError('行情价格无效')
        row = db.execute('SELECT latest_price FROM procurement_effective_prices WHERE batch_id=%s AND material_id=%s', (p['batch_id'],p['material_id'])).fetchone()
        if row != (p['before'],):
            raise ValueError(f"{p['code']} V{p['version']} 已变化，保留现有数据")
    originals = {
        'formal': {(r[0],r[1]):r[2:] for r in db.execute("SELECT sequence,product_id,signature,encode(sha256(convert_to(payload,'UTF8')),'hex') FROM research_effective_costs WHERE sequence=ANY(%s)",([r[1] for r in costs if r[0]=='formal'],))},
        'backfill': {(r[0],r[1]):r[2:] for r in db.execute("SELECT b.purchase_version,b.product_id,b.signature,encode(sha256(convert_to(b.payload,'UTF8')),'hex') FROM research_effective_backfill b JOIN unnest(%s::integer[],%s::text[]) k(version,product) ON b.purchase_version=k.version AND b.product_id=k.product", ([r[1] for r in costs if r[0]=='backfill'],[r[2] for r in costs if r[0]=='backfill']))},
    }
    seen = set()
    for kind, key, product, old_sig, old_hash, sig, raw in costs:
        if kind == 'supplement':
            frozen = db.execute("SELECT encode(sha256(convert_to(inputs,'UTF8')),'hex') FROM research_events WHERE id=%s AND status='done'",(key,)).fetchone()
            valid = frozen == (old_hash,) and not db.execute('SELECT 1 FROM research_cost_records WHERE event_id=%s AND product_id=%s',(key,product)).fetchone()
        else:
            valid = kind in originals and originals[kind].get((key,product)) == (old_sig,old_hash)
        if not valid or (kind,key,product) in seen:
            raise ValueError('成本记录已变化或更正目标重复，保留现有数据')
        seen.add((kind,key,product))
        value = json.loads(raw)
        if value['id'] != product or value['reconciliation']['id'] != plan['id'] or len(sig) != 64:
            raise ValueError('成本更正证据不匹配')
    db.execute('INSERT INTO procurement_reconciliations(id,source_sha256,source_name,actor,recorded_at,evidence) VALUES(%s,%s,%s,%s,%s,%s)',
               (plan['id'],plan['source_sha256'],plan['source'],actor,now(),evidence))
    with db.cursor().copy('COPY procurement_price_corrections(reconciliation_id,batch_id,material_id,latest_price,price_date,sheet,cell,original_value) FROM STDIN') as copy:
        for p in plan['prices']:
            copy.write_row((plan['id'],p['batch_id'],p['material_id'],p['after'],p['price_date'],p['sheet'],p['cell'],p['original_value']))
    for kind, table, columns in [('formal','research_cost_corrections','sequence'),('backfill','research_backfill_corrections','purchase_version,product_id')]:
        with db.cursor().copy(f'COPY {table}(reconciliation_id,{columns},signature,payload) FROM STDIN') as copy:
            for typ,key,product,old_sig,old_hash,sig,raw in costs:
                if typ == kind:
                    copy.write_row((plan['id'],key,*([product] if kind=='backfill' else []),sig,raw))
    with db.cursor().copy('COPY research_cost_records(event_id,product_id,signature,payload) FROM STDIN') as copy:
        for typ,key,product,old_sig,old_hash,sig,raw in costs:
            if typ=='supplement':copy.write_row((key,product,sig,raw))
    return {'status':'corrected','prices':len(plan['prices']),'formal_costs':sum(r[0]=='formal' for r in costs),'backfill_costs':sum(r[0]=='backfill' for r in costs),'supplemental_costs':sum(r[0]=='supplement' for r in costs)}
