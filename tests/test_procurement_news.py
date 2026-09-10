import asyncio
import json
from datetime import timedelta
from unittest.mock import patch
from api.procurement_news import NewsStore, combine, market_highlights, now, INTERVAL
from tests.test_procurement_workbench import procurement_settings
from tests.helpers import authenticated_client
from api.identity import IdentityStore

def row(title='化工公告', url='https://www.100ppi.com/news/detail-20260910-123.html', date=None):
    return {'title':title,'url':url,'date':date or now().strftime('%Y-%m-%d %H:%M')}

def test_retention_failure_and_pagination(tmp_path):
    store=NewsStore(tmp_path)
    rows=[row(url=f'https://www.100ppi.com/news/detail-20260910-{i}.html',title=f'化工{i}') for i in range(25)]
    store.accept([{'name':'生意社','rows':rows,'error':None}])
    assert len(store.listing()['items'])==20
    assert len(store.listing(page=2)['items'])==5
    assert len(store.listing('market')['items'])==10
    assert store.listing('market')['total']==10
    store.accept([{'name':'生意社','rows':[],'error':'Timeout'}])
    assert store.listing()['total']==25
    assert store.listing()['delayed']
    store.accept([{'name':'生意社','rows':[rows[0]],'error':None}])
    assert store.listing()['total']==25
    assert NewsStore(tmp_path).listing()['total']==25
    with patch('api.procurement_news.now',return_value=now()+timedelta(days=31)):
        assert store.listing()['total']==0

def test_duplicate_entries_and_date_precision(tmp_path):
    item={'source':'生意社','title':'a','url':'a','published_at':now().date().isoformat()}
    assert len(combine([item],[{**item,'url':'b'}],now()))==1
    assert len(combine([{**item,'published_at':item['published_at']+'T09:00'}],[{**item,'url':'b','published_at':item['published_at']+'T10:00'}],now()))==1
    store=NewsStore(tmp_path)
    store.accept([{'name':'商务部','rows':[row(url='https://trb.mofcom.gov.cn/a/art_abc.html',date=now().date().isoformat())],'error':None}])
    assert store.listing('market')['total']==0
    assert 'T' not in store.listing('商务部')['items'][0]['published_at']

def test_market_highlights_balance_pages_without_duplicates():
    def items(count, source):
        return [{'source':source,'url':f'{source}/{i}','published_at':f'2026-09-10T{20-i:02}:00'} for i in range(count)]
    for a,b in [(12,12),(12,2),(2,12),(12,0),(0,3),(3,4)]:
        rows=sorted(items(a,'生意社')+items(b,'隆众资讯'),key=lambda i:(i['published_at'],i['url']),reverse=True)
        selected=market_highlights(rows)
        assert len(selected)==min(10,a+b)
        assert len({i['url'] for i in selected})==len(selected)
        for page in [selected[:5],selected[5:]]:
            assert page==sorted(page,key=lambda i:(i['published_at'],i['url']),reverse=True)
            if a>=2 and b>=2 and len(page)>=2: assert len({i['source'] for i in page})==2
    balanced=market_highlights(sorted(items(12,'生意社')+items(12,'隆众资讯'),key=lambda i:(i['published_at'],i['url']),reverse=True))
    assert sum(i['source']=='生意社' for i in balanced[:5])==3
    assert sum(i['source']=='生意社' for i in balanced[5:])==2
    # One source can be a whole day older; reserve both sources for page 2 when possible.
    uneven=items(3,'生意社')+[{**i,'published_at':i['published_at'].replace('09-10','09-09')} for i in items(4,'隆众资讯')]
    selected=market_highlights(uneven)
    assert len(selected[:5])==5
    assert {i['source'] for i in selected[5:]}=={'生意社','隆众资讯'}

def test_hourly_due_and_no_overlap(tmp_path):
    store=NewsStore(tmp_path)
    assert store.delay()==0
    store.accept([])
    assert 3590 < store.delay() <= INTERVAL
    with patch('api.procurement_news.now',return_value=now()+timedelta(hours=1,seconds=1)):
        assert store.delay()==0
    async def check():
        async with store.lock:
            await store.refresh()
        assert store.process is None
    asyncio.run(check())

