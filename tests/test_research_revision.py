"""Acceptance of frozen research back-calculation and formula lifecycle changes."""
import copy
import json
import sqlite3
from decimal import Decimal
from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient

from api.identity import IdentityStore
from api.main import create_app
from api.research import ResearchStore
from tests.test_procurement_isolation import confirm_risks, import_prices, publish
from tests.test_procurement_rd5 import data, trial_data, table_rows
from tests.test_research_workbench import ready, K, RH, PREFIX, records, saved, update_stock


def managed(store, key):
    return next(row for row in store.formulas()['formulas'] if row['id'] == key)


def new_body(store, name):
    return {'name': name, 'owner': store.formulas()['owners'][0]}


def editable(store, key):
    detail = store.detail(key)
    formula = detail['draft']['formula'] if detail['draft'] else next(r for r in detail['recipes'] if r['id'] == key)
    return {'formula': dict(copy.deepcopy(formula), adjustment_reason='配方优化', adjustment_note=''), 'draft_revision': detail['draft_revision']}


def populated(store, key):
    body = editable(store, key)
    body['formula']['yield'] = '0.98'
    body['formula']['lines'] = [
        {'kind': 'material', 'ref': 'A', 'quantity': '10'},
        {'kind': 'material', 'ref': '纯水', 'quantity': '10'},
        {'kind': 'material', 'ref': '纯水', 'quantity': '10'},
    ]
    return body


def test_existing_formulas_migrate_without_changing_purchase_or_formal_payloads(ready):
    settings, _, _, store = ready
    purchases, costs = table_rows(store.path), records(store.path)
    # Reconstruct the deployed v1 table shape around the original formal data.
    with sqlite3.connect(store.path) as db:
        db.execute('ALTER TABLE research_formulas DROP COLUMN lifecycle')
        db.execute("UPDATE schema_metadata SET value='1' WHERE key='workbench_research_schema_version'")
    store.initialize()
    restarted = ResearchStore(settings.database_path)
    restarted.initialize()
    assert table_rows(store.path) == purchases
    assert records(store.path) == costs
    assert {row['id'] for row in restarted.formulas()['formulas']} == {K, RH}
    assert all(row['lifecycle'] == 'active' for row in restarted.formulas()['formulas'])
    with sqlite3.connect(store.path) as db:
        assert str(db.execute("SELECT value FROM schema_metadata WHERE key='workbench_research_schema_version'").fetchone()[0]) == '2'


def test_created_formula_stays_out_of_ledger_and_history_until_activation(ready):
    settings, _, actor, store = ready
    purchase_before, before = table_rows(store.path), records(store.path)
    existing = store.listing()
    created = store.create_formula(new_body(store, 'NEW-研发配方'), actor)
    key = created['id']
    assert managed(store, key)['lifecycle'] == 'draft'
    assert editable(store, key)['formula']['lines'] == []
    assert store.listing() == existing
    assert records(store.path) == before
    body = populated(store, key)
    trial, receipt = saved(store, actor, body, key)
    assert Decimal(trial['latest']['cost']) == pytest.approx(Decimal(300) / 30 / Decimal('.98'))
    listed_draft = managed(store, key)
    assert Decimal(listed_draft['yield']) == Decimal('.98')
    assert len(listed_draft['lines']) == 3
    assert store.listing() == existing
    reopened = ResearchStore(settings.database_path)
    reopened.initialize()
    assert len(reopened.detail(key)['draft']['formula']['lines']) == 3
    reopened.activate(key, receipt, actor)
    reopened.process_events()
    assert key in {p['id'] for p in reopened.listing()['products']}
    assert managed(reopened, key)['lifecycle'] == 'active'
    assert len(reopened.detail(key)['history']) == 1
    assert records(store.path)[:len(before)] == before
    assert table_rows(store.path) == purchase_before


