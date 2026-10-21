"""Isolated growth probe. Requires an explicitly selected disposable hh_inc_* clone."""
import argparse
import json
import os
import statistics
import time
from datetime import date,timedelta
from pathlib import Path
from urllib.parse import urlsplit

from api.postgres import transaction
from api.research import ResearchStore,packed
from api.research_history import save_backfill
from api.research_reads import history_page,ledger_page


def run(url,key):
    assert urlsplit(url).hostname=='127.0.0.1' and urlsplit(url).path.lstrip('/').startswith(('hh_inc_','hh_incremental_')), 'Only a disposable hh_inc_* clone is allowed'
    store=ResearchStore(url)
    with transaction(url) as db:
        original=db.execute('SELECT payload,signature FROM research_cost_records WHERE product_id=%s ORDER BY sequence DESC LIMIT 1',(key,)).fetchone()
        assert original, 'Choose a product with a frozen formal calculation'
        sample=json.loads(original[0])
        first=history_page(db,key,None)
        maximum=first['max_date']
        base=db.execute('SELECT COALESCE(max(purchase_version),0)+100000 FROM research_backfill_records').fetchone()[0]
    result={'product_id':key,'baseline_history':first['total'],'stages':[]}
    query=dict(kind='products',page=1,page_size=50,search='',owner='',department='',status='',draft='',movement='',yield_warning=False,sort='name',asc=True)
    inserted=[]
    def measure():
        values={}
        for name,reader in [('history',lambda db:history_page(db,key,None,page_size=10)),('trend',lambda db:history_page(db,key,None,start=(date.fromisoformat(maximum)-timedelta(days=30)).isoformat(),end=maximum,trend=True)),('ledger',lambda db:ledger_page(db,None,query))]:
            durations=[]
            for _ in range(5):
                start=time.perf_counter()
                with transaction(url) as db: payload=reader(db)
                durations.append(time.perf_counter()-start)
            values[name]={'first_s':durations[0],'p50_s':statistics.median(durations),'max_s':max(durations),'returned':len(payload.get('items',[]))}
            assert values[name]['returned'] <= (50 if name=='ledger' else 2000 if name=='trend' else 10)
        return values
    try:
        result['baseline']=measure()
        for target in (130,520):
            started=time.perf_counter()
            with transaction(url,write=True) as db:
                while first['total']+len(inserted)<target:
                    index=len(inserted);version=base+index
                    row=dict(sample,event_id=f'backfill:{version}',record_type='backfill',product_id=key,purchase_version=version,effective_date=(date(2000,1,1)+timedelta(days=index)).isoformat(),reason='ISOLATED-INCREMENTAL-GROWTH')
                    save_backfill(db,version,key,original[1],row)
                    inserted.append(version)
            stage={'periods':target,'write_s':time.perf_counter()-started,'reads':measure()}
            with transaction(url) as db:
                page=history_page(db,key,None,start='2000-01-01',end='2002-01-01',page_size=200)
                assert all(row['latest_cost']==sample['latest_cost'] and row['inventory_cost']==sample['inventory_cost'] for row in page['items'])
            result['stages'].append(stage)
            print(json.dumps(stage),flush=True)
        with transaction(url) as db: before=history_page(db,key,None)['version']
        started=time.perf_counter()
        with transaction(url,write=True) as db:
            raw=db.execute('SELECT payload FROM research_backfill_records WHERE product_id=%s AND purchase_version=%s',(key,inserted[0])).fetchone()[0]
            changed=json.loads(raw);changed['effective_date']='1999-12-01'
            db.execute('UPDATE research_backfill_records SET payload=%s WHERE product_id=%s AND purchase_version=%s',(packed(changed),key,inserted[0]))
        result['old_period_update_s']=time.perf_counter()-started
        started=time.perf_counter()
        with transaction(url) as db:
            after=history_page(db,key,None,start='1999-12-01',end='1999-12-01')
            assert after['version']!=before and after['total']==1
            assert after['items'][0]['latest_cost']==sample['latest_cost']
        result['update_reread_s']=time.perf_counter()-started
        version=base+len(inserted)
        new_date=(date.fromisoformat(maximum)+timedelta(days=1)).isoformat()
        started=time.perf_counter()
        with transaction(url,write=True) as db:
            row=dict(sample,event_id=f'backfill:{version}',record_type='backfill',product_id=key,purchase_version=version,effective_date=new_date,reason='ISOLATED-INCREMENTAL-GROWTH')
            save_backfill(db,version,key,original[1],row)
            inserted.append(version)
        result['new_period_write_s']=time.perf_counter()-started
        started=time.perf_counter()
        with transaction(url) as db:
            reread=history_page(db,key,None,start=new_date,end=new_date,trend=True)
            assert reread['total']==1 and reread['items'][0]['latest_cost']==sample['latest_cost']
        result['new_period_reread_s']=time.perf_counter()-started
        return result
    finally:
        with transaction(url,write=True) as db:
            db.execute("DELETE FROM research_backfill_records WHERE product_id=%s AND purchase_version=ANY(%s) AND payload::jsonb->>'reason'='ISOLATED-INCREMENTAL-GROWTH'",(key,inserted))


