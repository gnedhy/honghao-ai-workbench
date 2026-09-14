"""Independent acceptance of RD5 costs against real procurement data and HTTP permissions."""
import copy
import json
import sqlite3
from decimal import Decimal
from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient
from openpyxl import Workbook

import api.research as research
from api.identity import IdentityStore
from api.main import create_app
from api.procurement_inventory import import_inventory, inventory_preview
from api.procurement_rd5 import revise_preparation
from api.research import ResearchStore, capture, enqueue
from api.research_formulas import DEFAULT_COMPOSITE, calculate
from tests.test_procurement_isolation import confirm_risks, import_prices, publish
from tests.test_procurement_rd5 import data, trial_data, table_rows


K = 'recipe:K172-C'
RH = 'recipe:RH-1A'
PREFIX = '/api/workbenches/research'


@pytest.fixture
def ready(trial_data):
    original, source_digest = trial_data
    settings, client, _, admin = original
    plan = revise_preparation(settings.database_path, source_digest)
    revise_preparation(settings.database_path, source_digest, actor_id=admin,
                       expected_state_sha256=plan['state_sha256'])
    before = table_rows(settings.database_path)
    store = ResearchStore(settings.database_path)
    store.initialize()
    store.process_events()
    assert table_rows(settings.database_path) == before
    settings.workbench_modes['research'] = 'active'
    return settings, client, admin, store


def body_for(store, key=K):
    detail = store.detail(key)
    formula = next(r for r in detail['recipes'] if r['id'] == key)
    return {'formula': dict(copy.deepcopy(formula), adjustment_reason='配方优化', adjustment_note=''), 'draft_revision': detail['draft_revision']}


def saved(store, actor, body=None, key=K):
    body = body or body_for(store, key)
    result = store.simulate(key, body)
    receipt = store.save(key, dict(body, simulation_token=result['simulation_token']), actor)
    return result, receipt


def records(path):
    with sqlite3.connect(path) as db:
        return db.execute('SELECT sequence,event_id,product_id,signature,payload FROM research_cost_records ORDER BY sequence').fetchall()


def frozen(store):
    with sqlite3.connect(store.path) as db:
        return capture(db)


def update_stock(ready, tmp_path, code, price):
    settings, _, admin, _ = ready
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = '原料行情总表'
    sheet.append(['编号', '库存量', '库存价'])
    with sqlite3.connect(settings.database_path) as db:
        rows = db.execute('SELECT m.code,i.quantity,i.price FROM procurement_materials m LEFT JOIN procurement_inventory i ON i.material_id=m.id WHERE m.archived_at IS NULL ORDER BY m.code').fetchall()
    for item, qty, stock in rows:
        sheet.append([item, float(qty or 0), price if item == code else float(stock) if stock is not None else None])
    source = tmp_path / 'inventory.xlsx'
    workbook.save(source)
    preview = inventory_preview(settings.database_path, source.read_bytes())
    args = dict(expected_sha256=preview['sha256'], expected_catalog_sha256=preview['catalog_sha256'])
    return import_inventory(settings.database_path, source, admin, **args), source, args


def test_dual_cost_chain_uses_each_layer_yield_and_fallback(ready):
    _, _, _, store = ready
    values = frozen(store)
    latest = calculate(values['package'], values['prices'])
    stock = calculate(values['package'], values['prices'], price_policy='inventory')
    for results, a, k, d in [(latest, '30', '12.9', '9.1'), (stock, '9', '14.5', '8.9')]:
        composite = (Decimal(k) * 3000 + Decimal(d) * 300) / 3300 / Decimal('.995')
        product = (composite + Decimal(8) + Decimal(a)) / 3 / Decimal('.9')
        upstream = product * 20 / 100 / Decimal('.8')
        assert abs(Decimal(results[DEFAULT_COMPOSITE]['cost']) - composite) < Decimal('1e-24')
        assert abs(Decimal(results[K]['cost']) - product) < Decimal('1e-24')
        assert abs(Decimal(results[RH]['cost']) - upstream) < Decimal('1e-24')
        assert results[K]['lines'][1]['basis'] == 'inventory'  # B has no latest price.
        assert [x['unit_cost'] for x in results[RH]['lines'][1:]] == ['0', '0']
    values['prices']['A']['inventory_price'] = '0'
    assert calculate(values['package'], values['prices'], price_policy='inventory')[K]['lines'][2]['unit_cost'] == '30'
    values['prices']['B'] = {'latest_price': None, 'inventory_price': None}
    for policy in ['latest', 'inventory']:
        result = calculate(values['package'], values['prices'], price_policy=policy)
        assert result[K]['missing_materials'] == result[RH]['missing_materials'] == ['B']
        assert result[RH]['cost'] is None