def test_abandoning_unactivated_formula_creates_no_formal_record(ready):
    _, _, actor, store = ready
    before = records(store.path)
    created = store.create_formula(new_body(store, 'NEW-待放弃'), actor)
    key = created['id']
    saved(store, actor, populated(store, key), key)
    draft = store.detail(key)['draft']
    store.discard(key, draft['revision'])
    assert key not in {p['id'] for p in store.listing()['products']}
    assert records(store.path) == before
    assert key not in {p['id'] for period in store.history()['versions'] for p in period['products']}


@pytest.mark.parametrize('name', ['', '   ', 'K172-C'])
def test_invalid_or_duplicate_product_names_do_not_create_drafts(ready, name):
    _, _, actor, store = ready
    before = store.formulas()
    with pytest.raises((ValueError, RuntimeError)):
        store.create_formula(new_body(store, name), actor)
    assert store.formulas() == before


def test_effective_upstream_reference_prevents_deactivation(ready):
    _, _, actor, store = ready
    before = store.detail(K)
    with pytest.raises((ValueError, RuntimeError), match='引用|使用'):
        store.deactivate(K, {'revision': before['product']['revision']}, actor)
    assert store.detail(K) == before
    assert managed(store, K)['lifecycle'] == 'active'


def test_inactive_formula_can_restore_original_id_without_changing_old_history(ready):
    settings, _, actor, store = ready
    before = records(store.path)
    revision = store.detail(RH)['product']['revision']
    store.deactivate(RH, {'revision': revision}, actor)
    assert RH not in {p['id'] for p in store.listing()['products']}
    assert managed(store, RH)['lifecycle'] == 'inactive'
    assert records(store.path) == before
    assert RH not in {p['id'] for p in store.detail(K)['options']['recipes']}
    reopened = ResearchStore(settings.database_path)
    reopened.initialize()
    body = editable(reopened, RH)
    body['formula']['yield'] = '0.85'
    _, receipt = saved(reopened, actor, body, RH)
    assert RH not in {p['id'] for p in reopened.listing()['products']}
    reopened.activate(RH, receipt, actor)
    reopened.process_events()
    assert managed(reopened, RH)['lifecycle'] == 'active'
    assert [p['id'] for p in reopened.listing()['products']].count(RH) == 1
    assert len(reopened.detail(RH)['history']) == 2
    assert records(store.path)[:len(before)] == before


def test_deactivation_checks_current_formal_revision(ready):
    _, _, actor, store = ready
    current = store.detail(RH)['product']['revision']
    with pytest.raises(RuntimeError):
        store.deactivate(RH, {'revision': current + 1}, actor)
    assert managed(store, RH)['lifecycle'] == 'active'


def test_new_and_inactive_formulas_are_not_available_as_active_references(ready):
    _, _, actor, store = ready
    created = store.create_formula(new_body(store, 'NEW-不可引用'), actor)
    body = editable(store, K)
    body['formula']['lines'][0].update(kind='recipe', ref=created['id'])
    with pytest.raises(ValueError):
        store.simulate(K, body)
    store.deactivate(RH, {'revision': store.detail(RH)['product']['revision']}, actor)
    body['formula']['lines'][0].update(kind='recipe', ref=RH)
    with pytest.raises(ValueError):
        store.simulate(K, body)


@pytest.mark.parametrize('scope,level,view,create,stop', [
    ('research', 2, 200, 403, 403), ('research', 3, 200, 200, 403),
    ('research', 4, 200, 200, 200), ('procurement', 4, 403, 403, 403),
])
def test_formula_management_http_permissions(ready, scope, level, view, create, stop):
    settings, _, _, store = ready
    IdentityStore(settings.database_path).create_user(username='revision-user', display_name='配方负责人',
        department='研发五部', password='Revision-Password-2026', scope_levels={scope: level})
    with TestClient(create_app(settings)) as client:
        assert client.post('/api/login', json={'username': 'revision-user', 'password': 'Revision-Password-2026'}).status_code == 200
        assert client.get(PREFIX + '/formulas').status_code == view
        response = client.post(PREFIX + '/formulas', json=new_body(store, 'NEW-HTTP'))
        assert response.status_code == create, response.text
        response = client.post(PREFIX + '/products/' + quote(RH, safe='') + '/deactivate',
            json={'revision': store.detail(RH)['product']['revision']})
        assert response.status_code == stop, response.text


