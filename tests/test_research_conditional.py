"""Conditional reads retain live authorization, exact costs and MVCC consistency."""
import json
import pytest

from api.identity import IdentityStore
from api.postgres import transaction
from api.research import ResearchStore, packed
from tests.helpers import TEST_ADMIN_PASSWORD
from tests.test_procurement_rd5 import data, trial_data
from tests.test_research_workbench import ready, K, records, saved, update_stock
from tests.test_research_departments import departments, FOREIGN

URL = '/api/workbenches/research/overview'


def test_unchanged_overview_skips_full_read_and_keeps_exact_payload(ready, monkeypatch):
    _, client, _, store = ready
    frozen = records(store.url)
    response = client.get(URL)
    assert response.status_code == 200
    assert response.json() == store.overview(IdentityStore(store.url).get_user(ready[2]))
    tag = response.headers['etag']
    assert response.headers['cache-control'] == 'no-store'
    assert response.headers['vary'] == 'Cookie'
    def forbidden(*args):
        raise AssertionError('unchanged polling must not read the full overview')
    monkeypatch.setattr(ResearchStore, 'overview', forbidden)
    repeated = client.get(URL, headers={'If-None-Match': tag})
    assert repeated.status_code == 304 and repeated.content == b''
    assert repeated.headers['etag'] == tag
    assert records(store.url) == frozen


def test_inventory_queue_costs_and_draft_deletion_invalidate(ready, tmp_path):
    _, client, admin, store = ready
    before = client.get(URL)
    frozen = records(store.url)
    update_stock(ready, tmp_path, 'A', 55)
    queued = client.get(URL, headers={'If-None-Match': before.headers['etag']})
    assert queued.status_code == 200 and queued.json()['pending']
    store.process_events()
    after = client.get(URL, headers={'If-None-Match': queued.headers['etag']})
    assert after.status_code == 200 and not after.json()['pending']
    old = next(r for r in before.json()['products'] if r['id'] == K)
    new = next(r for r in after.json()['products'] if r['id'] == K)
    assert new['latest_cost'] == old['latest_cost']
    assert new['inventory_cost'] != old['inventory_cost']
    assert records(store.url)[:len(frozen)] == frozen
    saved(store, admin)
    draft = client.get(URL, headers={'If-None-Match': after.headers['etag']})
    assert draft.status_code == 200
    assert next(r for r in draft.json()['products'] if r['id'] == K)['has_draft']
    with transaction(store.url, write=True) as db:
        db.execute('DELETE FROM research_drafts WHERE id=%s', (K,))
    deleted = client.get(URL, headers={'If-None-Match': draft.headers['etag']})
    assert deleted.status_code == 200
    assert not next(r for r in deleted.json()['products'] if r['id'] == K)['has_draft']


def test_department_and_scope_revocation_never_reuse_old_validator(departments):
    _, client, _, store, user, other = departments
    response = client.get(URL)
    assert [r['id'] for r in response.json()['products']] == [K]
    assert client.get(URL, headers={'If-None-Match': response.headers['etag']}).status_code == 304
    with transaction(store.url, write=True) as db:
        db.execute('DELETE FROM organization_memberships WHERE user_id=%s', (user['id'],))
    revoked = client.get(URL, headers={'If-None-Match': response.headers['etag']})
    assert revoked.status_code == 200 and revoked.json()['products'] == []
    assert client.get('/api/workbenches/research/products/' + FOREIGN).status_code == 404
    with transaction(store.url, write=True) as db:
        db.execute("DELETE FROM identity_user_scopes WHERE user_id=%s AND scope_id='research'", (user['id'],))
    assert client.get(URL, headers={'If-None-Match': revoked.headers['etag']}).status_code == 403
    client.post('/api/logout')
    assert client.get(URL, headers={'If-None-Match': revoked.headers['etag']}).status_code == 401
    assert client.post('/api/login', json={'username': other['username'], 'password': TEST_ADMIN_PASSWORD}).status_code == 200
    changed_user = client.get(URL, headers={'If-None-Match': response.headers['etag']})
    assert changed_user.status_code == 200 and changed_user.headers['etag'] != response.headers['etag']
    assert all(r['id'] != K for r in changed_user.json()['products'])