def test_baseline_is_single_real_period_and_historical_trials_are_separate(ready):
    _, _, _, store = ready
    assert {p['id'] for p in store.listing()['products']} == {K, RH}
    assert all(p['change']['percent'] is None for p in store.listing()['products'])
    assert len(store.trials()['recipes']) == 3
    assert len(store.history()['versions']) == 1
    assert len(store.history()['versions'][0]['products']) == 2
    before = records(store.path)
    store.initialize()
    store.process_events()
    assert records(store.path) == before


def test_draft_persists_isolated_then_activation_updates_dependents(ready):
    settings, _, actor, store = ready
    before = records(store.path)
    body = body_for(store)
    body['formula']['yield'] = '.95'
    trial, receipt = saved(store, actor, body)
    assert {r['id'] for r in trial['affected']} == {K, RH}
    assert records(store.path) == before
    reopened = ResearchStore(settings.database_path)
    reopened.initialize()
    assert Decimal(reopened.detail(K)['draft']['formula']['yield']) == Decimal('.95')
    assert reopened.detail(K)['product']['latest_cost'] == store.detail(K)['history'][0]['latest_cost']
    assert reopened.activate(K, receipt, actor) == {'status': 'updating'}
    assert all(r['status'] == 'updating' for r in reopened.listing()['products'])
    reopened.process_events()
    assert reopened.detail(K)['draft'] is None
    assert reopened.detail(K)['product']['revision'] == 2
    assert len(reopened.detail(RH)['history']) == 2
    assert len(reopened.detail(DEFAULT_COMPOSITE)['history']) == 1
    assert records(store.path)[:len(before)] == before
    with sqlite3.connect(settings.database_path) as db:
        versions = db.execute('SELECT revision,formula FROM research_formula_versions WHERE id=? ORDER BY revision', (K,)).fetchall()
    assert [json.loads(row[1])['yield'] for row in versions] == ['0.9', '0.95']


def test_optimistic_draft_revision_prevents_overwrite_discard_and_old_activation(ready):
    _, _, actor, store = ready
    body = body_for(store)
    trial, first = saved(store, actor, body)
    with pytest.raises(RuntimeError, match='草稿'):
        store.save(K, dict(body, simulation_token=trial['simulation_token']), actor)
    _, second = saved(store, actor)
    with pytest.raises(RuntimeError, match='草稿'):
        store.discard(K, first['revision'])
    with pytest.raises(RuntimeError, match='草稿'):
        store.activate(K, first, actor)
    store.discard(K, second['revision'])
    assert store.detail(K)['draft'] is None
    with pytest.raises(RuntimeError, match='草稿'):
        store.simulate(K, dict(body, draft_revision=second['revision']))


def test_changed_source_invalidates_saved_simulation_without_losing_draft(ready, tmp_path):
    _, _, actor, store = ready
    _, receipt = saved(store, actor)
    update_stock(ready, tmp_path, 'A', 10)
    before = copy.deepcopy(store.detail(K)['draft'])
    with pytest.raises(RuntimeError, match='重新试算'):
        store.activate(K, receipt, actor)
    assert store.detail(K)['draft'] == before
    trial = store.simulate(K, body_for(store))
    store.activate(K, dict(receipt, simulation_token=trial['simulation_token']), actor)
    store.process_events()