def product_growth(url,key):
    """Clone a real BOM and frozen result without replacing original business rows."""
    import uuid
    from api.research_dashboard import overview, options
    assert urlsplit(url).hostname=='127.0.0.1' and urlsplit(url).path.lstrip('/').startswith(('hh_inc_','hh_incremental_'))
    marker='isolated-growth-'+uuid.uuid4().hex+'-'
    with transaction(url) as db:
        count=db.execute("SELECT count(*) FROM research_formulas WHERE lifecycle='active' AND formula::jsonb->>'kind'='recipe'").fetchone()[0]
        formula=json.loads(db.execute('SELECT formula FROM research_formulas WHERE id=%s',(key,)).fetchone()[0])
        frozen=db.execute('SELECT event_id,signature,payload FROM research_cost_records WHERE product_id=%s ORDER BY sequence DESC LIMIT 1',(key,)).fetchone()
        assert frozen
        sample=json.loads(frozen[2])
        maximum=history_page(db,key,None)['max_date']
        minimum=(date.fromisoformat(maximum)-timedelta(days=90)).isoformat()
        position=db.execute('SELECT COALESCE(max(position),0)+1 FROM research_formulas').fetchone()[0]
    query=dict(kind='products',page=1,page_size=50,search='',owner='',department='',status='',draft='',movement='',yield_warning=False,sort='name',asc=True)
    result={'baseline_products':count,'stages':[]}
    created=[]
    def replace(value,ident):
        if isinstance(value,dict): return {ident if k==key else k:replace(v,ident) for k,v in value.items()}
        if isinstance(value,list): return [replace(v,ident) for v in value]
        return ident if value==key else value
    def measure():
        results={}
        readers={'ledger':lambda db:ledger_page(db,None,query),'dashboard':lambda db:overview(db,None),'options':lambda db:options(db,None,'',minimum,maximum,key,1),'single_history':lambda db:history_page(db,key,None,page_size=10)}
        for name,reader in readers.items():
            times=[]
            for _ in range(3):
                started=time.perf_counter()
                with transaction(url) as db: value=reader(db)
                times.append(time.perf_counter()-started)
            results[name]={'first_s':times[0],'p50_s':statistics.median(times),'bytes':len(json.dumps(value).encode())}
            if name in ('ledger','options','single_history'):
                results[name]['returned']=len(value.get('items',[]))
                assert results[name]['returned'] <= (10 if name=='single_history' else 50)
        return results
    try:
        result['baseline']=measure()
        for target in sorted(set([max(count*2,5000),max(count*2,10000)])):
            started=time.perf_counter()
            while count+len(created)<target:
                batch=[]
                for _ in range(min(200,target-count-len(created))):
                    ident=marker+str(len(created));created.append(ident)
                    f=replace(formula,ident);f['name']='ISOLATED-GROWTH-'+str(len(created))
                    payload=replace(sample,ident);payload['name']=f['name'];payload['reason']='ISOLATED-PRODUCT-GROWTH'
                    batch.append((ident,f,payload))
                with transaction(url,write=True) as db:
                    for index,(ident,f,payload) in enumerate(batch):
                        db.execute('INSERT INTO research_formulas(id,position,revision,formula) VALUES(%s,%s,1,%s)',(ident,position+len(created)-len(batch)+index,packed(f)))
                    values=','.join(['(%s,%s,%s,%s)']*len(batch))
                    db.execute('INSERT INTO research_cost_records(event_id,product_id,signature,payload) VALUES '+values,[v for ident,f,payload in batch for v in (frozen[0],ident,frozen[1],packed(payload))])
            stage={'products':target,'insert_s':time.perf_counter()-started,'reads':measure()}
            with transaction(url) as db:
                clone=history_page(db,created[-1],None,page_size=10)['items'][0]
                assert clone['latest_cost']==sample['latest_cost'] and clone['inventory_cost']==sample['inventory_cost']
            result['stages'].append(stage)
            print(json.dumps(stage),flush=True)
        return result
    finally:
        with transaction(url,write=True) as db:
            db.execute('DELETE FROM research_cost_records WHERE product_id=ANY(%s)',(created,))
            db.execute('DELETE FROM research_history_versions WHERE product_id=ANY(%s)',(created,))
            db.execute('DELETE FROM research_formulas WHERE id=ANY(%s)',(created,))


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--product',required=True);parser.add_argument('--output',required=True);parser.add_argument('--product-growth-only',action='store_true')
    args=parser.parse_args()
    result=(product_growth if args.product_growth_only else run)(os.environ['HONGHAO_INCREMENTAL_DATABASE_URL'],args.product)
    Path(args.output).write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
