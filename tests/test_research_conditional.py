"""Conditional reads retain live authorization, exact costs and MVCC consistency."""
import json

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