@pytest.mark.parametrize('failure', ['zero_yield', 'negative_yield', 'negative_quantity', 'zero_total', 'nan', 'infinity', 'cycle', 'unknown', 'stopped', 'historical'])
def test_invalid_drafts_fail_without_business_writes(ready, failure):
    _, _, actor, store = ready
    body = body_for(store)
    if failure in ['zero_yield', 'negative_yield']:
        body['formula']['yield'] = '0' if failure == 'zero_yield' else '-1'
    elif failure in ['negative_quantity', 'nan', 'infinity']:
        body['formula']['lines'][0]['quantity'] = {'negative_quantity': '-1', 'nan': 'NaN', 'infinity': 'Infinity'}[failure]
    elif failure == 'zero_total':
        for line in body['formula']['lines']:
            line['quantity'] = '0'
    else:
        kind, ref = {'cycle': ('recipe', RH), 'unknown': ('material', 'UNKNOWN'),
                     'stopped': ('material', 'CF020C'), 'historical': ('recipe', 'recipe:K172-C（026+020C）')}[failure]
        body['formula']['lines'][0].update(kind=kind, ref=ref)
    before = records(store.path)
    with pytest.raises(ValueError):
        store.simulate(K, body)
    assert store.detail(K)['draft'] is None
    assert records(store.path) == before


def test_missing_prices_allow_reviewable_draft_but_block_activation(ready):
    _, _, actor, store = ready
    body = body_for(store)
    with sqlite3.connect(store.path) as db:
        db.execute("UPDATE procurement_inventory SET price=NULL WHERE material_id=(SELECT id FROM procurement_materials WHERE code='B')")
    trial, receipt = saved(store, actor, body)
    assert trial['blocking'] == ['B']
    assert trial['latest']['cost'] is None
    with pytest.raises(ValueError, match='缺少价格'):
        store.activate(K, receipt, actor)
    assert store.detail(K)['draft'] is not None
    assert len(store.history()['versions']) == 1


def test_above_100_percent_yield_and_repeated_lines_are_preserved(ready):
    _, _, _, store = ready
    body = body_for(store, RH)
    body['formula']['yield'] = '1.02'
    trial = store.simulate(RH, body)
    assert trial['warnings'] and trial['latest']['yield'] == '1.02'
    assert [r['code'] for r in trial['latest']['lines']] == ['K172-C', '纯水', '纯水']


def test_unrelated_price_addition_and_unchanged_price_do_not_reset_history(ready):
    _, client, _, store = ready
    before = records(store.path)
    assert publish(client, import_prices(client, '2026-09-12', [('EXTRA', 8)])).status_code == 200
    store.process_events()
    assert records(store.path) == before
    assert publish(client, import_prices(client, '2026-09-13', [('A', 30)])).status_code == 200
    store.process_events()
    assert records(store.path) == before
    change = import_prices(client, '2026-09-14', [('A', 33)])
    confirm_risks(client, change)
    assert publish(client, change).status_code == 200
    store.process_events()
    assert len(store.detail(K)['history']) == len(store.detail(RH)['history']) == 2
    assert store.detail(K)['product']['change']['percent'] > 0
    assert records(store.path)[:len(before)] == before


def test_inventory_import_affects_stock_cost_latest_is_flat_and_reimport_is_idempotent(ready, tmp_path):
    settings, _, actor, store = ready
    old = copy.deepcopy(store.detail(K))
    result, source, args = update_stock(ready, tmp_path, 'A', 10)
    assert result['updated'] > 0
    store.process_events()
    current = store.detail(K)
    assert current['product']['latest_cost'] == old['product']['latest_cost']
    assert Decimal(current['product']['inventory_cost']) > Decimal(old['product']['inventory_cost'])
    assert current['product']['change']['percent'] == 0
    snapshot = records(store.path)
    assert import_inventory(settings.database_path, source, actor, **args)['updated'] == 0
    with sqlite3.connect(store.path) as db:
        enqueue(db, '重复刷新')
    store.process_events()
    assert records(store.path) == snapshot