def test_validator_and_payload_share_snapshot_during_concurrent_commit(ready, monkeypatch):
    _, client, _, store = ready
    before = client.get(URL)
    original = ResearchStore.overview_etag
    def commit_after_validator(self, actor):
        tag = original(self, actor)
        # A separate connection commits while the request's read snapshot remains open.
        from api.postgres import connect
        with connect(store.url) as db, db.transaction():
            raw = db.execute('SELECT formula FROM research_formulas WHERE id=%s', (K,)).fetchone()[0]
            db.execute('UPDATE research_formulas SET formula=%s WHERE id=%s',
                       (packed(dict(json.loads(raw), owner='snapshot-new-owner')), K))
        return tag
    monkeypatch.setattr(ResearchStore, 'overview_etag', commit_after_validator)
    during = client.get(URL)
    assert during.headers['etag'] == before.headers['etag']
    assert during.json() == before.json()
    monkeypatch.setattr(ResearchStore, 'overview_etag', original)
    after = client.get(URL, headers={'If-None-Match': during.headers['etag']})
    assert after.status_code == 200 and after.headers['etag'] != during.headers['etag']
    assert next(r for r in after.json()['formulas'] if r['id'] == K)['owner'] == 'snapshot-new-owner'


def test_material_prices_conditional_inventory_and_permission(ready, monkeypatch, tmp_path):
    _, client, admin, store = ready
    url = '/api/workbenches/research/material-prices'
    before = client.get(url)
    assert before.status_code == 200
    tag = before.headers['etag']
    original = ResearchStore.material_prices
    def forbidden(*args):
        raise AssertionError('unchanged materials must skip full reads')
    monkeypatch.setattr(ResearchStore, 'material_prices', forbidden)
    assert client.get(url, headers={'If-None-Match': tag}).status_code == 304
    monkeypatch.setattr(ResearchStore, 'material_prices', original)
    update_stock(ready, tmp_path, 'A', 55)
    changed = client.get(url, headers={'If-None-Match': tag})
    assert changed.status_code == 200 and changed.headers['etag'] != tag
    assert next(row for row in changed.json()['materials'] if row['code'] == 'A')['inventory_price'] == '55'
    client.post('/api/logout')
    assert client.get(url, headers={'If-None-Match': changed.headers['etag']}).status_code == 401


def test_material_validator_follows_department_and_scope(departments):
    _, client, _, store, user, other = departments
    url = '/api/workbenches/research/material-prices'
    before = client.get(url)
    with transaction(store.url, write=True) as db:
        db.execute('DELETE FROM organization_memberships WHERE user_id=%s', (user['id'],))
    changed = client.get(url, headers={'If-None-Match': before.headers['etag']})
    assert changed.status_code == 200
    assert not any(row['in_formula_scope'] for row in changed.json()['materials'])
    with transaction(store.url, write=True) as db:
        db.execute("DELETE FROM identity_user_scopes WHERE user_id=%s AND scope_id='research'", (user['id'],))
    assert client.get(url, headers={'If-None-Match': changed.headers['etag']}).status_code == 403


def test_detail_cache_and_conditional_read_preserve_exact_result(ready, monkeypatch):
    _, client, _, store = ready
    path = '/api/workbenches/research/products/' + K
    original = client.get(path)
    assert original.status_code == 200
    def forbidden(*args):
        raise AssertionError('unchanged detail must reuse the authorized representation')
    monkeypatch.setattr(ResearchStore, 'detail', forbidden)
    assert client.get(path).json() == original.json()
    unchanged = client.get(path, headers={'If-None-Match': original.headers['etag']})
    assert unchanged.status_code == 304 and unchanged.content == b''


def test_detail_validator_rechecks_department_and_draft(departments):
    _, client, _, store, user, _ = departments
    path = '/api/workbenches/research/products/' + K
    before = client.get(path)
    assert before.status_code == 200
    with transaction(store.url, write=True) as db:
        db.execute('DELETE FROM organization_memberships WHERE user_id=%s', (user['id'],))
    assert client.get(path, headers={'If-None-Match': before.headers['etag']}).status_code == 404
    assert client.get(path).status_code == 404


