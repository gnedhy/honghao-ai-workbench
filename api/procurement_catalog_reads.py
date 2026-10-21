"""Versioned current procurement projection and bounded daily consumers."""
from copy import deepcopy
from contextlib import nullcontext
from functools import cmp_to_key
from threading import RLock
import re
import math
import hashlib
from api.postgres import transaction
_cache={}
_lock=RLock()
def read_slot(enabled=True):
    return _lock if enabled else nullcontext()

def current(store):
    # Acquire before the first snapshot query so queued readers recheck live versions.
    with _lock:
        with transaction(store.url) as db:
            version=tuple(db.execute("SELECT table_name,version FROM honghao_meta.read_versions WHERE table_name LIKE 'procurement%%' OR table_name IN ('identity_users','identity_user_scopes','organization_memberships','organization_departments') ORDER BY table_name").fetchall())
            old=_cache.get(store.url)
            if old is None or old[0]!=version:
                value=store.overview(compact=True)
                value["read_version"]=hashlib.sha256(repr(version).encode()).hexdigest()
                value["code_order"]={mid:rank for rank,(mid,) in enumerate(db.execute('SELECT id FROM procurement_materials ORDER BY code COLLATE honghao_code_natural,code COLLATE "C"'))}
                if len(_cache)>3:_cache.clear()
                _cache[store.url]=(version,value)
            return deepcopy(_cache[store.url][1])
def daily(m):
    pattern=r'(?:^|[（(【\[])\s*(?:(?:此)?品号不用|不用|不再使用|停用|已停用|已停|作废|已作废|弃用|废弃|勿用)\s*(?:[）)】\]]|$)'
    return not re.search(pattern,m['code']) and not re.search(pattern,m.get('name',''))
def code_key(value):return [(0,int(p)) if p.isdigit() else (1,p.lower()) for p in re.split(r'(\d+)',value)]
def number(value):
    try:
        parsed=float(value) if value is not None and re.fullmatch(r'\d+(\.\d+)?',str(value).strip()) else None
        return parsed if parsed is not None and math.isfinite(parsed) else None
    except (ValueError,OverflowError):return None
def bounded(result,mode,filters,page,size):
    from fastapi import HTTPException
    version=result.pop("read_version",None)
    if filters.get("version") and filters["version"]!=version:raise HTTPException(status_code=409,detail="台账已更新，请从第一页重新读取。")
    code_order=result.pop("code_order",{})
    all_rows=[m for m in result['materials'] if daily(m)]
    result['metrics']['material_count']=len(all_rows)
    current=result.get('current_update');inputs={m['material_id']:m for m in (current or {}).get('input_items',[])}
    issues=(current or {}).get('issues',[])
    comparison=result.get('ledger_comparison') or (result['batches'][0].get('comparison') if result['batches'] else {}) or {}
    def change(m):
        entry=comparison.get('items',{}).get(m['id'])
        if entry:return None if entry.get('change') is None else entry['change']*100
        latest,previous=number(m.get('published_price')),number(m.get('previous_published_price'))
        return None if latest is None or previous is None else (0 if latest==previous else None) if previous==0 else (latest-previous)/abs(previous)*100
    def match(m):
        mid=m['id'];movement=filters.get('movement','all');scope=filters.get('scope','all');editor=filters.get('editor','')
        delta=change(m);missing=m.get('published_price') is None and comparison.get('items',{}).get(mid,{}).get('kind')!='incomparable'
        if filters.get('search','').strip().lower() not in (m['code']+' '+m['name']).lower():return False
        if filters.get('source','all')!='all' and (m.get('inventory_source') or {}).get('catalog_source','采购维护')!=filters['source']:return False
        if movement!='all' and not {'up':delta is not None and delta>0,'down':delta is not None and delta<0,'flat':delta==0,'missing':missing,'incomparable':not missing and delta is None}.get(movement,False):return False
        if current and scope!='all' and not {'involved':mid in inputs,'missing':any(i['material_id']==mid and i['kind']=='missing_price' and i['status']=='open' for i in issues),'risk':any(i['material_id']==mid and i['kind']=='price_spike' and i['status']=='open' for i in issues)}.get(scope,False):return False
        if editor:
            round_only=bool(current and scope!='all');people=m.get('round_participants' if round_only else 'participants',[])
            person=next((p['name'] for p in result.get('editors',[]) if p['id']==editor),'')
            if not any(p['id']==editor for p in people) and (round_only or not person or person not in m.get('source_purchasers',[])):return False
        return True
    rows=list(filter(match,all_rows));sort=filters.get('sort','change');ascending=filters.get('direction')=='ascending'
    def value(m):
        if sort=='price_date':return m.get('published_price_date') or None
        if sort=='change':
            item=inputs.get(m['id'])
            if item:
                latest,previous=number(item.get('draft_price')),number(m.get('published_price'))
                return None if latest is None or previous is None else (0 if latest==previous else None) if previous==0 else (latest-previous)/abs(previous)*100
            return change(m)
        key={'previous_latest_price':'previous_published_price','latest_price':'published_price'}.get(sort,sort)
        return number(inputs.get(m['id'],{}).get('draft_price')) if sort=='draft_price' else number(m.get(key))
    def compare(a,b):
        pending=int(b['id'] in inputs)-int(a['id'] in inputs)
        if pending and mode!='options':return pending
        left=code_order.get(a['id']);right=code_order.get(b['id'])
        code=(left>right)-(left<right) if left is not None and right is not None else (code_key(a['code'])>code_key(b['code']))-(code_key(a['code'])<code_key(b['code']))
        if sort=='code' or mode=='options':return code if ascending or mode=='options' else -code
        av,bv=value(a),value(b)
        if av is None or bv is None:return code if av==bv else 1 if av is None else -1
        diff=(av>bv)-(av<bv)
        return (diff if ascending else -diff) or code
    rows.sort(key=cmp_to_key(compare));total=len(rows)
    page=min(page,max(1,math.ceil(total/size)))
    if mode=='summary':rows=[]
    else:rows=rows[(page-1)*size:page*size]
    if mode=='options':
        preferred=filters.get('preferred','')
        remembered=filters.get('remembered','')
        extra=[m for m in all_rows if m['id'] in {preferred,remembered}]
        rows=list({m['id']:m for m in [*rows,*extra]}.values())
    ids={m['id'] for m in rows}
    result['materials']=rows
    result['read_page']={'total':total,'scope_total':len(all_rows),'page':page,'page_size':size,'mode':mode,'version':version,'task_counts':{'involved':len(inputs),'missing':len({i['material_id'] for i in issues if i['kind']=='missing_price' and i['status']=='open'}),'risk':len({i['material_id'] for i in issues if i['kind']=='price_spike' and i['status']=='open'})}}
    for key in ('ledger_comparison',):
        if result.get(key):result[key]['items']={k:v for k,v in result[key].get('items',{}).items() if k in ids}
    for batch in result['batches']:
        if batch.get('comparison'):batch['comparison']['items']={k:v for k,v in batch['comparison'].get('items',{}).items() if k in ids}
    result['issues']=[i for i in result['issues'] if i['material_id'] in ids]
    for key in ('current_update','scheduled_update'):
        update=result.get(key)
        if update:
            for field in ('items','input_items','issues'):
                if field in update:update[field]=[item for item in update[field] if item.get('material_id') in ids]
    result['departments']=[]
    return result