def test_failed_event_keeps_purchase_commit_and_retries_exact_frozen_input(ready, monkeypatch):
    settings, client, _, store = ready
    update = import_prices(client, '2026-09-12', [('A', 33)])
    confirm_risks(client, update)
    assert publish(client, update).status_code == 200
    before = records(store.path)
    real = research.evaluate
    def fail(_):
        raise ValueError('temporary calculation fault')
    monkeypatch.setattr(research, 'evaluate', fail)
    with pytest.raises(ValueError, match='temporary'):
        store.process_events()
    assert records(store.path) == before
    assert store.detail(K)['product']['status'] == 'failed'
    assert frozen(store)['prices']['A']['latest_price'] == '33'
    with sqlite3.connect(settings.database_path) as db:
        failed = db.execute("SELECT inputs,attempts FROM research_events WHERE status='failed'").fetchone()
    assert json.loads(failed[0])['prices']['A']['latest_price'] == '33'
    assert failed[1] == 1
    monkeypatch.setattr(research, 'evaluate', real)
    assert store.process_events() == 1
    after = records(store.path)
    assert len(after) == len(before) + 2
    assert store.process_events() == 0
    assert records(store.path) == after


def test_queued_price_events_keep_intermediate_input_and_own_comparison(ready):
    _, client, _, store = ready
    original = store.detail(K)['product']['latest_cost']
    for date, price in [('2026-09-12', 33), ('2026-09-13', 36)]:
        update = import_prices(client, date, [('A', price)])
        confirm_risks(client, update)
        assert publish(client, update).status_code == 200
    assert store.process_events() == 2
    history = store.detail(K)['history']
    assert len(history) == 3
    assert [r['latest']['lines'][2]['unit_cost'] for r in history] == ['36', '33', '30']
    assert Decimal(history[2]['latest_cost']) == Decimal(original)
    current, previous, initial = [research.comparison_price(r['latest_cost']) for r in history]
    assert history[0]['change']['percent'] == pytest.approx(float((current - previous) / previous * 100))
    assert history[1]['change']['percent'] == pytest.approx(float((previous - initial) / initial * 100))


def test_activation_transaction_rolls_back_when_event_cannot_be_saved(ready, monkeypatch):
    _, _, actor, store = ready
    body = body_for(store)
    body['formula']['yield'] = '.95'
    _, receipt = saved(store, actor, body)
    before = store.detail(K)
    def fail(*_):
        raise sqlite3.OperationalError('event write failed')
    monkeypatch.setattr(research, 'enqueue', fail)
    with pytest.raises(sqlite3.OperationalError, match='event write'):
        store.activate(K, receipt, actor)
    assert store.detail(K) == before
    with sqlite3.connect(store.path) as db:
        assert db.execute('SELECT COUNT(*) FROM research_formula_versions WHERE id=?', (K,)).fetchone()[0] == 1


@pytest.mark.parametrize('current,previous,percent,reason', [
    ('0', None, None, '首次'), ('0', {'latest_cost': '0'}, None, '零'),
    (None, {'latest_cost': '10'}, None, '缺少'), ('10', {'latest_cost': None}, None, '缺少'),
    ('10', {'latest_cost': '10'}, 0, '10.00 → 10.00'), ('9', {'latest_cost': '10'}, -10, '10.00 → 9.00'),
])
def test_percentage_boundary_explains_why_comparison_is_unavailable(current, previous, percent, reason):
    result = research.comparison(current, previous)
    assert result['percent'] == percent
    assert reason in result['reason']