def backfill_payloads(store):
    with sqlite3.connect(store.path) as db:
        return [json.loads(row[0]) for row in db.execute('SELECT payload FROM research_backfill_records ORDER BY rowid')]


def test_backfill_freezes_each_purchase_period_with_explicit_price_basis(ready):
    _, _, _, store = ready
    purchases, formal = table_rows(store.path), records(store.path)
    result = store.backfill_history()
    assert result == {'versions': 2, 'status': 'created'}
    payloads = backfill_payloads(store)
    products = [r for r in payloads if r['kind'] == 'recipe']
    assert len(products) == 4
    assert {r['id'] for r in products} == {K, RH}
    assert {r['purchase_version'] for r in products} == {1, 2}
    assert all(r['record_type'] == 'backfill' and r['recorded_at'] and r['effective_date'] for r in products)
    first = next(r for r in products if r['id'] == K and r['purchase_version'] == 1)
    lines = {r['code']: r for r in first['latest']['lines']}
    assert lines['A']['basis'] == 'historical_latest'
    assert lines['A']['unit_cost'] == '30'
    assert lines['B']['basis'] == 'current_inventory_fallback'
    assert lines['B']['unit_cost'] == '8'
    composite = next(r for r in payloads if r['kind'] == 'composite' and r['purchase_version'] == 1)
    assert composite['latest']['lines'][0]['basis'] == 'current_latest_fallback'
    assert composite['latest']['lines'][0]['unit_cost'] == '12.9'
    assert table_rows(store.path) == purchases
    assert records(store.path) == formal
    assert len(store.trials()['recipes']) == 3
    # The two fixture purchase periods have identical effective costs. The view
    # can now compare them even though the original baseline payload stays first.
    assert all(row['change']['percent'] == 0 for row in store.listing()['products'])
    assert all(json.loads(row[-1])['change']['percent'] is None for row in formal)


def test_backfill_is_idempotent_and_keeps_frozen_reference_prices_after_updates(ready):
    settings, client, _, store = ready
    store.backfill_history()
    before, formal = backfill_payloads(store), records(store.path)
    old_latest = store.detail(K)['product']['latest_cost']
    assert store.backfill_history() == {'versions': 2, 'status': 'unchanged'}
    update = import_prices(client, '2026-09-12', [('A', 33)])
    confirm_risks(client, update)
    assert publish(client, update).status_code == 200
    store.process_events()
    reopened = ResearchStore(settings.database_path)
    reopened.initialize()
    assert reopened.backfill_history() == {'versions': 2, 'status': 'unchanged'}
    assert backfill_payloads(reopened) == before
    assert records(store.path)[:len(formal)] == formal
    history = reopened.detail(K)['history']
    assert len([r for r in history if r.get('record_type') == 'backfill']) == 2
    assert Decimal(reopened.detail(K)['product']['latest_cost']) > Decimal(old_latest)


def test_last_movement_comparison_is_retained_in_every_research_view(ready):
    _, client, _, store = ready
    with sqlite3.connect(store.path) as db:
        db.execute("UPDATE procurement_price_batch_items SET latest_price='20' WHERE code='A' AND batch_id=(SELECT id FROM procurement_price_batches WHERE version=1)")
    # A third published period carries the same prices as period two.
    assert publish(client, import_prices(client, '2026-09-12', [('A', 30)])).status_code == 200
    store.process_events()
    purchases, formal = table_rows(store.path), records(store.path)
    store.backfill_history()
    frozen = backfill_payloads(store)
    for key in (K, RH):
        history = store.detail(key)['history']
        replay = {r['purchase_version']: r for r in history if r['record_type'] == 'backfill'}
        assert replay[2]['change']['percent'] > 0
        assert replay[3]['change'] == replay[2]['change']
        assert replay[3]['comparison_basis']['purchase_version'] == 1
        assert history[0]['change'] == replay[2]['change']
        assert history[0]['comparison_basis']['purchase_version'] == 1
        assert next(r for r in store.listing()['products'] if r['id'] == key)['change'] == history[0]['change']
        # The overview/list and every version summary/detail use the same projection.
        for version in store.history()['versions']:
            row = next(r for r in version['products'] if r['id'] == key)
            detail = next(r for r in store.history(version['id'])['products'] if r['id'] == key)
            assert row['change'] == detail['change']
            assert row['comparison_basis'] == detail['comparison_basis']
    assert table_rows(store.path) == purchases
    assert records(store.path) == formal
    assert backfill_payloads(store) == frozen


