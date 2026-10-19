"""Concurrent readers must not block the event loop or reuse a stale scope."""
import asyncio
from threading import Event, Timer, Lock

import httpx

from api.identity import IdentityStore
from api.postgres import transaction
from tests.test_procurement_rd5 import data, trial_data
from tests.test_research_workbench import ready, K, RH, update_stock
from tests.test_research_departments import departments
from tests.helpers import TEST_ADMIN_PASSWORD


def test_waiting_authentication_does_not_block_public_health(ready, monkeypatch):
    _, client, _, _ = ready
    entered, release = Event(), Event()
    original = IdentityStore.user_for_session

    def blocked(self, token):
        entered.set()
        assert release.wait(5), 'authentication watchdog did not run'
        return original(self, token)

    monkeypatch.setattr(IdentityStore, 'user_for_session', blocked)
    watchdog = Timer(2, release.set)
    watchdog.start()

    async def requests():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=client.app), base_url='http://testserver', cookies=client.cookies) as transport:
            waiting = asyncio.create_task(transport.get('/api/workbenches/research/overview'))
            try:
                assert await asyncio.to_thread(entered.wait, 3)
                health = await transport.get('/api/health')
                assert health.status_code == 200
                assert not release.is_set(), 'database authentication blocked unrelated HTTP requests'
            finally:
                release.set()
                assert (await waiting).status_code == 200

    try:
        asyncio.run(requests())
    finally:
        release.set()
        watchdog.cancel()


def test_parallel_full_reads_share_one_exact_response_for_same_scope(ready, monkeypatch):
    _, client, admin, store = ready
    identity = IdentityStore(store.url)
    owner = identity.get_user(admin)
    peer = identity.create_user(username='concurrent-admin', display_name='Concurrent admin', department=owner['department'], password=TEST_ADMIN_PASSWORD, is_system_admin=True, scope_levels=owner['scope_levels'])
    calls = []
    original = type(store).overview

    def counted(self, actor):
        calls.append(actor['id'])
        return original(self, actor)

    monkeypatch.setattr(type(store), 'overview', counted)

    async def requests():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=client.app), base_url='http://testserver', cookies=client.cookies) as first, httpx.AsyncClient(transport=httpx.ASGITransport(app=client.app), base_url='http://testserver') as second:
            login = await second.post('/api/login', json={'username':peer['username'], 'password':TEST_ADMIN_PASSWORD})
            assert login.status_code == 200
            responses = await asyncio.gather(*(c.get('/api/workbenches/research/overview') for c in [first,second]*4))
            assert all(r.status_code == 200 for r in responses)
            assert all(r.content == responses[0].content for r in responses)
            assert responses[0].json() == original(store, owner)
            assert len(calls) == 1, 'same version/scope must not rebuild the full response for every reader'

    asyncio.run(requests())


def test_detail_calculation_reuse_preserves_precision_and_isolation(ready, monkeypatch, tmp_path):
    import api.research as research
    _, _, _, store = ready
    calls = []
    original = research.evaluate

    def counted(inputs):
        calls.append(True)
        return original(inputs)

    monkeypatch.setattr(research, 'evaluate', counted)
    first = store.detail(K)
    old_cost = first['inventory']['cost']
    first['latest']['cost'] = 'tampered'
    first['inventory']['lines'].clear()
    other = store.detail(RH)
    repeated = store.detail(K)
    assert repeated['latest']['cost'] == repeated['product']['latest_cost']
    assert repeated['inventory']['lines'] and other['product']['id'] == RH
    assert len(calls) == 1, 'unchanged exact inputs must not recalculate the whole graph per product'
    update_stock(ready, tmp_path, 'A', 55)
    store.process_events()
    calls.clear()
    changed = store.detail(K)
    assert changed['inventory']['cost'] != old_cost
    assert changed['inventory']['cost'] == changed['product']['inventory_cost']
    assert len(calls) == 1, 'changed inputs must rebuild the calculation'


def test_reader_waiting_for_rebuild_rechecks_revoked_department(departments, monkeypatch):
    _, client, _, store, user, other = departments
    tag = client.get('/api/workbenches/research/overview').headers['etag']
    # A same-scope rebuild must queue the reader even when other scopes can progress independently.
    other = IdentityStore(store.url).create_user(username='read-peer', display_name='Read peer', department=user['department'], password=TEST_ADMIN_PASSWORD, scope_levels={'research':3})
    entered, release, authenticated = Event(), Event(), Event()
    original_read = type(store).overview
    original_auth = IdentityStore.user_for_session

    def blocked(self, actor):
        if actor['id'] == other['id']:
            entered.set()
            assert release.wait(5)
        return original_read(self, actor)

    def auth(self, token):
        result = original_auth(self, token)
        if result and result['id'] == user['id']:
            authenticated.set()
        return result

    monkeypatch.setattr(type(store), 'overview', blocked)
    monkeypatch.setattr(IdentityStore, 'user_for_session', auth)

    async def requests():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=client.app), base_url='http://testserver', cookies=client.cookies) as victim, httpx.AsyncClient(transport=httpx.ASGITransport(app=client.app), base_url='http://testserver') as blocker:
            assert (await blocker.post('/api/login', json={'username':other['username'],'password':TEST_ADMIN_PASSWORD})).status_code == 200
            first = asyncio.create_task(blocker.get('/api/workbenches/research/overview'))
            second = None
            try:
                assert await asyncio.to_thread(entered.wait, 3)
                second = asyncio.create_task(victim.get('/api/workbenches/research/overview', headers={'If-None-Match':tag}))
                assert await asyncio.to_thread(authenticated.wait, 3)
                with transaction(store.url, write=True) as db:
                    db.execute('DELETE FROM organization_memberships WHERE user_id=%s', (user['id'],))
            finally:
                release.set()
                assert (await first).status_code == 200
                if second:
                    response = await second
                    assert response.status_code == 200
                    assert response.json()['products'] == [] and response.json()['formulas'] == []

    asyncio.run(requests())