@pytest.mark.parametrize('scope,level,view,edit,activate', [('research', 0, 403, 403, 403), ('research', 2, 200, 403, 403), ('research', 3, 200, 200, 403), ('research', 4, 200, 200, 200), ('procurement', 4, 403, 403, 403)])
def test_http_permissions_apply_to_each_operation(ready, scope, level, view, edit, activate):
    settings, _, actor, store = ready
    IdentityStore(settings.database_path).create_user(username='rd-user', display_name='原表负责人',
        department='研发五部', password='Research-Password-2026', scope_levels={scope: level} if level else {})
    _, receipt = saved(store, actor)
    key = quote(K, safe='')
    with TestClient(create_app(settings)) as client:
        assert client.post('/api/login', json={'username': 'rd-user', 'password': 'Research-Password-2026'}).status_code == 200
        for path in ['/products', '/overview', '/history', '/trials', f'/products/{key}']:
            assert client.get(PREFIX + path).status_code == view, path
        body = body_for(store)
        response = client.post(PREFIX + f'/products/{key}/simulate', json=body)
        assert response.status_code == edit, response.text
        if edit == 200:
            body['simulation_token'] = response.json()['simulation_token']
        write = client.put(PREFIX + f'/products/{key}/draft', json=body)
        assert write.status_code == edit, write.text
        if edit == 200:
            receipt = write.json()
        response = client.post(PREFIX + f'/products/{key}/activate', json=receipt)
        assert response.status_code == activate, response.text
        if edit == 403:
            response = client.request('DELETE', PREFIX + f'/products/{key}/draft', json={'revision': receipt['revision']})
            assert response.status_code == 403


def test_http_disabled_module_and_invalid_payload_are_guarded(ready):
    settings, client, _, store = ready
    key = quote(K, safe='')
    body = body_for(store)
    body['formula']['lines'][0]['quantity'] = 'NaN'
    assert client.post(PREFIX + f'/products/{key}/simulate', json=body).status_code == 422
    settings.workbench_modes['research'] = 'prototype'
    assert client.get(PREFIX + '/products').status_code == 404
    assert client.post(PREFIX + f'/products/{key}/simulate', json=body).status_code == 404


def test_detail_exposes_only_rd5_material_price_inputs(ready):
    _, client, _, store = ready
    assert publish(client, import_prices(client, '2026-09-12', [('EXTRA', 8)])).status_code == 200
    store.process_events()
    response = client.get(PREFIX + '/products/' + quote(K, safe=''))
    assert response.status_code == 200, response.text
    payload = response.json()
    assert 'EXTRA' not in payload['prices']
    assert 'CF401B' not in payload['prices']
    assert set(payload['prices']) == {r['code'] for r in payload['options']['materials']}
    assert payload['prices']['A']['latest_price'] == '30'


@pytest.mark.parametrize('field', ['quantity', 'yield'])
def test_extreme_decimal_exponent_is_rejected_before_expansion(ready, field):
    _, client, _, store = ready
    body = body_for(store)
    if field == 'quantity':
        body['formula']['lines'][0]['quantity'] = '1e-1000000000'
    else:
        body['formula']['yield'] = '1e-1000000000'
    response = client.post(PREFIX + '/products/' + quote(K, safe='') + '/simulate', json=body)
    assert response.status_code == 422, response.text
    assert store.detail(K)['draft'] is None


def test_shared_reference_dag_fingerprint_has_bounded_inputs(monkeypatch):
    formulas = []
    for index in range(14):
        lines = [{'kind': 'recipe' if index else 'material', 'ref': f'P{index - 1}' if index else 'A',
                  'code': f'P{index - 1}' if index else 'A', 'quantity': '1', 'source_row': None}
                 for _ in range(2)]
        formulas.append({'id': f'P{index}', 'name': f'P{index}', 'kind': 'recipe', 'yield': '1', 'lines': lines})
    inputs = {'package': {'materials': [], 'recipes': formulas}, 'prices': {'A': {'latest_price': '10', 'inventory_price': '9'}}}
    result = research.evaluate(inputs)
    original_digest = research.digest
    def bounded_digest(value):
        # A shared dependency must stay a digest, not be expanded as a binary tree.
        assert len(research.packed(value)) < 4096
        return original_digest(value)
    monkeypatch.setattr(research, 'digest', bounded_digest)
    before = research.signature(inputs, result, 'P13')
    inputs['prices']['A']['inventory_price'] = '8'
    assert research.signature(inputs, research.evaluate(inputs), 'P13') != before


