"""Synthetic isolated sales growth probe; creates and drops only its own hh_inc_sales_* DB."""
import argparse,json,statistics,time,uuid,sys
from copy import deepcopy
from datetime import date,timedelta
from pathlib import Path
from urllib.parse import quote
import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo,conninfo_to_dict
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from api.postgres import _migration_files,transaction
from api.sales import SalesStore
from api.sales_reads import overview,catalog,page,record,series
from api.sales_calculator import CalculatorStore

def run(credentials,output):
    config=json.loads((credentials/'cluster.json').read_text(encoding='utf-8-sig'))
    profiles=json.loads((credentials/'databases.json').read_text(encoding='utf-8-sig'))
    assert config['host']=='127.0.0.1'
    admin=make_conninfo(**{k:config[k] for k in ('host','port','user','password','dbname')})
    params=conninfo_to_dict(profiles['test']['migration']['url']);name='hh_inc_sales_'+uuid.uuid4().hex[:10];params['dbname']=name
    url=f"postgresql://{quote(params['user'])}:{quote(params['password'])}@127.0.0.1:{params['port']}/{name}"
    result={'database':name,'synthetic':True,'product_count':100,'batch_count':10,'items_per_trial':10,'frozen_cost':'8.1234567890123456789012345678','stages':[]}
    actor={'id':'owner','scope_levels':{'sales':2}}
    store=SalesStore(url);calculator=CalculatorStore(store);cost=result['frozen_cost']
    def packed(v):return json.dumps(v,ensure_ascii=False,separators=(',',':'),default=str)
    def item(i):return {'product_id':f'research:recipe:{i}','product':{'code':f'P-{i}','source':'research'},'cost':cost,'final_price':'12.34','parameters':{'allocation':'.3'},'result':{'normal_price':'12.34'},'evidence':[{'ref':f'CF{j}','quantity':str(j+1),'unit_cost':cost} for j in range(30)],'adopted':True,'voided':False}
    def measure():
        readers={'overview':lambda:overview(store,actor,'2020-01-01','2030-01-01','domestic_direct'),'catalog':lambda:catalog(store,actor,page_size=50),'history':lambda:page(store,actor,'records',product='research:recipe:0',page_size=10),'timeline':lambda:page(store,actor,'timeline',batch='b0',page_size=10),'detail':lambda:record(store,actor,'records','r0-0'),'saved':lambda:calculator.saved_page(actor,page_size=10,kind='workspace')}
        values={}
        for key,read in readers.items():
            times=[]
            for _ in range(5):
                start=time.perf_counter();data=read();times.append(time.perf_counter()-start)
            rows=data.get('items',data.get('products',data.get('saved',[])))
            values[key]={'first_s':times[0],'p50_s':statistics.median(times),'max_s':max(times),'rows':len(rows),'bytes':len(packed(data).encode())}
            if key in ('history','timeline','saved'):assert len(rows)<=10
            if key=='catalog':assert len(rows)<=50 and all(p['latest_cost']==cost for p in rows)
            if key=='detail':assert data['item']==item(0)
            if key=='saved':assert all('panels' not in r['payload'] for r in rows)
        return values
    with psycopg.connect(admin,autocommit=True) as db:db.execute(sql.SQL('CREATE DATABASE {} OWNER honghao_test_migration').format(sql.Identifier(name)))
    try:
        with psycopg.connect(make_conninfo(**params)) as db:
            db.execute('CREATE SCHEMA honghao_meta')
            for _,_,_,content in _migration_files():db.execute(content)
            db.execute("INSERT INTO identity_users(id,username,display_name,password_salt,password_hash,is_active,created_at) VALUES('owner','owner','Owner','x','x',1,'2026-01-01')")
            for i in range(100):
                formula={'id':f'recipe:{i}','name':f'P-{i}','kind':'recipe','revision':1,'department':'研发一部','lines':[],'yield':'1'}
                db.execute("INSERT INTO research_formulas(id,formula,lifecycle,position,revision) VALUES(%s,%s,'active',%s,1)",(formula['id'],packed(formula),i))
                db.execute('INSERT INTO research_cost_records(event_id,product_id,signature,payload) VALUES(%s,%s,%s,%s)',(f'event{i}',formula['id'],str(i),packed({'latest_cost':cost,'inventory_cost':'9','status':'ready'})))
            for b in range(10):
                batch={'id':f'b{b}','revision':1,'mode':'domestic_direct','customer_name':f'客户{b}','name':'增长测试','items':[item(i) for i in range(b*10,(b+1)*10)],'created_at':'2020-01-01','updated_at':'2020-01-01'}
                db.execute('INSERT INTO sales_batches(id,owner_id,revision,payload,created_at,updated_at) VALUES(%s,%s,1,%s,%s,%s)',(batch['id'],'owner',packed(batch),'2020-01-01','2020-01-01'))
        previous=0
        for periods in (26,130,520):
            start=time.perf_counter()
            with transaction(url,write=True) as db:
                for period in range(previous,periods):
                    day=(date(2020,1,1)+timedelta(days=period)).isoformat()+'T00:00:00Z'
                    for i in range(100):
                        row={'id':f'r{period}-{i}','batch_id':f'b{i//10}','product_id':f'research:recipe:{i}','mode':'domestic_direct','version':period+1,'created_at':day,'item':item(i)}
                        db.execute("INSERT INTO sales_records(id,batch_id,product_id,version,status,actor_id,created_at,payload) VALUES(%s,%s,%s,%s,'superseded','owner',%s,%s)",(row['id'],row['batch_id'],row['product_id'],row['version'],day,packed(row)))
                    for b in range(10):
                        trial={'id':f't{period}-{b}','batch_id':f'b{b}','created_at':day,'items':[item(i) for i in range(b*10,(b+1)*10)]}
                        db.execute('INSERT INTO sales_trials(id,batch_id,actor_id,created_at,payload) VALUES(%s,%s,%s,%s,%s)',(trial['id'],trial['batch_id'],'owner',day,packed(trial)))
                    saved={'id':f's{period}','name':'保存测算','kind':'workspace','payload':{'source':{'cost':cost},'panels':[{'steps':item(0)['evidence']} for _ in range(10)]}}
                    db.execute("INSERT INTO sales_calculator_saved(id,owner_id,kind,name,revision,payload,created_at,updated_at) VALUES(%s,'owner','workspace','保存测算',1,%s,%s,%s)",(saved['id'],packed(saved['payload']),day,day))
            write_s=time.perf_counter()-start;previous=periods
            with transaction(url) as db:db.execute('ANALYZE sales_records');db.execute('ANALYZE sales_trials');db.execute('ANALYZE sales_activity')
            stage={'periods':periods,'records':periods*100,'trials':periods*10,'write_s':write_s,'reads':measure()};result['stages'].append(stage);print(packed(stage),flush=True)
        with transaction(url) as db:
            result['history_plan']=db.execute("EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT r.summary_payload::jsonb,r.status,u.display_name,b.summary_payload::jsonb->>'customer_code' FROM sales_records r JOIN sales_batches b ON b.id=r.batch_id JOIN identity_users u ON u.id=r.actor_id WHERE b.owner_id='owner' AND r.product_id='research:recipe:0' ORDER BY r.created_at DESC,r.id DESC LIMIT 10").fetchone()[0]
        before=page(store,actor,'records',page_size=10)
        start=time.perf_counter()
        with transaction(url,write=True) as db:db.execute("UPDATE sales_records SET status='void' WHERE id='r0-0'")
        result['old_status_write_s']=time.perf_counter()-start;start=time.perf_counter();after=page(store,actor,'records',page=2,page_size=10,token=before['version']);result['update_reread_s']=time.perf_counter()-start
        assert after['reset'] and after['page']==1
        assert record(store,actor,'records','r0-0')['item']==item(0)
        assert page(store,dict(actor,id='outsider'),'records')['total']==0
        try:page(store,dict(actor,scope_levels={}),'records');raise AssertionError('revoked scope accepted')
        except PermissionError:pass
        assert len(series(store,actor,'research:recipe:0','2020-01-01','2020-01-26','domestic_direct')['records'])==26
        before_append=page(store,actor,'records',product='research:recipe:0',page_size=10)
        start=time.perf_counter()
        with transaction(url,write=True) as db:
            value=record(store,actor,'records','r0-0');value.update(id='appended',version=521,created_at='2026-10-21T00:00:00Z')
            db.execute("INSERT INTO sales_records(id,batch_id,product_id,version,status,actor_id,created_at,payload) VALUES('appended','b0','research:recipe:0',521,'active','owner',%s,%s)",(value['created_at'],packed(value)))
        result['append_write_s']=time.perf_counter()-start;start=time.perf_counter()
        appended=page(store,actor,'records',page=2,page_size=10,product='research:recipe:0',token=before_append['version'])
        result['append_reread_s']=time.perf_counter()-start
        assert appended['reset'] and appended['page']==1 and appended['total']==521 and appended['items'][0]['id']=='appended'
        assert record(store,actor,'records','appended')['item']==item(0)
        result['assertions']={'exact_frozen_item':True,'exact_decimal_cost':True,'old_status_resets_page':True,'owner_isolation':True,'scope_revoke':True,'bounded_range':True,'append_resets_page':True}
        Path(output).write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    finally:
        with psycopg.connect(admin,autocommit=True) as db:db.execute(sql.SQL('DROP DATABASE {} WITH(FORCE)').format(sql.Identifier(name)))
    return result
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--credentials-dir',type=Path,required=True);parser.add_argument('--output',required=True);args=parser.parse_args();run(args.credentials_dir,args.output)
