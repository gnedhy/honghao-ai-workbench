"""Pages preserve precise costs, scope and transaction-aware invalidation."""
import pytest
import psycopg
from api.postgres import transaction
from api.research import packed
from tests.test_procurement_rd5 import data, trial_data
from tests.test_research_workbench import ready, K
from tests.test_research_departments import departments, FOREIGN

BASE='/api/workbenches/research/pages/'

def test_versions_rollback_once_per_transaction_and_no_forgery(ready):
    _,client,_,store=ready
    def version():
        with transaction(store.url) as db:
            return db.execute("SELECT version FROM honghao_meta.read_versions WHERE table_name='research_formulas'").fetchone()[0]
    before=version()
    with pytest.raises(ValueError):
        with transaction(store.url,write=True) as db:
            db.execute('UPDATE research_formulas SET revision=revision WHERE id=%s',(K,))
            raise ValueError('rollback')
    assert version()==before
    with transaction(store.url,write=True) as db:
        for _ in range(3): db.execute('UPDATE research_formulas SET revision=revision WHERE id=%s',(K,))
    assert version()==before+1
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        with transaction(store.url,write=True) as db: db.execute('UPDATE honghao_meta.read_versions SET version=0')

@pytest.mark.parametrize('kind', ['products','formulas'])
def test_pages_equal_legacy_without_missing_or_duplicates(ready,kind):
    _,client,_,store=ready
    original=client.get('/api/workbenches/research/'+kind).json()[kind]
    found=[]
    for page in range(1,len(original)+1):
        response=client.get(BASE+kind,params={'page':page,'page_size':1})
        assert response.status_code==200
        payload=response.json();assert payload['total']==len(original)
        found+=payload['items']
        assert client.get(BASE+kind,params={'page':page,'page_size':1},headers={'If-None-Match':response.headers['etag']}).status_code==304
    assert len({row['id'] for row in found})==len(original)
    by_id={row['id']:row for row in original}
    for row in found:
        expected=dict(by_id[row['id']]);expected['lines']=len(expected['lines'])
        assert row==expected
    assert client.get(BASE+kind,params={'page_size':201}).status_code==422
    assert client.get(BASE+kind,params={'search':'no-such-product'}).json()['items']==[]

def test_pages_reauthorize_and_clear_removed_membership(departments):
    _,client,_,store,user,other=departments
    response=client.get(BASE+'products')
    assert [r['id'] for r in response.json()['items']]==[K]
    assert client.get(BASE+'products',params={'search':FOREIGN}).json()['total']==0
    with transaction(store.url,write=True) as db:
        db.execute('DELETE FROM organization_memberships WHERE user_id=%s',(user['id'],))
    revoked=client.get(BASE+'products',headers={'If-None-Match':response.headers['etag']})
    assert revoked.status_code==200 and revoked.json()['items']==[]
    with transaction(store.url,write=True) as db:
        db.execute("DELETE FROM identity_user_scopes WHERE user_id=%s AND scope_id='research'",(user['id'],))
    assert client.get(BASE+'products',headers={'If-None-Match':revoked.headers['etag']}).status_code==403

def test_filters_decimal_sort_and_stable_ties():
    from api.research_pages import page_rows
    rows=[{'id':str(i),'name':f'P-{i}','owner':'A','yield':'1.1','lines':3,'latest_cost':price,'change':{'percent':None},'has_draft':i==1,'status':'ready'} for i,price in [(10,'9007199254740992.01'),(2,'9007199254740992.02'),(1,None)]]
    result=page_rows(rows,kind='products',page=1,page_size=3,sort='latest_cost',asc=False)
    assert [r['id'] for r in result['items']]==['2','10','1']
    assert page_rows(rows,kind='products',page=99,page_size=1,draft='yes')['items'][0]['id']=='1'
    assert page_rows(rows,kind='products',page=1,page_size=3,yield_warning=True)['total']==3


def test_truncate_and_missing_marker_fail_closed(ready,pg_targets):
    _,client,admin,store=ready
    before=client.get(BASE+'products').headers['etag']
    with transaction(pg_targets[1],write=True) as db:
        db.execute('TRUNCATE research_drafts')
    assert client.get(BASE+'products',headers={'If-None-Match':before}).status_code==200
    with pytest.raises(RuntimeError):
        with transaction(pg_targets[1],write=True) as db:
            db.execute("DELETE FROM honghao_meta.read_versions WHERE table_name='research_drafts'")
            # The same connection snapshot exercises fail-closed behavior without leaving a corrupt test schema.
            from api.research import ResearchStore
            ResearchStore(pg_targets[1]).overview_etag(None)

def test_direct_concurrent_writers_each_advance_version(ready):
    from concurrent.futures import ThreadPoolExecutor
    _,_,_,store=ready
    with transaction(store.url) as db:
        before=db.execute("SELECT version FROM honghao_meta.read_versions WHERE table_name='research_formulas'").fetchone()[0]
    def write(_):
        with psycopg.connect(store.url) as db:
            db.execute('UPDATE research_formulas SET revision=revision WHERE id=%s',(K,))
    with ThreadPoolExecutor(max_workers=4) as pool:list(pool.map(write,range(4)))
    with transaction(store.url) as db:
        assert db.execute("SELECT version FROM honghao_meta.read_versions WHERE table_name='research_formulas'").fetchone()[0]==before+4


def test_different_users_in_same_scope_share_page_rebuild(ready,monkeypatch):
    import asyncio
    import time
    import httpx
    from api.identity import IdentityStore
    from api.research import ResearchStore
    from tests.helpers import TEST_ADMIN_PASSWORD
    _,client,admin,store=ready
    identity=IdentityStore(store.url)
    peer=identity.create_user(username='page-peer',display_name='Page peer',department=None,password=TEST_ADMIN_PASSWORD,is_system_admin=True)
    calls=[];original=ResearchStore.listing
    def counted(self,actor=None,histories=None):
        calls.append(actor['id']);time.sleep(.05)
        return original(self,actor,histories)
    monkeypatch.setattr(ResearchStore,'listing',counted)
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=client.app),base_url='http://testserver',cookies=client.cookies) as first, httpx.AsyncClient(transport=httpx.ASGITransport(app=client.app),base_url='http://testserver') as second:
            assert (await second.post('/api/login',json={'username':peer['username'],'password':TEST_ADMIN_PASSWORD})).status_code==200
            responses=await asyncio.gather(*(reader.get(BASE+'products') for reader in [first,second]*4))
            assert all(r.status_code==200 and r.content==responses[0].content for r in responses)
            assert len(calls)==1
    asyncio.run(run())