def test_composite_detail_never_calls_pending_or_failed_results_current(ready, monkeypatch):
    _, _, _, store = ready
    with sqlite3.connect(store.path) as db:
        enqueue(db, '待核算复配')
    assert store.detail(DEFAULT_COMPOSITE)['product']['status'] == 'updating'
    def fail(_):
        raise ValueError('test retryable fault')
    monkeypatch.setattr(research, 'evaluate', fail)
    with pytest.raises(ValueError):
        store.process_events()
    assert store.detail(DEFAULT_COMPOSITE)['product']['status'] == 'failed'


def test_two_decimal_comparison_supports_large_valid_costs():
    assert research.comparison_price("1000000000000000000000000000") == Decimal("1000000000000000000000000000.00")
    assert research.comparison("1200000000000000000000000000", {"latest_cost": "1000000000000000000000000000"})["percent"] == 20


def test_independent_ratios_survive_draft_activation_and_history(ready):
    settings, _, actor, store = ready
    body = body_for(store)
    old_cost = store.detail(K)['product']['latest_cost']
    body['formula'].update(ratio_linked=False, ratio_base='100')
    for line in body['formula']['lines']:
        line['ratio'] = '120'
    trial, receipt = saved(store, actor, body)
    reopened = ResearchStore(settings.database_path)
    assert reopened.detail(K)['draft']['formula']['lines'][0]['ratio'] == '120'
    reopened.activate(K, receipt, actor)
    reopened.process_events()
    current = reopened.detail(K)
    assert current['product']['latest_cost'] == old_cost
    assert current['history'][0]['formula']['lines'][0]['ratio'] == '120'
    assert current['history'][0]['formula']['ratio_linked'] is False


@pytest.mark.parametrize('ratio', ['-1', 'NaN', 'Infinity'])
def test_invalid_ratio_is_rejected(ready, ratio):
    _, _, actor, store = ready
    body = body_for(store)
    body['formula']['lines'][0]['ratio'] = ratio
    with pytest.raises(ValueError, match='配方比例'):
        saved(store, actor, body)


def test_delete_only_unused_new_formula(ready):
    settings, client, actor, store = ready
    owner = store.detail(K)['product']['owner']
    created = store.create_formula({'name':'DELETE-TEST','owner':owner}, actor)
    key = created['id']
    with pytest.raises(RuntimeError):
        store.delete_formula(key, {'revision':99})
    with pytest.raises(ValueError):
        store.delete_formula(K, {'revision':store.detail(K)['draft_revision']})
    response = client.request('DELETE', PREFIX + '/products/' + quote(key, safe=''), json={'revision':0})
    assert response.status_code == 200, response.text
    with pytest.raises(KeyError):
        store.detail(key)


def test_formula_owner_saved_and_activated(ready):
    settings, client, actor, store = ready
    body = body_for(store)
    owner = '另一负责人'
    with sqlite3.connect(settings.database_path) as db:
        db.execute("UPDATE research_formulas SET formula=json_set(formula,'$.owner',?) WHERE id=?", (owner,RH))
    body['formula']['owner'] = owner
    for line in body['formula']['lines']:
        line['ratio'] = '10'
    trial, receipt = saved(store, actor, body)
    assert store.detail(K)['draft']['formula']['owner'] == owner
    store.activate(K, receipt, actor)
    store.process_events()
    assert store.detail(K)['product']['owner'] == owner
    body['formula']['owner'] = 'INVALID OWNER'
    body['draft_revision'] = store.detail(K)['draft_revision']
    with pytest.raises(ValueError, match='负责人'):
        store.simulate(K, body)


