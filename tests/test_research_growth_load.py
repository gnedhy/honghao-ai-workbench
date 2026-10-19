"""Real isolated PostgreSQL growth/concurrency acceptance; synthetic data only."""
import asyncio
from copy import deepcopy
from decimal import Decimal
import json
import os
from pathlib import Path
from threading import Lock
import time
from statistics import median
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI, Request
from api.identity import IdentityStore, SESSION_COOKIE_NAME
from api.postgres import transaction
from api.research import ResearchStore, capture, enqueue, packed, digest, create_research_router
from tests.helpers import TEST_ADMIN_PASSWORD
from tests.test_procurement_rd5 import data, trial_data
from tests.test_research_workbench import ready, K
from tests.test_research_departments import departments, FOREIGN


@pytest.mark.parametrize('size',[int(v) for v in os.environ.get('HONGHAO_GROWTH_SIZES','2500,10000').split(',')])
def test_growth_first_read_update_and_concurrent_permissions(departments,size):
    _,_,admin,store,left,right=departments
    identity=IdentityStore(store.url)
    with transaction(store.url) as db:
        assert db.execute('SELECT current_database()').fetchone()[0]=='honghao_test'
        base=json.loads(db.execute('SELECT formula FROM research_formulas WHERE id=%s',(FOREIGN,)).fetchone()[0])
        price=capture(db)['prices']['A']
    stock=Decimal(price['inventory_price'])/Decimal('0.8')
    periods=int(os.environ.get('HONGHAO_GROWTH_PERIODS','3'))
    complex_bom=os.environ.get('HONGHAO_COMPLEX_BOM')=='1'
    users=[left,right]+[identity.create_user(username=f'load-{i}',display_name=f'合成读取{i}',department=('研发一部' if i%2==0 else '研发二部'),password=TEST_ADMIN_PASSWORD,scope_levels={'research':3}) for i in range(6)]
    sessions=[identity.login(u['username'],TEST_ADMIN_PASSWORD,3600) for u in users]
    # Login's session token is kept in memory, never in the receipt.
    assert all(session is not None for session in sessions)
    tokens=[session[1] for session in sessions]
    with transaction(store.url,write=True) as db:
        rows=[]
        if complex_bom:
            for side,person in enumerate((left,right)):
                for depth in range(4):
                    formula=dict(deepcopy(base),id=f'composite:load-{side}-{depth}',name=f'COMPLEX-{side}-{depth}',kind='composite',owner=person['display_name'],department=person['department'],department_id=person['primary_department_id'],**{'yield':'1'})
                    formula['lines']=[{'kind':'material' if depth==0 else 'composite','ref':'A' if depth==0 else f'composite:load-{side}-{depth-1}','code':'A','quantity':'10','source_row':1}, {'kind':'material','ref':'回收2','code':'回收2','price_ref':'A','quantity':'-2.5','source_row':2}]
                    rows.append((formula['id'],1900+side*4+depth,packed(formula)))
        for i in range(size):
            person=left if i%2==0 else right
            formula=dict(deepcopy(base),id=f'recipe:load-{i:05d}',name=f'LOAD-{i:05d}',owner=person['display_name'],department=person['department'],department_id=person['primary_department_id'],**{'yield':'0.8'})
            formula['lines']=[{'kind':'material','ref':'A','code':'A','quantity':'7.5','ratio':'1','source_row':1}]
            if complex_bom:
                formula['lines']=[{'kind':'composite','ref':f'composite:load-{i%2}-3','code':'shared','quantity':'10','source_row':1}, {'kind':'material','ref':'回收2','code':'回收2','price_ref':'A','quantity':'-2.5','source_row':2}]
            rows.append((formula['id'],2000+i,packed(formula)))
        db.cursor().executemany('INSERT INTO research_formulas(id,position,revision,formula) VALUES(%s,%s,1,%s)',rows)
    build_times=[]
    def update(value,process=True):
        started=time.perf_counter()
        with transaction(store.url,write=True) as db:
            db.execute("UPDATE procurement_price_batch_items SET latest_price=%s WHERE code='A' AND batch_id=(SELECT id FROM procurement_price_batches ORDER BY version DESC LIMIT 1)",(value,))
            enqueue(db,'合成扩容压力测试')
        if process: store.process_events()
        if process: build_times.append(round(time.perf_counter()-started,4))
        else: report['enqueue_seconds']=round(time.perf_counter()-started,4)
    for value in range(33-periods,33): update(str(value))
    original=store.listing; builds=[];guard=Lock()
    def counted(actor=None,histories=None):
        with guard:builds.append(actor['id'] if actor else 'internal')
        return original(actor,histories)
    store.listing=counted
    def application():
        app=FastAPI()
        @app.middleware('http')
        async def authenticate(request:Request,call_next):
            request.state.current_user=await asyncio.to_thread(identity.user_for_session,request.cookies.get(SESSION_COOKIE_NAME,''))
            return await call_next(request)
        app.include_router(create_research_router(store,SimpleNamespace(workbench_modes={'research':'active'})))
        return app
    report={'products_added':size,'users':8,'requests_per_wave':16,'history_periods':periods,'bom_depth':5 if complex_bom else 1,'phases':{},'cost_rebuild_seconds':build_times}
    def check(payload,index,expected,overview=False):
        rows=payload['products'] if overview else payload['items']
        for row in rows:
            if row['id'].startswith('recipe:load-'):
                assert int(row['id'].rsplit('-',1)[1])%2==index%2
                assert Decimal(row['latest_cost'])==expected
                assert Decimal(row['inventory_cost'])==stock
        if not overview: assert payload['total']==size//2+(1 if index%2==0 else 2)
        if index%2==0: assert 'SECRET-' not in json.dumps(payload)
    async def run():
        app=application()
        clients=[httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test',cookies={SESSION_COOKIE_NAME:token},timeout=60) for token in tokens]
        async def wave(name,expected,validators=None,overview=False):
            start_builds=len(builds)
            async def one(i):
                start=time.perf_counter()
                response=await clients[i%8].get('/api/workbenches/research/overview?summary=true' if overview else '/api/workbenches/research/pages/products',params=None if overview else {'search':'','page_size':50},headers={'If-None-Match':validators[i%8]} if validators else {})
                elapsed=time.perf_counter()-start
                assert response.status_code==200,response.status_code
                check(response.json(),i%8,expected,overview)
                return elapsed,response
            values=await asyncio.gather(*(one(i) for i in range(4 if overview else 16)))
            times=sorted(v[0] for v in values)
            report['phases'][name]={'seconds':list(map(lambda v:round(v,4),times)),'median':round(median(times),4),'max':round(max(times),4),'over_15s':sum(v>15 for v in times),'bytes_max':max(len(r.content) for _,r in values),'list_builds':len(builds)-start_builds}
            assert len(builds)-start_builds<=2, 'same permission scope rebuilt more than once'
            return [response.headers['etag'] for _,response in values[:8]]
        try:
            tags=await wave('cold_concurrent_pages',Decimal('40'))
            await wave('warm_concurrent_pages',Decimal('40'))
            # The overview cache is still empty; page snapshots use a different cache key.
            await wave('cold_concurrent_overview',Decimal('40'),overview=True)
            await asyncio.to_thread(update,'33',False)
            await wave('pending_concurrent_pages',Decimal('40'))
            worker=asyncio.create_task(asyncio.to_thread(store.process_events))
            observed=[]
            async def during(i):
                response=await clients[i%8].get('/api/workbenches/research/pages/products')
                assert response.status_code==200
                payload=response.json();pending=payload['pending']
                check(payload,i%8,Decimal('40') if pending else Decimal('41.25'))
                assert all(row['status']=='updating' for row in payload['items']) if pending else all(row['status']!='updating' for row in payload['items'])
                observed.append('pending' if pending else 'completed')
            started=time.perf_counter()
            await asyncio.gather(*(during(i) for i in range(16)))
            await worker
            report['update_while_reading_seconds']=round(time.perf_counter()-started,4)
            report['during_update_states']=observed
            tags=await wave('updated_concurrent_pages',Decimal('41.25'),tags)
            start=time.perf_counter()
            unchanged=await asyncio.gather(*(clients[i%8].get('/api/workbenches/research/pages/products',params={'search':'','page_size':50},headers={'If-None-Match':tags[i%8]}) for i in range(16)))
            assert all(r.status_code==304 for r in unchanged)
            report['conditional_wave_seconds']=round(time.perf_counter()-start,4)
            await wave('updated_concurrent_overview',Decimal('41.25'),overview=True)
            admin_user=identity.get_user(admin)
            admin_token=identity.login(admin_user['username'],TEST_ADMIN_PASSWORD,3600)[1]
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test',cookies={SESSION_COOKIE_NAME:admin_token}) as admin_client:
                for endpoint in ('pages/products','overview?summary=true'):
                    started=time.perf_counter();response=await admin_client.get('/api/workbenches/research/'+endpoint)
                    assert response.status_code==200
                    payload=response.json()
                    for row in payload.get('products',payload.get('items',[])):
                        if row['id'].startswith('recipe:load-'):
                            assert Decimal(row['latest_cost'])==Decimal('41.25') and Decimal(row['inventory_cost'])==stock
                    report['phases']['admin_cold_'+endpoint]={'seconds':round(time.perf_counter()-started,4),'bytes':len(response.content)}
            # Withdraw one real session's department after its cache is warm.
            with transaction(store.url,write=True) as db:db.execute('DELETE FROM organization_memberships WHERE user_id=%s',(users[0]['id'],))
            response=await clients[0].get('/api/workbenches/research/pages/products',headers={'If-None-Match':tags[0]})
            assert response.status_code==200 and response.json()['total']==0 and response.json()['items']==[]
            assert (await clients[0].get('/api/workbenches/research/products/'+FOREIGN)).status_code==404
            with transaction(store.url,write=True) as db:db.execute("DELETE FROM identity_user_scopes WHERE user_id=%s AND scope_id='research'",(users[0]['id'],))
            assert (await clients[0].get('/api/workbenches/research/pages/products')).status_code==403
            report['cost_and_scope_checks']='passed'
            with transaction(store.url) as db:
                frozen=[(key,sig,json.loads(raw)['latest_cost'],json.loads(raw)['inventory_cost']) for key,sig,raw in db.execute("SELECT product_id,signature,summary_payload FROM research_cost_records WHERE product_id LIKE 'recipe:load-%%' ORDER BY product_id,sequence")]
            report['frozen_cost_signature_hash']=digest(frozen)
            report['frozen_cost_records']=len(frozen)
        finally:
            await asyncio.gather(*(client.aclose() for client in clients))
            dest=Path(os.environ.get('HONGHAO_GROWTH_OUTPUT','.scratch/growth-load'));dest.mkdir(parents=True,exist_ok=True)
            (dest/f'{size}.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    asyncio.run(run())