def test_detail_inventory_change_invalidates_cache(ready, tmp_path):
    _, client, _, store = ready
    path = '/api/workbenches/research/products/' + K
    before = client.get(path)
    update_stock(ready, tmp_path, 'A', 55)
    queued = client.get(path, headers={'If-None-Match': before.headers['etag']})
    assert queued.status_code == 200 and queued.json()['product']['status'] == 'updating'
    store.process_events()
    after = client.get(path, headers={'If-None-Match': queued.headers['etag']})
    assert after.status_code == 200
    assert after.json()['inventory']['cost'] != before.json()['inventory']['cost']
    assert after.json()['latest']['cost'] == before.json()['latest']['cost']


def test_overview_summary_preserves_every_cost_and_separates_validators(ready):
    _, client, _, store = ready
    full = client.get(URL)
    summary = client.get(URL+'?summary=true', headers={'If-None-Match':full.headers['etag']})
    assert summary.status_code == 200 and summary.headers['etag'] != full.headers['etag']
    left, right = full.json(), summary.json()
    assert left['products'] == right['products'] and left['formulas'] == right['formulas']
    fields = {'id','latest_cost','inventory_cost','effective_date','recorded_at','record_type'}
    assert len(left['versions']) == len(right['versions'])
    for original, compact in zip(left['versions'],right['versions']):
        assert {k:v for k,v in original.items() if k!='products'} == {k:v for k,v in compact.items() if k!='products'}
        assert [{k:v for k,v in row.items() if k in fields} for row in original['products']] == compact['products']
    assert client.get(URL+'?summary=true',headers={'If-None-Match':summary.headers['etag']}).status_code == 304
    assert client.get(URL,headers={'If-None-Match':summary.headers['etag']}).status_code == 200


def test_series_matches_full_history_after_updates_and_department_projection(departments):
    from api.research import enqueue, overview_summary, capture, evaluate, signature, signatures
    _,client,_,store,left,right=departments
    store.backfill_history()
    for price in ('20','20','21'):
        with transaction(store.url,write=True) as db:
            db.execute("UPDATE procurement_price_batch_items SET latest_price=%s WHERE code='A'",(price,))
            enqueue(db,'series parity')
        store.process_events()
    for actor in (left,right):
        assert store.overview(actor,series=True)==overview_summary(store.overview(actor))
    with transaction(store.url) as db:
        inputs=capture(db)
    result=evaluate(inputs)
    for include_basis in (False,True):
        shared=signatures(inputs,result,include_basis=include_basis)
        for recipe in reversed(inputs['package']['recipes']):
            assert shared(recipe['id'])==signature(inputs,result,recipe['id'],include_basis=include_basis)


def test_cost_batches_rollback_together_and_retry_without_duplicates(ready,monkeypatch):
    import api.research as research
    _,_,_,store=ready
    before=records(store.url)
    with transaction(store.url,write=True) as db:
        base=json.loads(db.execute('SELECT formula FROM research_formulas WHERE id=%s',(K,)).fetchone()[0])
        for i in range(201):
            formula=dict(base,id=f'recipe:batch-{i}',name=f'BATCH-{i}')
            db.execute('INSERT INTO research_formulas(id,position,revision,formula) VALUES(%s,%s,1,%s)',(formula['id'],2000+i,packed(formula)))
        research.enqueue(db,'batch rollback')
    def fail_last(value):
        if value.get('id')=='recipe:batch-200' and 'event_id' in value:
            raise ValueError('synthetic serialization failure after first batch')
        return packed(value)
    with monkeypatch.context() as patch:
        patch.setattr(research,'packed',fail_last)
        with pytest.raises(ValueError,match='synthetic serialization'):
            store.process_events()
    assert records(store.url)==before
    assert store.process_events()==1
    assert len(records(store.url))==len(before)+201
    assert store.process_events()==0