def test_malformed_cache_is_nonfatal(tmp_path):
    store=NewsStore(tmp_path)
    store.path.parent.mkdir(parents=True)
    for payload in [[], {'sources':{}}, {'sources':{'生意社':{'last_success':'bad','items':[]}}}, {'sources':{'生意社':{'last_success':'2026-09-10T10:00','items':[]}}}, {'checked_at':'bad','sources':{'生意社':{'items':[{}]}}}]:
        store.path.write_text(json.dumps(payload),encoding='utf-8')
        loaded=NewsStore(tmp_path)
        assert loaded.delay()==0
        assert loaded.listing()['total']==0

def test_discarded_source_cache_does_not_postpone_startup_collection(tmp_path):
    store = NewsStore(tmp_path)
    store.path.parent.mkdir(parents=True)
    checked = now().isoformat()
    for sources in [{}, {'生意社': {'last_success': 'bad', 'items': []}},
                    {'生意社': {'last_success': checked, 'items': [{}]}}]:
        store.path.write_text(json.dumps({'checked_at': checked, 'sources': sources}), encoding='utf-8')
        loaded = NewsStore(tmp_path)
        assert loaded.cache['sources'] == {}
        assert loaded.delay() == 0

    store.accept([{'name': '生意社', 'rows': [row()]}])
    assert 3590 < NewsStore(tmp_path).delay() <= INTERVAL
    store.accept([{'name': '生意社', 'error': 'CollectionFailed'}])
    assert 3590 < NewsStore(tmp_path).delay() <= INTERVAL
    assert NewsStore(tmp_path).listing()['total'] == 1


def test_missing_browser_runtime_retains_cache(tmp_path):
    store=NewsStore(tmp_path)
    store.accept([{'name':'生意社','rows':[row()]}])
    with patch('api.procurement_news.shutil.which',return_value=None): asyncio.run(store.refresh())
    assert store.listing()['total']==1
    assert store.listing()['delayed']

def test_scheduler_fires_again_after_hour(tmp_path):
    store=NewsStore(tmp_path)
    clock=now()
    waits=[]
    calls=[]
    async def sleep(seconds):
        nonlocal clock
        waits.append(seconds)
        clock+=timedelta(seconds=seconds)
    async def refresh():
        calls.append(clock)
        store.accept([])
        if len(calls)==2: raise asyncio.CancelledError
    with patch('api.procurement_news.now',side_effect=lambda:clock), patch('api.procurement_news.asyncio.sleep',sleep), patch.object(store,'refresh',refresh):
        try: asyncio.run(store.run())
        except asyncio.CancelledError: pass
    assert waits==[0,3600]
    assert calls[1]-calls[0]==timedelta(hours=1)

def test_news_authorization_and_validation(tmp_path):
    settings=procurement_settings(tmp_path)
    async def idle(self): await asyncio.Event().wait()
    with patch.object(NewsStore,'run',idle):
        with authenticated_client(settings) as client:
            assert client.get('/api/workbenches/procurement/news').status_code==200
            assert client.get('/api/workbenches/procurement/news?source=unknown').status_code==422
            assert client.get('/api/workbenches/procurement/news?page=0').status_code==422
            client.post('/api/logout')
            assert client.get('/api/workbenches/procurement/news').status_code==401
            identities=IdentityStore(settings.database_path)
            for username, scopes, expected in [('outside',{},403),('viewer1',{'procurement':2},200),('viewer2',{'procurement':2},200)]:
                identities.create_user(username=username,display_name=username,department=None,password='News-Test-Password-2026',scope_levels=scopes)
                assert client.post('/api/login',json={'username':username,'password':'News-Test-Password-2026'}).status_code==200
                assert client.get('/api/workbenches/procurement/news').status_code==expected
                client.post('/api/logout')