def test_unchanged_scope_does_not_wait_for_another_scope_rebuild(departments, monkeypatch):
    _, client, _, store, _, other = departments
    tag = client.get('/api/workbenches/research/overview').headers['etag']
    entered, release = Event(), Event()
    original = type(store).overview
    def blocked(self, actor):
        if actor['id'] == other['id']:
            entered.set()
            assert release.wait(5)
        return original(self, actor)
    monkeypatch.setattr(type(store), 'overview', blocked)
    async def requests():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=client.app), base_url='http://testserver', cookies=client.cookies) as first, httpx.AsyncClient(transport=httpx.ASGITransport(app=client.app), base_url='http://testserver') as second:
            assert (await second.post('/api/login', json={'username':other['username'],'password':TEST_ADMIN_PASSWORD})).status_code == 200
            waiting = asyncio.create_task(second.get('/api/workbenches/research/overview'))
            watchdog = None
            try:
                assert await asyncio.to_thread(entered.wait, 3)
                watchdog = Timer(2, release.set);watchdog.start()
                response = await first.get('/api/workbenches/research/overview', headers={'If-None-Match':tag})
                assert response.status_code == 304 and response.content == b''
                assert not release.is_set(), 'unchanged scope was blocked by another rebuild'
            finally:
                release.set()
                if watchdog:watchdog.cancel()
                assert (await waiting).status_code == 200
    asyncio.run(requests())


def test_queued_detail_uses_current_operation_permissions(departments, monkeypatch):
    _, client, admin, store, user, _ = departments
    entered, release, authenticated = Event(), Event(), Event()
    count, guard = [], Lock()
    original_read, original_auth = type(store).detail, IdentityStore.user_for_session

    def blocked(self, key, actor=None):
        if actor and actor['id'] == admin:
            with guard:
                count.append(True)
                if len(count) == 2: entered.set()
            assert release.wait(5)
        return original_read(self, key, actor)

    def auth(self, token):
        current = original_auth(self, token)
        if current and current['id'] == user['id']: authenticated.set()
        return current

    monkeypatch.setattr(type(store), 'detail', blocked)
    monkeypatch.setattr(IdentityStore, 'user_for_session', auth)

    async def requests():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=client.app), base_url='http://testserver', cookies=client.cookies) as victim, httpx.AsyncClient(transport=httpx.ASGITransport(app=client.app), base_url='http://testserver') as blocker:
            name = IdentityStore(store.url).get_user(admin)['username']
            assert (await blocker.post('/api/login', json={'username':name,'password':TEST_ADMIN_PASSWORD})).status_code == 200
            path = '/api/workbenches/research/products/' + K
            # Different products occupy both read slots; identical requests now coalesce.
            from api.research import digest
            with transaction(store.url) as db:
                keys = [row[0] for row in db.execute('SELECT id FROM research_formulas')]
            second_key = next(key for key in keys if int(digest([admin,key]),16)%64 != int(digest([admin,K]),16)%64)
            blockers = [asyncio.create_task(blocker.get('/api/workbenches/research/products/'+key)) for key in (K,second_key)]
            reader = None
            try:
                assert await asyncio.to_thread(entered.wait, 3)
                reader = asyncio.create_task(victim.get(path))
                assert await asyncio.to_thread(authenticated.wait, 3)
                with transaction(store.url, write=True) as db:
                    db.execute("UPDATE identity_user_scopes SET access_level=2 WHERE user_id=%s AND scope_id='research'", (user['id'],))
            finally:
                release.set()
                assert all(r.status_code == 200 for r in await asyncio.gather(*blockers))
                if reader:
                    response = await reader
                    assert response.status_code == 200
                    assert not response.json()['capabilities']['can_edit']
                    assert not response.json()['capabilities']['can_activate']

    asyncio.run(requests())


def test_parallel_details_build_once_and_return_identical_costs(ready, monkeypatch):
    _, client, _, store = ready
    calls = []
    original = type(store).detail
    def counted(self, key, actor=None):
        calls.append(key)
        return original(self,key,actor)
    monkeypatch.setattr(type(store),'detail',counted)
    async def requests():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=client.app),base_url='http://testserver',cookies=client.cookies) as transport:
            responses=await asyncio.gather(*(transport.get('/api/workbenches/research/products/'+K) for _ in range(8)))
            assert all(r.status_code==200 and r.content==responses[0].content for r in responses)
            assert len(calls)==1
    asyncio.run(requests())