def test_saved_trial_snapshot_reopens(ready):
    settings, client, actor, store = ready
    trial, receipt = saved(store, actor)
    snapshot = ResearchStore(settings.database_path).detail(K)['draft']['simulation']
    assert snapshot['latest'] == trial['latest']
    assert snapshot['inventory'] == trial['inventory']
    assert snapshot['simulation_token'] == receipt['simulation_token']


@pytest.mark.parametrize('policy', ['latest', 'inventory'])
def test_manual_cost_propagates_and_procurement_keeps_override(ready, tmp_path, policy):
    _, _, actor, store = ready
    body = body_for(store)
    body['formula']['manual_costs'] = {policy: '0'}
    trial, receipt = saved(store, actor, body)
    assert trial[policy]['cost'] == '0'
    assert Decimal(trial[policy]['auto_cost']) > 0
    assert {r['id'] for r in trial['affected']} >= {K, RH}
    store.activate(K, dict(revision=receipt['revision'], simulation_token=receipt['simulation_token']), actor)
    store.process_events()
    before = records(store.path)
    values = research.evaluate(frozen(store))
    assert values[policy][K]['cost'] == '0'
    assert values[policy][RH]['cost'] == '0'
    update_stock(ready, tmp_path, 'B', 20)
    store.process_events()
    after = research.evaluate(frozen(store))
    assert after[policy][K]['cost'] == '0'
    assert after[policy][K]['auto_cost'] != values[policy][K]['auto_cost']
    assert records(store.path)[:len(before)] == before
    body = body_for(store)
    body['formula']['manual_costs'] = {policy: None}
    trial, receipt = saved(store, actor, body)
    assert trial[policy]['cost'] == trial[policy]['auto_cost']
    store.activate(K, dict(revision=receipt['revision'], simulation_token=receipt['simulation_token']), actor)
    store.process_events()
    assert store.detail(K)[policy]['cost_source'] == 'auto'


@pytest.mark.parametrize('value', ['-1', 'NaN', 'Infinity', '', 'abc'])
def test_manual_cost_rejects_invalid_amount(ready, value):
    _, client, _, store = ready
    body = body_for(store)
    body['formula']['manual_costs'] = {'latest': value}
    assert client.post(f'{PREFIX}/products/{quote(K)}/simulate', json=body).status_code == 422


def test_reason_and_manual_changes_invalidate_confirmation(ready):
    _, client, actor, store = ready
    body = body_for(store)
    for reason, note in [('', ''), ('其他', ''), ('not-valid', '说明')]:
        body['formula'].update(adjustment_reason=reason, adjustment_note=note)
        assert client.post(f'{PREFIX}/products/{quote(K)}/simulate', json=body).status_code == 422
    body['formula'].update(adjustment_reason='其他', adjustment_note='核对测试', manual_costs={'latest':'12.3456789','inventory':'0'})
    trial = store.simulate(K, body)
    assert trial['latest']['cost'] == '12.3456789'
    body['formula']['adjustment_note'] = '说明变化'
    with pytest.raises(RuntimeError):
        store.save(K, dict(body, simulation_token=trial['simulation_token']), actor)
    body['formula']['adjustment_note'] = '核对测试'
    body['formula']['manual_costs']['latest'] = '13'
    with pytest.raises(RuntimeError):
        store.save(K, dict(body, simulation_token=trial['simulation_token']), actor)


def test_manual_cost_missing_price_and_cycle_validation(ready):
    _, _, _, store = ready
    inputs = frozen(store)
    recipe = next(r for r in inputs['package']['recipes'] if r['id'] == K)
    recipe['manual_costs'] = {'latest':'0'}
    inputs['prices']['B'] = {'latest_price':None,'inventory_price':None}
    values = research.evaluate(inputs)
    assert values['latest'][K]['auto_cost'] is None
    assert values['latest'][K]['cost'] == '0'
    assert 'B' in values['latest'][K]['missing_materials']
    assert values['latest'][RH]['cost'] == '0'
    assert values['inventory'][RH]['cost'] is None
    recipe['lines'][0].update(kind='recipe',ref=K)
    with pytest.raises(ValueError, match='循环'):
        research.evaluate(inputs)