@pytest.mark.parametrize('costs,expected,bases', [
    (['10', '12', '12'], [None, 20, 20], [None, 1, 1]),
    (['10', '10.004', '12', '12.004', '10'], [None, 0, 20, 20, -100/6], [None, 1, 2, 2, 4]),
    (['10', None, '12', '12'], [None, None, None, 0], [None, 1, 2, 3]),
    (['10', '0', '12', '12'], [None, -100, None, None], [None, 1, 2, 2]),
    (['1.004', '1.005', '1.014'], [None, 1, 1], [None, 1, 1]),
])
def test_last_distinct_rounded_price_and_missing_zero_boundaries(costs, expected, bases):
    from api.research_history import linked_history
    with sqlite3.connect(':memory:') as db:
        db.execute('CREATE TABLE research_backfill_records(product_id,purchase_version,payload)')
        db.execute('CREATE TABLE research_cost_records(product_id,sequence,payload)')
        for version, cost in enumerate(costs, 1):
            row = {'latest_cost': cost, 'purchase_version': version, 'record_type': 'backfill', 'event_id': f'backfill:{version}'}
            db.execute('INSERT INTO research_backfill_records VALUES(?,?,?)', ('P', version, json.dumps(row)))
        rows = list(reversed(linked_history(db, 'P')))
        assert [r['change']['percent'] for r in rows] == pytest.approx(expected)
        assert [r['comparison_basis']['purchase_version'] if r['comparison_basis'] else None for r in rows] == bases


def test_backfill_does_not_silently_turn_unpriced_material_into_zero(ready):
    _, _, _, store = ready
    with sqlite3.connect(store.path) as db:
        db.execute("UPDATE procurement_inventory SET price=NULL WHERE material_id=(SELECT id FROM procurement_materials WHERE code='B')")
    purchases, formal = table_rows(store.path), records(store.path)
    store.backfill_history()
    for record in backfill_payloads(store):
        if record['id'] in {K, RH}:
            assert record['latest_cost'] is None
            assert record['inventory_cost'] is None
            assert 'B' in record['missing_materials']
    assert table_rows(store.path) == purchases
    assert records(store.path) == formal


def test_backfilled_formula_and_costs_stay_frozen_after_formula_activation(ready):
    _, _, actor, store = ready
    store.backfill_history()
    before, formal = backfill_payloads(store), records(store.path)
    body = editable(store, K)
    body['formula']['yield'] = '0.99'
    _, receipt = saved(store, actor, body, K)
    store.activate(K, receipt, actor)
    store.process_events()
    assert backfill_payloads(store) == before
    assert records(store.path)[:len(formal)] == formal
    assert store.backfill_history()['status'] == 'unchanged'


def test_unrelated_purchase_after_backfill_does_not_rewrite_formal_history(ready):
    _, client, _, store = ready
    store.backfill_history()
    before = records(store.path)
    replay_before = backfill_payloads(store)
    assert publish(client, import_prices(client, '2026-09-12', [('UNRELATED', 8)])).status_code == 200
    assert store.process_events() == 1
    assert records(store.path) == before
    assert backfill_payloads(store) == replay_before


