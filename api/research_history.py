"""Frozen purchase-version replay, kept separate from real research events."""
import json
from copy import deepcopy
from decimal import Decimal


def backfill(db):
    from api.research import capture, evaluate, now, packed, signature, comparison
    if db.execute('SELECT 1 FROM research_backfill_runs').fetchone():
        count = db.execute('SELECT COUNT(DISTINCT purchase_version) FROM research_backfill_records').fetchone()[0]
        return {'status':'unchanged','versions':count}
    if db.execute("SELECT 1 FROM research_events WHERE status!='done'").fetchone():
        raise ValueError('成本更新尚未完成，请完成后再回算')
    frozen = capture(db)
    date = now()
    batches = db.execute('SELECT id,version,price_date,published_at FROM procurement_price_batches ORDER BY version').fetchall()
    if not batches:
        raise ValueError('没有采购价格版本可供回算')
    source_batches = []
    previous = {}
    for batch_id, version, price_date, published_at in batches:
        # Snapshot prices are the already validated formal purchase prices, including explicit zero.
        period = {code:price for code,price in db.execute('SELECT code,latest_price FROM procurement_price_batch_items WHERE batch_id=%s',(batch_id,))}
        source_batches.append({'id':batch_id,'version':version,'price_date':price_date,'published_at':published_at,'prices':period})
        inputs = deepcopy(frozen)
        for code, entry in inputs['prices'].items():
            historical = period.get(code)
            entry.update(latest_price=historical if historical is not None else entry['latest_price'],
                         latest_basis='historical_latest' if historical is not None else 'current_latest_fallback',
                         inventory_basis='current_inventory_fallback')
        results = evaluate(inputs)
        lookup = {r['id']:r for r in inputs['package']['recipes']}
        def dependencies(key, found=None):
            found = set() if found is None else found
            if key not in found:
                found.add(key)
                for line in results['latest'][key]['lines']:
                    if line['kind'] != 'material':
                        dependencies(line['ref'],found)
            return found
        for key, formula in lookup.items():
            left, right = results['latest'][key],results['inventory'][key]
            sig = signature(inputs,results,key,include_basis=False)
            old = previous.get(key)
            change = comparison(left['cost'],old)
            ids = dependencies(key)
            payload = dict(formula, product_id=key, record_type='backfill',purchase_version=version,
                effective_date=(price_date or published_at)[:10], recorded_at=date,event_id=f'backfill:{version}',
                reason=f'采购 V{version} 历史回算（当前配方及补缺价格已冻结）',
                latest_cost=left['cost'],inventory_cost=right['cost'],latest=left,inventory=right,
                change=change,formula=formula,graph=[lookup[k] for k in lookup if k in ids],
                calculations={p:{k:v for k,v in values.items() if k in ids} for p,values in results.items()},
                missing_materials=sorted(set(left['missing_materials']+right['missing_materials'])),
                status='missing' if left['missing_materials'] or right['missing_materials'] else 'ready')
            db.execute('INSERT INTO research_backfill_records(purchase_version,product_id,signature,payload) VALUES(%s,%s,%s,%s)',(version,key,sig,packed(payload)))
            previous[key] = dict(payload,signature=sig)
    db.execute('INSERT INTO research_backfill_runs(id,recorded_at,inputs) VALUES(1,%s,%s)',(date,packed({'current':frozen,'purchase_versions':source_batches})))
    return {'status':'created','versions':len(batches)}


def purchase_periods(db):
    """Read-only recovery for legacy events; validate their frozen prices before assigning a period."""
    periods = {}
    rows = db.execute("""
        SELECT e.id,e.inputs::jsonb->'purchase_period',e.inputs::jsonb->'prices',b.id,b.version,b.price_date,
               (SELECT json_object_agg(code,latest_price) FROM procurement_price_batch_items WHERE batch_id=b.id)
        FROM research_events e LEFT JOIN LATERAL (
            SELECT id,version,price_date FROM procurement_price_batches
            WHERE published_at::timestamptz <= e.recorded_at::timestamptz
            ORDER BY version DESC LIMIT 1
        ) b ON true WHERE e.reason='采购正式价格更新'
    """).fetchall()
    for event_id, frozen_period, prices, batch_id, version, price_date, snapshot in rows:
        if frozen_period and frozen_period.get('price_date'):
            periods[event_id] = frozen_period
        elif batch_id and snapshot and prices and all(
                (value.get('latest_price') is None and snapshot.get(code) is None) or
                (value.get('latest_price') is not None and snapshot.get(code) is not None and
                 Decimal(value['latest_price']) == Decimal(snapshot[code]))
                for code, value in prices.items()):
            periods[event_id] = {'id': batch_id, 'version': version, 'price_date': price_date}
    return periods


def linked_history(db, key, periods=None):
    """Project comparisons without ever editing original payloads or their signatures."""
    from api.research import comparison, comparison_price
    periods = purchase_periods(db) if periods is None else periods
    entries = [json.loads(raw) for raw, in db.execute('SELECT payload FROM research_backfill_records WHERE product_id=%s ORDER BY purchase_version',(key,))]
    for raw, in db.execute('SELECT payload FROM research_cost_records WHERE product_id=%s ORDER BY sequence',(key,)):
        row=json.loads(raw)
        row.update(record_type='formal',effective_date=row['recorded_at'][:10],product_id=key)
        period = periods.get(row['event_id'])
        if period and period.get('price_date'):
            row.update(effective_date=period['price_date'], purchase_version=period['version'])
        entries.append(row)
    previous = None
    basis = None
    rows = []
    for row in entries:
        # Unchanged rounded prices retain the last movement's base; missing prices break the chain.
        current_price = comparison_price(row['latest_cost'])
        if previous is not None and (basis is None or comparison_price(basis['latest_cost']) is None or current_price is None or
                current_price != comparison_price(previous['latest_cost'])):
            basis = previous
        row['change'] = comparison(row['latest_cost'],basis)
        row['comparison_basis'] = None if basis is None else {k:basis.get(k) for k in ('record_type','purchase_version','effective_date','event_id','latest_cost')}
        rows.append(row)
        previous = row
    return list(reversed(rows))


def version_history(db, event_id=None):
    versions = {}
    periods = purchase_periods(db)
    keys = [r[0] for r in db.execute("SELECT DISTINCT product_id FROM research_cost_records UNION SELECT DISTINCT product_id FROM research_backfill_records ORDER BY product_id")]
    for key in keys:
        for row in linked_history(db,key,periods):
            if row['kind'] != 'recipe' or (event_id and row['event_id']!=event_id):
                continue
            eid=row['event_id']
            if eid not in versions:
                versions[eid]={k:row.get(k) for k in ('record_type','purchase_version','effective_date','recorded_at','reason')}
                versions[eid].update(id=eid,products=[])
            if not event_id:
                row={k:v for k,v in row.items() if k not in {'graph','calculations','latest','inventory','formula','lines'}}
            versions[eid]['products'].append(row)
    ordered=sorted(versions.values(),key=lambda r:(r['effective_date'],r['record_type']=='formal',r['recorded_at'],r['purchase_version'] or 0),reverse=True)
    if event_id:
        if not ordered:
            raise KeyError('记录不存在')
        return ordered[0]
    return {'versions':ordered}
