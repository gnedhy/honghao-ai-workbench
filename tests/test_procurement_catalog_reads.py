"""Daily procurement response bounds preserve publication and live authorization."""
import json
from api.postgres import transaction
from api.procurement import ProcurementStore
from api.procurement_catalog_reads import current, bounded
from tests.test_procurement_collaboration import real_data, PREFIX, PASSWORD

def test_procurement_daily_pages_and_options_match_catalog(real_data):
    settings,client,_=real_data
    full=client.get(PREFIX+'/overview?compact=true').json()
    summary=client.get(PREFIX+'/overview?read_mode=summary').json()
    assert summary['materials']==[] and summary['metrics']==full['metrics']
    assert len(summary['batches'])<=2
    assert all(not b['comparison']['items'] for b in summary['batches'])
    result=client.get(PREFIX+'/overview',params={'read_mode':'ledger','page_size':25,'filters':json.dumps({'sort':'code','direction':'ascending'})}).json()
    assert len(result['materials'])==25 and result['read_page']['total']==len(full['materials'])
    page_ids=[]
    for page in range(1,20):
        value=client.get(PREFIX+'/overview',params={'read_mode':'ledger','page_size':25,'page':page,'filters':json.dumps({'sort':'code','direction':'ascending'})}).json()
        for row in value['materials']:
            assert row==next(m for m in full['materials'] if m['id']==row['id'])
            page_ids.append(row['id'])
    assert len(page_ids)==len(set(page_ids))==len(full['materials'])
    options=client.get(PREFIX+'/overview',params={'read_mode':'options','page_size':10,'filters':json.dumps({'start':'2026-08-01','end':'2026-09-08','search':'CF001'})}).json()
    assert len(options['materials'])<=12 and options['read_page']['preferred']
    assert not summary['departments']
    assert len(client.get(PREFIX+'/dashboard-summary?kind=movers&start=2026-08-01&end=2026-09-08').json()['up'])<=30

def test_procurement_current_projection_invalidates_and_revokes(real_data):
    settings,client,users=real_data
    store=ProcurementStore(settings.database_url)
    before=current(store)
    token=client.get(PREFIX+'/overview?read_mode=ledger').json()['read_page']['version']
    mid=before['materials'][0]['id']
    with transaction(settings.database_url,write=True) as db:
        db.execute("UPDATE procurement_materials SET name='Updated label' WHERE id=%s",(mid,))
    assert next(m for m in current(store)['materials'] if m['id']==mid)['name']=='Updated label'
    assert client.get(PREFIX+'/overview',params={'read_mode':'ledger','page':2,'filters':json.dumps({'version':token})}).status_code==409
    client.post('/api/logout');assert client.post('/api/login',json={'username':'buyer0','password':PASSWORD}).status_code==200
    assert client.get(PREFIX+'/overview?read_mode=summary').status_code==200
    with transaction(settings.database_url,write=True) as db:db.execute("DELETE FROM identity_user_scopes WHERE user_id=%s AND scope_id='procurement'",(users[0]['id'],))
    for path in ['/overview?read_mode=summary','/overview?read_mode=ledger','/overview?read_mode=options','/dashboard-summary?start=2026-08-01&end=2026-09-08']:
        assert client.get(PREFIX+path).status_code==403

def test_procurement_queued_reader_rechecks_revoked_scope(real_data,monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event
    from api import procurement_catalog_reads as reads
    settings,client,users=real_data
    client.post('/api/logout');assert client.post('/api/login',json={'username':'buyer0','password':PASSWORD}).status_code==200
    waiting=Event();original=reads.read_slot
    def observed(enabled=True):
        waiting.set()
        return original(enabled)
    with original():
        monkeypatch.setattr(reads,'read_slot',observed)
        pool=ThreadPoolExecutor(max_workers=1)
        future=pool.submit(client.get,PREFIX+'/overview?read_mode=summary')
        assert waiting.wait(10)
        with transaction(settings.database_url,write=True) as db:
            db.execute("DELETE FROM identity_user_scopes WHERE user_id=%s AND scope_id='procurement'",(users[0]['id'],))
    try:assert future.result(timeout=10).status_code==403
    finally:pool.shutdown(wait=True)

def test_procurement_catalog_rejects_nonfinite_sort_values_and_clamps_page():
    from api.procurement_catalog_reads import number
    assert number('9'*400) is None
    assert number('Infinity') is None
    assert number('12.5')==12.5
    result=bounded({'materials':[{'id':'one','code':'A-1','name':'A','published_price':'2'}],'metrics':{},'batches':[],'issues':[]},'ledger',{},999,25)
    assert result['read_page']['page']==1 and len(result['materials'])==1

def test_procurement_catalog_natural_order_matches_shared_ui_collator(real_data):
    settings,_,_=real_data
    codes=sorted(['2','10','A-2','A2','A10','a2','A02','é-2','E-2','水','纯水','A_1','A 1','A/1','A(1)'])
    with transaction(settings.database_url) as db:
        actual=[r[0] for r in db.execute('SELECT code FROM unnest(%s::text[]) item(code) ORDER BY code COLLATE honghao_code_natural,code COLLATE "C"',(codes,))]
    assert actual==['2','10','A 1','A_1','A-2','A(1)','A/1','A02','A2','a2','A10','E-2','é-2','水','纯水']
