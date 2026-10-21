"""Frozen purchase-version replay, kept separate from real research events."""
import json
from copy import deepcopy
from decimal import Decimal

SUMMARY_PAYLOAD = "summary_payload"
BACKFILL_DETAIL = """(payload::jsonb || COALESCE((
    SELECT frozen.payload::jsonb FROM research_backfill_frozen frozen
    WHERE frozen.id=research_backfill_records.frozen_id
), '{}'::jsonb))::text"""


def save_backfill(db, version, key, signature, payload):
    """Keep each result while sharing only identical, immutable frozen inputs."""
    from api.research import packed
    db.execute('''INSERT INTO research_backfill_records(purchase_version,product_id,signature,payload,frozen_id)
        SELECT %s,%s,%s,(value - ARRAY['formula','graph','source_hashes'])::text,
               research_freeze_backfill(value)
        FROM (SELECT %s::jsonb AS value) input''', (version,key,signature,packed(payload)))


def backfill(db):
    from api.research import capture, evaluate, now, packed, signatures, comparison
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
        signed = signatures(inputs,results,include_basis=False)
        positions = {key:i for i,key in enumerate(lookup)}
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
            sig = signed(key)
            old = previous.get(key)
            change = comparison(left['cost'],old)
            ids = dependencies(key)
            payload = dict(formula, product_id=key, record_type='backfill',purchase_version=version,
                effective_date=(price_date or published_at)[:10], recorded_at=date,event_id=f'backfill:{version}',
                reason=f'采购 V{version} 历史回算（当前配方及补缺价格已冻结）',
                latest_cost=left['cost'],inventory_cost=right['cost'],latest=left,inventory=right,
                change=change,formula=formula,graph=[lookup[k] for k in sorted(ids,key=positions.__getitem__)],
                calculations={p:{k:values[k] for k in ids} for p,values in results.items()},
                missing_materials=sorted(set(left['missing_materials']+right['missing_materials'])),
                status='missing' if left['missing_materials'] or right['missing_materials'] else 'ready')
            save_backfill(db,version,key,sig,payload)
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
    return linked_histories(db,[key],periods).get(key,[])


def linked_histories(db, keys, periods=None, summary=False, series=False):
    """Project comparisons without ever editing original payloads or their signatures."""
    if not keys:
        return {}
    periods = purchase_periods(db) if periods is None else periods
    payload = SUMMARY_PAYLOAD if summary else 'payload'
    entries = {key:[] for key in keys}
    # Historical series need identity/scope and exact costs, not historical input lines.
    slim = f"({payload}::jsonb - ARRAY['latest','inventory','lines'])::text"
    formal_payload = f"CASE WHEN sequence=max(sequence) OVER (PARTITION BY product_id) THEN {payload} ELSE {slim} END" if series else payload
    if series or summary:
        for key,raw in db.execute(f'SELECT product_id,{SUMMARY_PAYLOAD} FROM research_backfill_records WHERE product_id=ANY(%s) ORDER BY purchase_version',(list(keys),)):
            entries[key].append(json.loads(raw))
    else:
        rows=db.execute('SELECT product_id,payload,frozen_id FROM research_backfill_records WHERE product_id=ANY(%s) ORDER BY purchase_version',(list(keys),)).fetchall()
        ids=list({row[2] for row in rows if row[2] is not None})
        frozen={key:json.loads(raw) for key,raw in db.execute('SELECT id,payload FROM research_backfill_frozen WHERE id=ANY(%s)',(ids,))} if ids else {}
        for key,raw,frozen_id in rows:
            row=json.loads(raw)
            if frozen_id is not None:
                row.update(deepcopy(frozen[frozen_id]))
            entries[key].append(row)
    for key,raw in db.execute(f'SELECT product_id,{formal_payload} FROM research_cost_records WHERE product_id=ANY(%s) ORDER BY sequence',(list(keys),)):
        row=json.loads(raw)
        row.update(record_type='formal',effective_date=row['recorded_at'][:10],product_id=key)
        period = periods.get(row['event_id'])
        if period and period.get('price_date'):
            row.update(effective_date=period['price_date'], purchase_version=period['version'])
        entries[key].append(row)
    return {key:_compare_history(rows) for key,rows in entries.items()}


def _compare_history(entries):
    from api.research import comparison, comparison_price
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


def version_history(db, event_id=None, access=None, product_id=None, summary=False, histories=None, series=False):
    versions = {}
    periods = purchase_periods(db) if histories is None else None
    keys = [r[0] for r in db.execute("SELECT DISTINCT product_id FROM research_cost_records UNION SELECT DISTINCT product_id FROM research_backfill_records ORDER BY product_id")]
    visible = access.visible_ids(db) if access else set()
    if access:
        keys = [key for key in keys if key in visible]
    if product_id is not None:
        keys = [key for key in keys if key==product_id]
    histories = histories if histories is not None else linked_histories(db,keys,periods,summary=summary or not event_id)
    for key in keys:
        for row in histories[key]:
            if row['kind'] != 'recipe' or (event_id and row['event_id']!=event_id):
                continue
            if access:
                if not access.allows(row.get('formula',row)):
                    continue
                if summary or not event_id:
                    row={k:v for k,v in row.items() if k not in {"graph","calculations","formula","source_hashes"}}
                if not series:
                    row = access.project(row,visible)
            eid=row['event_id']
            if eid not in versions:
                versions[eid]={k:row.get(k) for k in ('record_type','purchase_version','effective_date','recorded_at','reason')}
                versions[eid].update(id=eid,products=[])
            if series:
                row={k:v for k,v in row.items() if k in {'id','latest_cost','inventory_cost','effective_date','recorded_at','record_type'}}
            elif summary or not event_id:
                row={k:v for k,v in row.items() if k not in {'graph','calculations','latest','inventory','formula','lines','source_hashes'}}
            versions[eid]['products'].append(row)
    ordered=sorted(versions.values(),key=lambda r:(r['effective_date'],r['record_type']=='formal',r['recorded_at'],r['purchase_version'] or 0),reverse=True)
    if event_id:
        if not ordered:
            raise KeyError('记录不存在')
        return ordered[0]
    return {'versions':ordered}