@pytest.mark.parametrize('first', ['deactivation', 'activation'])
def test_reference_activation_and_target_deactivation_cannot_leave_dangling_active_reference(ready, first):
    _, _, actor, store = ready
    created = store.create_formula(new_body(store, 'NEW-引用原产品'), actor)
    key = created['id']
    body = editable(store, key)
    body['formula']['lines'] = [{'kind': 'recipe', 'ref': RH, 'quantity': '10'}]
    _, receipt = saved(store, actor, body, key)
    preserved_draft = copy.deepcopy(store.detail(key)['draft'])
    target_revision = store.detail(RH)['product']['revision']
    if first == 'deactivation':
        store.deactivate(RH, {'revision': target_revision}, actor)
        resave = {'formula': preserved_draft['formula'], 'draft_revision': receipt['revision'],
                  'simulation_token': receipt['simulation_token']}
        with pytest.raises((ValueError, RuntimeError), match='失效|变化'):
            store.save(key, resave, actor)
        with pytest.raises((ValueError, RuntimeError), match='失效|变化'):
            store.activate(key, receipt, actor)
        assert store.detail(key)['draft'] == preserved_draft
        assert managed(store, key)['lifecycle'] == 'draft'
        assert managed(store, RH)['lifecycle'] == 'inactive'
    else:
        store.activate(key, receipt, actor)
        with pytest.raises(ValueError, match='引用'):
            store.deactivate(RH, {'revision': target_revision}, actor)
        assert managed(store, key)['lifecycle'] == managed(store, RH)['lifecycle'] == 'active'
    store.process_events()
    with sqlite3.connect(store.path) as db:
        active = {key: json.loads(raw) for key, raw in db.execute("SELECT id,formula FROM research_formulas WHERE lifecycle='active'")}
    assert all(line['ref'] in active for formula in active.values() for line in formula['lines'] if line['kind'] != 'material')


def test_equal_new_latest_price_updates_live_basis_without_resetting_cost_history(ready, tmp_path):
    _, client, _, store = ready
    update_stock(ready, tmp_path, 'B', 10)
    store.process_events()
    previous = copy.deepcopy(store.detail(K))
    old_line = next(line for line in previous['latest']['lines'] if line['code'] == 'B')
    assert old_line['unit_cost'] == '10' and old_line['basis'] == 'inventory'
    before = records(store.path)
    assert publish(client, import_prices(client, '2026-09-12', [('B', 10)])).status_code == 200
    store.process_events()
    current = store.detail(K)
    assert records(store.path) == before
    assert current['product']['latest_cost'] == previous['product']['latest_cost']
    assert current['product']['inventory_cost'] == previous['product']['inventory_cost']
    assert current['product']['change'] == previous['product']['change']
    live_line = next(line for line in current['latest']['lines'] if line['code'] == 'B')
    assert live_line['unit_cost'] == '10' and live_line['basis'] == 'latest'
    assert next(line for line in current['inventory']['lines'] if line['code'] == 'B')['basis'] == 'inventory'


def test_saved_draft_can_be_resimulated_and_restored_after_own_product_is_deactivated(ready):
    _, _, actor, store = ready
    body = editable(store, RH)
    body['formula']['yield'] = '0.85'
    _, old_receipt = saved(store, actor, body, RH)
    preserved = copy.deepcopy(store.detail(RH)['draft']['formula'])
    before = records(store.path)
    store.deactivate(RH, {'revision': store.detail(RH)['product']['revision']}, actor)
    inactive = store.detail(RH)
    assert inactive['draft']['formula'] == preserved
    assert inactive['draft']['revision'] == inactive['draft_revision'] > old_receipt['revision']
    assert inactive['draft']['simulation_token'] == ''
    with pytest.raises(RuntimeError, match='变化'):
        store.activate(RH, old_receipt, actor)
    _, receipt = saved(store, actor, editable(store, RH), RH)
    store.activate(RH, receipt, actor)
    store.process_events()
    restored = store.detail(RH)
    assert managed(store, RH)['lifecycle'] == 'active'
    assert restored['draft'] is None
    assert Decimal(restored['latest']['yield']) == Decimal('.85')
    assert records(store.path)[:len(before)] == before