def movers(store,start,end):
    from api.procurement_reads import series
    records={}
    allowed={m['id'] for m in current(store)['materials'] if daily(m)}
    for b in series(store.url,start=start,end=end,boundaries=True)['batches']:
        for item in b['items']:
            if item['material_id'] not in allowed:continue
            source=b['snapshot_sources'].get(item['material_id'])
            value=number(item.get('latest_price'))
            if value is None or (source and source.get('price_kind')!='number'):continue
            day=(source or {}).get('price_date') or b.get('price_date') or b['published_at']
            rows=records.setdefault(item['material_id'],[])
            carried=next((x for x in rows if x['date']==day and x['value']==value),None)
            if carried:
                if b.get('price_date')==day:carried.update(batchId=b['id'],version=b['version'])
            else:rows.append(dict(batchId=b['id'],version=b['version'],date=day,item=item,value=value))
    rows=[]
    for mid,history in records.items():
        history.sort(key=lambda r:(r['date'],r['version']),reverse=True)
        latest=history[0];prior=next((r for r in history if r['date'][:10]<=start),None)
        if prior and prior['value'] and latest['value']!=prior['value']:
            rows.append(dict(**latest,materialId=mid,previous=prior['item']['latest_price'],previousDate=prior['date'],changePercent=(latest['value']-prior['value'])/prior['value']*100))
    rows.sort(key=lambda r:(-abs(r['changePercent']),r['item']['code']))
    up=[r for r in rows if r['changePercent']>0];down=[r for r in rows if r['changePercent']<0]
    return dict(up=up[:30],down=down[:30],up_total=len(up),down_total=len(down))

def distribution(store,start,end):
    from api.procurement_reads import batch_page
    selected=batch_page(store,start=start,end=end)['items']
    selected.sort(key=lambda b:((b.get('price_date') or b['published_at']),b['version']),reverse=True)
    latest=next((b for b in selected if (b.get('price_date') or b['published_at'])[:10]<=end),None)
    previous=next((b for b in selected if (b.get('price_date') or b['published_at'])[:10]<=start),None)
    if latest is None:return None
    latest=store.get_batch(latest['id']);previous=store.get_batch(previous['id']) if previous else None
    prior={m['material_id']:m for m in previous['items']} if previous else {}
    counts=dict(rising=0,falling=0,stable=0,first=0,unavailable=0,incomparable=0);surge=0
    for item in latest['items']:
        if not daily(item):continue
        value=number(item.get('latest_price'));before=number(prior.get(item['material_id'],{}).get('latest_price'))
        if value is None:counts['unavailable']+=1
        elif before is None:counts['first']+=1
        elif value==before:counts['stable']+=1
        elif before==0:counts['incomparable']+=1
        else:
            change=(value-before)/before*100
            counts['rising' if change>0 else 'falling']+=1
            if change>=10:surge+=1
    return dict(counts=counts,surge=surge,comparable=counts['rising']+counts['falling']+counts['stable'])