def test_rd5_accounts_reuse_passwords_and_own_activation(ready):
    from scripts.configure_rd5_accounts import configure, PEOPLE
    settings, _, actor, store = ready
    identities = IdentityStore(settings.database_path)
    existing = identities.create_user(username='existing-lin', display_name='林菲菲',
        department=None, password='Existing-Password-2026', scope_levels={'research':2})
    configure(settings.database_path, actor, True)
    configure(settings.database_path, actor, True)
    assert identities.login('existing-lin', 'Existing-Password-2026', 3600)
    users = identities.list_users()
    assert len([u for u in users if u['display_name'] == '林菲菲']) == 1
    assert set(name for _, name, _ in PEOPLE) <= set(store.formulas()['owners'])
    for username, name, level in PEOPLE:
        user = next(u for u in users if u['display_name'] == name)
        assert user['department'] == '研发五部'
        assert user['scope_levels']['research'] == level
        with TestClient(create_app(settings)) as client:
            password = 'Existing-Password-2026' if user['id'] == existing['id'] else '123456'
            assert client.post('/api/login', json={'username':user['username'], 'password':password}).status_code == 200
            body = body_for(store)
            trial = client.post(f'{PREFIX}/products/{quote(K)}/simulate', json=body)
            assert trial.status_code == 200
            receipt = client.put(f'{PREFIX}/products/{quote(K)}/draft', json=dict(body,simulation_token=trial.json()['simulation_token']))
            assert receipt.status_code == 200
            activation = client.post(f'{PREFIX}/products/{quote(K)}/activate', json=receipt.json())
            assert activation.status_code == (200 if level == 4 else 403)
            store.process_events()
    with sqlite3.connect(store.path) as db:
        formula = json.loads(db.execute('SELECT formula FROM research_formulas WHERE id=?',(K,)).fetchone()[0])
    assert formula['edited_by'] == existing['id'] == formula['activated_by']



def test_three_layer_mixed_manual_policies_use_final_upstream_cost(ready):
    _, _, _, store = ready
    inputs = frozen(store)
    recipes = inputs['package']['recipes']
    upstream = next(r for r in recipes if r['id'] == K)
    middle = next(r for r in recipes if r['id'] == RH)
    upstream['manual_costs'] = {'latest':'12'}
    middle['manual_costs'] = {'latest':'9','inventory':'7'}
    recipes.append(dict(id='recipe:downstream', name='downstream', kind='recipe',
        **{'yield':'0.5'}, lines=[dict(kind='recipe',ref=RH,code='RH',quantity='100',source_row=None)]))
    values = research.evaluate(inputs)
    assert values['latest'][RH]['auto_cost'] == '3'
    assert values['latest'][RH]['cost'] == '9'
    assert values['latest']['recipe:downstream']['cost'] == '18'
    assert values['inventory']['recipe:downstream']['cost'] == '14'
    assert values['inventory'][K]['cost_source'] == 'auto'


def test_missing_prices_only_allow_effective_manual_policy_and_stale_price_token(ready):
    _, _, actor, store = ready
    body = body_for(store)
    body['formula']['manual_costs'] = {'latest':'1','inventory':'2'}
    trial = store.simulate(K,body)
    with sqlite3.connect(store.path) as db:
        db.execute("UPDATE procurement_inventory SET price='200' WHERE material_id=(SELECT id FROM procurement_materials WHERE code='B')")
    with pytest.raises(RuntimeError):
        store.save(K,dict(body,simulation_token=trial['simulation_token']),actor)
    with sqlite3.connect(store.path) as db:
        db.execute("UPDATE procurement_inventory SET price=NULL WHERE material_id=(SELECT id FROM procurement_materials WHERE code='B')")
    trial = store.simulate(K,body)
    assert not trial['blocking']
    assert trial['latest']['auto_cost'] is None
    body['formula']['manual_costs']['inventory'] = None
    assert store.simulate(K,body)['blocking']
