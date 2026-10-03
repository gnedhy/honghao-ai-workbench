"""Quotation calculations and isolated PostgreSQL lifecycle/authorization checks."""
from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal
from threading import Barrier

import pytest

from api.identity import IdentityStore
from api.postgres import transaction
from api.research import packed
from api.research_formulas import DEFAULT_COMPOSITE
from api.sales import DraftBody, SalesStore, allocation, calculate, defaults, decimal
from api.sales_calculator import CalculatorStore, Evaluation, Panel, SavedInput, Step, Tier, calculate_panel
from tests.helpers import authenticated_client
from tests.test_procurement_workbench import procurement_settings


@pytest.fixture
def sales(tmp_path):
    settings = procurement_settings(tmp_path)
    settings.workbench_modes['sales'] = 'active'
    with authenticated_client(settings) as client:
        identities = IdentityStore(settings.database_url)
        with transaction(settings.database_url) as db:
            admin_id = db.execute("SELECT id FROM identity_users WHERE username='test-admin'").fetchone()[0]
        admin = dict(id=admin_id, is_system_admin=True, scope_levels={})
        with transaction(settings.database_url, write=True) as db:
            for key, name, latest, inventory in [('recipe:Q', 'Q', '4', '12'), (DEFAULT_COMPOSITE, 'CF401B', '8.1234567890123456789012345678', '9')]:
                formula = dict(id=key, name=name, kind='recipe' if key.startswith('recipe:') else 'composite', revision=1)
                db.execute("INSERT INTO research_formulas(id,formula,lifecycle,position,revision) VALUES(%s,%s,'active',0,1)", (key, packed(formula)))
                db.execute('INSERT INTO research_cost_records(event_id,product_id,signature,payload) VALUES(%s,%s,%s,%s)',
                           ('event-' + key, key, key, packed(dict(latest_cost=latest, inventory_cost=inventory, status='ready'))))
        yield settings, client, SalesStore(settings.database_url), admin


def new(sales, mode='domestic_direct'):
    _, _, store, actor = sales
    return store.create(dict(name='客户询价', mode=mode), actor)['batch']


def save(sales, batch, **changes):
    _, _, store, actor = sales
    body = {key: deepcopy(batch[key]) for key in ('revision', 'name', 'mode', 'customer_name', 'customer_code', 'uncoded', 'salesperson', 'items')}
    body.update(changes)
    return store.save(batch['id'], DraftBody.model_validate(body).model_dump(), actor)['batch']


def prepared(sales, mode='domestic_direct', product='research:recipe:Q'):
    batch = new(sales, mode)
    batch = save(sales, batch, customer_name='客户甲', uncoded=True, salesperson='销售甲', items=[dict(product_id=product)])
    if product.endswith(DEFAULT_COMPOSITE):
        batch['items'][0]['parameters']['allocation'] = '.3'
        batch = save(sales, batch)
    _, _, store, actor = sales
    return store.trial(batch['id'], dict(revision=batch['revision'], product_ids=[product]), actor)['batch']


def adopt(sales, batch, **extra):
    return sales[2].adopt(batch['id'], dict(revision=batch['revision'], product_ids=[i['product_id'] for i in batch['items']], **extra), sales[3])['batch']


def test_formulas_boundaries_precision_and_validation():
    assert [allocation(Decimal(n)) for n in ('4.999999999999999999', '5', '10', '15', '20', '25', '30')] == ['.5', '.8', '1.2', '1.5', '1.8', '2.2', '2.5']
    assert calculate('domestic_direct', '4', defaults('domestic_direct', '4')) == {'normal_price': '6.92', 'break_even_price': '6.29'}
    assert calculate('domestic_intermediary', '4', defaults('domestic_intermediary', '4')) == {'normal_price': '6.61', 'break_even_price': '6.01'}
    for mode in ('export_direct', 'export_intermediary'):
        assert calculate(mode, '4', defaults(mode, '4')) == {'normal_price': '7.36', 'break_even_price': None}
    for invalid in ('NaN', 'Infinity', '-1', '1e100', '.0000000000000000001'):
        with pytest.raises(ValueError):
            decimal(invalid)
    assert calculate('domestic_direct', '8.1234567890123456789012345678', dict(defaults('domestic_direct'), allocation='.3'), True)['normal_price']
    with pytest.raises(ValueError, match='特殊公摊'):
        calculate('domestic_direct', '8', dict(defaults('domestic_direct'), allocation='.2'), True)


def test_calculator_custom_steps_and_reverse_tiers():
    steps = [Step(id='allocation', label='公摊', operation='+', automatic_allocation=True, fee=True),
             Step(id='freight', label='运费', operation='+', value='0.3', fee=True),
             Step(id='barrel', label='桶费', operation='+', value='0.5', fee=True),
             Step(id='tax', label='税提成系数', operation='*', value='1.11'),
             Step(id='profit', label='利润系数', operation='*', value='1.1'),
             Step(id='reverse', label='反推核算比例', operation='*', value='1.07')]
    panel = Panel(id='a', name='基准', mode='domestic_direct', steps=steps)
    for cost in ('4.99', '5', '9.99', '10', '30'):
        forward = calculate_panel(panel, cost)
        assert forward['price'] == calculate('domestic_direct', cost, defaults('domestic_direct', cost))['normal_price']
        reverse = calculate_panel(panel.model_copy(update={'direction': 'reverse', 'target_price': forward['price']}), cost)
        assert Decimal(reverse['target_cost']) >= Decimal(cost)
        assert Decimal(calculate_panel(panel, reverse['target_cost'])['price']) <= Decimal(forward['price'])
    custom = Panel(id='b', name='自定义', mode='export_direct', steps=[
        Step(id='add', label='包装', operation='+', value='2', fee=True),
        Step(id='subtract', label='折扣', operation='-', value='1', fee=True),
        Step(id='multiply', label='系数', operation='*', value='3'),
        Step(id='divide', label='换算', operation='/', value='2')])
    assert calculate_panel(custom, '4')['price'] == '7.50'
    assert calculate_panel(custom.model_copy(update={'direction': 'reverse', 'target_price': '7.50'}), '4')['target_cost'] == '4.00'
    with pytest.raises(ValueError, match='成本'):
        calculate_panel(panel, None)
    assert calculate_panel(custom.model_copy(update={'direction': 'reverse', 'target_price': '7.50'}), None)['cost_gap'] is None
    with pytest.raises(ValueError, match='自动公摊'):
        calculate_panel(panel, '13', special=True)
    special = Panel(id='special', name='特殊公摊', mode='domestic_direct', steps=[
        Step(id='allocation', label='特殊公摊', operation='+', value='1.01', fee=True, allocation_step=True)])
    with pytest.raises(ValueError, match='特殊公摊'):
        calculate_panel(special, '13', special=True)
    with pytest.raises(ValueError, match='递增'):
        calculate_panel(custom.model_copy(update={'steps': [Step(id='x', label='倒扣', operation='-', value='1'),
                                                            Step(id='y', label='清零', operation='*', value='0')],
                                              'direction': 'reverse', 'target_price': '1'}), '4')

    tiers = [Tier(upper='4.50', amount='.25'), Tier(upper='7.25', amount='.9'), Tier(upper=None, amount='1.4')]
    custom_tier = Panel(id='tiers', name='自定义分档', mode='domestic_direct', steps=[
        Step(id='allocation', label='公摊', operation='+', fee=True, automatic_allocation=True, tiers=tiers)])
    assert [calculate_panel(custom_tier, cost)['price'] for cost in ('4.49', '4.50', '7.24', '7.25')] == [
        '4.74', '5.40', '8.14', '8.65']
    reverse_tier = custom_tier.model_copy(update={'direction': 'reverse', 'target_price': '8.14'})
    assert calculate_panel(reverse_tier, '4.49')['target_cost'] == '7.24'
    for invalid in ([Tier(upper=None, amount='1'), Tier(upper=None, amount='2')],
                    [Tier(upper='5', amount='.5'), Tier(upper='5', amount='.8'), Tier(upper=None, amount='1')],
                    [Tier(upper='5', amount='.5')]):
        with pytest.raises(ValueError, match='档'):
            calculate_panel(custom_tier.model_copy(update={'steps': [Step(
                id='allocation', label='公摊', operation='+', fee=True, automatic_allocation=True, tiers=invalid)]}), '4')


def test_calculator_private_saved_workspace_and_source(sales):
    from api.operations import _table_evidence

    _, client, store, actor = sales
    with transaction(store.url) as db:
        formal_before = {name: evidence for name, evidence in _table_evidence(db).items()
                         if name.startswith(('sales_', 'procurement_', 'research_')) and name != 'sales_calculator_saved'}
    calculator = CalculatorStore(store)
    product = store.products(actor)['products'][0]
    body = Evaluation(source={'kind': 'product', 'product_id': product['id'], 'basis': 'latest'},
                      panels=[Panel(id='a', name='试算', mode='domestic_direct', steps=[])])
    result = calculator.evaluate(body, actor)
    assert result['source']['cost'] == product['latest_cost']
    assert result['results'][0]['result']['price'] == format(Decimal(product['latest_cost']), '.2f')
    response = client.post('/api/workbenches/sales/calculator/evaluate', json=body.model_dump())
    assert response.status_code == 200 and response.json()['results'][0]['result']['price'] == result['results'][0]['result']['price']
    assert client.get('/api/workbenches/sales/calculator/saved').status_code == 200
    saved = calculator.save(SavedInput(kind='workspace', name='比较方案', payload=body.model_dump()), actor)
    assert saved['payload']['source']['kind'] == 'snapshot'
    assert saved['payload']['source']['cost'] == product['latest_cost']
    template = calculator.save(SavedInput(kind='template', name='基础公式', payload={'mode': 'domestic_direct', 'steps': []}), actor)
    unnamed = calculator.save(SavedInput(kind='workspace', payload=body.model_dump()), actor)
    assert unnamed['id'] != saved['id'] and unnamed['name'].startswith(product['code'])
    assert len(calculator.list_saved(actor)['saved']) == 3
    viewer = dict(actor, is_system_admin=False, scope_levels={'sales': 2})
    assert calculator.evaluate(body, viewer)['results'][0]['error'] is None
    with pytest.raises(PermissionError):
        calculator.save(SavedInput(kind='workspace', name='无权限', payload=body.model_dump()), viewer)
    with pytest.raises(RuntimeError, match='已更新'):
        calculator.save(SavedInput(kind='workspace', name='过期版本', payload=body.model_dump(), revision=2), actor, saved['id'])
    other = dict(actor, id='another-account')
    assert calculator.list_saved(other)['saved'] == []
    with pytest.raises(KeyError):
        calculator.delete(saved['id'], other)
    calculator.delete(saved['id'], actor)
    calculator.delete(unnamed['id'], actor)
    calculator.delete(template['id'], actor)
    assert calculator.list_saved(actor)['saved'] == []
    manual = body.model_dump()
    manual['source'] = {'kind': 'manual', 'cost': '4'}
    response = client.post('/api/workbenches/sales/calculator/evaluate', json=manual)
    assert response.status_code == 200 and response.json()['results'][0]['result']['price'] == '4.00'
    manual_saved = calculator.save(SavedInput(kind='workspace', name='手工成本试算', payload=manual), actor)
    assert manual_saved['payload']['source']['kind'] == 'manual'
    calculator.delete(manual_saved['id'], actor)
    with transaction(store.url) as db:
        formal_after = {name: evidence for name, evidence in _table_evidence(db).items()
                        if name.startswith(('sales_', 'procurement_', 'research_')) and name != 'sales_calculator_saved'}
    assert formal_after == formal_before


def test_catalog_is_whitelisted_and_composite_uses_research(sales):
    catalog = sales[2].products(sales[3])['products']
    composite = next(p for p in catalog if p['code'] == 'CF401B')
    assert composite['id'] == 'research:' + DEFAULT_COMPOSITE
    assert composite['special_allocation'] and composite['latest_cost'].endswith('5678')
    assert all(set(p) == {'id', 'code', 'name', 'source', 'department', 'latest_cost', 'inventory_cost', 'status', 'special_allocation', 'source_version', 'source_label', 'source_date'} for p in catalog)
    batch = prepared(sales, product=composite['id'])
    assert adopt(sales, batch)['items'][0]['adopted']


def test_frozen_snapshots_revision_void_code_and_copy(sales):
    _, _, store, actor = sales
    batch = adopt(sales, prepared(sales))
    first = store.history(actor, True)['records'][0]
    with pytest.raises(RuntimeError, match='重复采用'):
        adopt(sales, batch)
    with pytest.raises(RuntimeError, match='更新'):
        store.customer_code(batch['id'], {'revision': 1, 'customer_code': 'K001'}, actor)
    batch = store.customer_code(batch['id'], {'revision': batch['revision'], 'customer_code': 'K001'}, actor)['batch']
    assert not batch['adjusted']
    record = store.history(actor, True)['records'][0]
    assert record['customer_code'] == '' and record['current_customer_code'] == 'K001'
    trial = store.history(actor)['trials'][0]
    assert (trial['customer_name'], trial['customer_code'], trial['uncoded'], trial['salesperson']) == ('客户甲', '', True, '销售甲')
    batch = store.revise(batch['id'], dict(revision=batch['revision'], product_ids=['research:recipe:Q'], reason='客户议价'), actor)['batch']
    assert store.history(actor, True)['records'][0]['item']['final_price'] == first['item']['final_price']
    batch['items'][0].update(final_price='7', pricing_reasons=['客户议价'])
    batch = save(sales, batch)
    batch = store.trial(batch['id'], dict(revision=batch['revision'], product_ids=['research:recipe:Q'], confirm_manual_prices=True), actor)['batch']
    batch = adopt(sales, batch)
    assert batch['adjusted'] and batch['items'][0]['record_version'] == 2
    assert {r['status'] for r in store.history(actor, True)['records']} == {'active', 'superseded'}
    batch = store.void(batch['id'], dict(revision=batch['revision'], product_ids=['research:recipe:Q'], reason='取消询价'), actor)['batch']
    assert not any(r['status'] == 'active' for r in store.history(actor, True)['records'])
    copied = store.create(dict(name='新询价', mode=batch['mode'], copy_from=batch['id']), actor)['batch']
    assert copied['id'] != batch['id'] and copied['items'][0]['result'] is None and not copied['items'][0]['adopted']
    assert len(store.history(actor)['trials']) == 2


def test_server_ignores_forged_amounts_and_defaults_follow_basis(sales):
    batch = new(sales)
    batch = save(sales, batch, items=[dict(product_id='research:recipe:Q', cost='0', product={'latest_cost': '0'}, result={'normal_price': '0'}, trial_id='fake')])
    assert batch['items'][0]['cost'] == '4' and batch['items'][0]['result'] is None
    batch['items'][0]['cost_basis'] = 'inventory'
    batch = save(sales, batch)
    assert batch['items'][0]['cost'] == '12' and batch['items'][0]['parameters']['allocation'] == '1.2'
    batch = save(sales, batch, mode='domestic_intermediary')
    assert batch['items'][0]['parameters']['tax'] == '1.09' and batch['items'][0]['parameters']['reverse'] == '1.04'
    batch['items'][0]['parameters']['allocation'] = '1.8'
    batch['items'][0]['cost_basis'] = 'latest'
    batch = save(sales, batch)
    assert batch['items'][0]['parameters']['allocation'] == '1.8'


def test_stale_cost_requires_explicit_choice_and_refresh(sales):
    settings, _, store, actor = sales
    batch = prepared(sales)
    with transaction(settings.database_url, write=True) as db:
        db.execute('INSERT INTO research_cost_records(event_id,product_id,signature,payload) VALUES(%s,%s,%s,%s)',
                   ('new', 'recipe:Q', 'new', packed(dict(latest_cost='12', inventory_cost='12', status='ready'))))
    with pytest.raises(RuntimeError, match='成本'):
        adopt(sales, batch)
    batch = adopt(sales, batch, keep_stale_cost=True)
    assert store.history(actor, True)['records'][0]['kept_stale_cost']
    copied = store.create(dict(name='复制', mode='domestic_direct', copy_from=batch['id']), actor)['batch']
    assert copied['items'][0]['cost'] == '12' and copied['items'][0]['parameters']['allocation'] == '1.2'


def test_manual_price_reason_reconfirm_and_break_even(sales):
    _, _, store, actor = sales
    batch = prepared(sales)
    batch['items'][0]['final_price'] = '1'
    batch = save(sales, batch)
    with pytest.raises(ValueError, match='重新测算'):
        adopt(sales, batch)
    batch = store.trial(batch['id'], dict(revision=batch['revision'], product_ids=['research:recipe:Q']), actor)['batch']
    with pytest.raises(ValueError, match='手动报价'):
        adopt(sales, batch)
    batch = store.trial(batch['id'], dict(revision=batch['revision'], product_ids=['research:recipe:Q'], confirm_manual_prices=True), actor)['batch']
    with pytest.raises(ValueError, match='定价依据'):
        adopt(sales, batch, confirm_below_break_even=True)
    batch['items'][0]['pricing_reasons'] = ['客户议价']
    batch = save(sales, batch)
    batch = store.trial(batch['id'], dict(revision=batch['revision'], product_ids=['research:recipe:Q'], confirm_manual_prices=True), actor)['batch']
    with pytest.raises(ValueError, match='盈亏平衡'):
        adopt(sales, batch)
    assert adopt(sales, batch, confirm_below_break_even=True)['items'][0]['final_price'] == '1.00'


def test_partial_adoption_missing_cost_and_unadopted_edits(sales):
    settings, _, store, actor = sales
    batch = prepared(sales)
    items = batch['items'] + [dict(product_id='research:' + DEFAULT_COMPOSITE)]
    batch = save(sales, batch, items=items)
    batch = store.adopt(batch['id'], dict(revision=batch['revision'], product_ids=['research:recipe:Q']), actor)['batch']
    batch['items'][1]['parameters']['allocation'] = '.8'
    batch = save(sales, batch)
    assert batch['items'][1]['adjustment_reason'] is None
    with transaction(settings.database_url, write=True) as db:
        db.execute("UPDATE research_cost_records SET payload=%s WHERE product_id=%s", (packed(dict(latest_cost=None, inventory_cost=None, status='missing')), DEFAULT_COMPOSITE))
    with pytest.raises(ValueError, match='缺少'):
        store.trial(batch['id'], dict(revision=batch['revision'], product_ids=['research:' + DEFAULT_COMPOSITE], refresh_costs=True), actor)
    assert store.detail(batch['id'], actor)['batch'] == batch


def test_quote_products_can_be_added_and_pending_removed_without_deleting_adopted(sales):
    batch = prepared(sales)
    second = 'research:' + DEFAULT_COMPOSITE
    batch = save(sales, batch, items=batch['items'] + [dict(product_id=second)])
    assert len(batch['items']) == 2
    batch = save(sales, batch, items=batch['items'][:1])
    assert [item['product_id'] for item in batch['items']] == ['research:recipe:Q']
    batch = adopt(sales, batch)
    with pytest.raises(ValueError, match='已采用产品不能删除'):
        save(sales, batch, items=[])
    batch = save(sales, batch, items=batch['items'] + [dict(product_id=second)])
    batch = save(sales, batch, items=batch['items'][:1])
    assert len(batch['items']) == 1 and batch['items'][0]['adopted']


def test_http_and_store_authorization_and_mode(sales):
    settings, client, store, actor = sales
    batch = prepared(sales)
    other = dict(id='other', is_system_admin=False, scope_levels={'sales': 4})
    with pytest.raises(PermissionError, match='自己'):
        store.detail(batch['id'], other)
    editor = dict(actor, is_system_admin=False, scope_levels={'sales': 3})
    with pytest.raises(PermissionError):
        store.adopt(batch['id'], dict(revision=batch['revision'], product_ids=['research:recipe:Q']), editor)
    assert store.batches(other) == {'batches': []}
    assert store.history(other) == {'trials': []}
    assert store.history(other, True) == {'records': []}
    response = client.get('/api/workbenches/sales/products')
    assert response.status_code == 200
    settings.workbench_modes['sales'] = 'prototype'
    assert client.get('/api/workbenches/sales/products').status_code == 404


def test_cost_fallback_and_zero_sources():
    source = dict(status='ready', source='research', latest_cost='0', inventory_cost='12')
    assert SalesStore._cost(source, 'latest') == ('0', 'latest')
    source.update(source='procurement', latest_cost=None, inventory_cost='12')
    assert SalesStore._cost(source, 'latest') == ('12', 'inventory')
    source.update(latest_cost='5', inventory_cost='0')
    assert SalesStore._cost(source, 'inventory') == ('5', 'latest')
    source.update(status='updating')
    assert SalesStore._cost(source, 'latest') == (None, None)
    source.update(source='research', status='missing', latest_cost=None, inventory_cost='5')
    assert SalesStore._cost(source, 'latest') == ('5', 'inventory')


def test_http_scope_owner_and_revoked_session(sales):
    settings, client, store, admin = sales
    prefix = '/api/workbenches/sales'
    identities = IdentityStore(settings.database_url)
    password = 'Quotation-Password-2026'
    users = {}
    for name, scopes in [('sales-manager', {'sales': 4}), ('sales-other', {'sales': 4}), ('sales-editor', {'sales': 3}), ('other-scope', {'procurement': 4})]:
        users[name] = identities.create_user(username=name, display_name=name, department=None, password=password, scope_levels=scopes)
    client.post('/api/logout')
    assert client.get(prefix + '/products').status_code == 401
    assert client.post(prefix + '/batches', json={'name': '匿名', 'mode': 'domestic_direct'}).status_code == 401

    def login(name):
        client.post('/api/logout')
        assert client.post('/api/login', json={'username': name, 'password': password}).status_code == 200

    login('other-scope')
    assert client.get(prefix + '/products').status_code == 403
    assert client.post(prefix + '/batches', json={'name': '越权', 'mode': 'domestic_direct'}).status_code == 403
    login('sales-manager')
    batch = client.post(prefix + '/batches', json={'name': '经理报价', 'mode': 'domestic_direct'}).json()['batch']
    key = prefix + '/batches/' + batch['id']
    draft = {field: deepcopy(batch[field]) for field in ('revision', 'name', 'mode', 'customer_name', 'customer_code', 'uncoded', 'salesperson', 'items')}
    draft.update(customer_name='客户', salesperson='业务员', uncoded=True, items=[{'product_id': 'research:recipe:Q'}])
    assert client.put(key + '/draft', json=draft).status_code == 200
    batch = client.get(key).json()['batch']
    body = {'revision': batch['revision'], 'product_ids': ['research:recipe:Q']}
    login('sales-other')
    assert client.get(key).status_code == 403
    assert client.put(key + '/draft', json=draft).status_code == 403
    for action in ('calculate', 'adopt', 'revise', 'void'):
        assert client.post(key + '/' + action, json=dict(body, **({'reason': '测试'} if action in ('revise', 'void') else {}))).status_code == 403
    assert client.get(prefix + '/batches').json()['batches'] == []
    assert client.get(prefix + '/history').json()['trials'] == []
    assert client.get(prefix + '/records').json()['records'] == []
    login('sales-editor')
    own = client.post(prefix + '/batches', json={'name': '编辑草稿'}).json()['batch']
    assert client.post(prefix + '/batches/' + own['id'] + '/adopt', json={'revision': own['revision'], 'product_ids': ['research:recipe:Q']}).status_code == 403
    login('sales-manager')
    assert client.get(key).status_code == 200
    identities.update_user(users['sales-manager']['id'], scope_levels={'procurement': 2})
    # Permission changes revoke the existing session before the next write.
    assert client.get(key).status_code == 401
    assert client.post(key + '/calculate', json=body).status_code == 401
    login('sales-manager')
    assert client.get(key).status_code == 403
    assert store.detail(batch['id'], admin)['batch']['revision'] == batch['revision']


def test_concurrent_adoption_same_revision_has_one_winner(sales):
    _, _, store, actor = sales
    batch = prepared(sales)
    barrier = Barrier(2)

    def submit():
        barrier.wait(timeout=10)
        try:
            adopt(sales, batch)
            return 'adopted'
        except RuntimeError:
            return 'conflict'

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: submit(), range(2)))
    assert sorted(results) == ['adopted', 'conflict']
    records = store.history(actor, True)['records']
    assert len(records) == 1 and records[0]['version'] == 1 and records[0]['status'] == 'active'
    assert store.detail(batch['id'], actor)['batch']['revision'] == batch['revision'] + 1


def test_restart_sales_modes_preserves_all_data(tmp_path):
    settings = procurement_settings(tmp_path)
    settings.workbench_modes['sales'] = 'active'
    prefix = '/api/workbenches/sales'
    with authenticated_client(settings) as client:
        with transaction(settings.database_url, write=True) as db:
            admin_id = db.execute("SELECT id FROM identity_users WHERE username='test-admin'").fetchone()[0]
            db.execute("INSERT INTO research_formulas(id,formula,lifecycle,position,revision) VALUES('recipe:Q',%s,'active',0,1)", (packed(dict(id='recipe:Q', name='Q', kind='recipe', revision=1)),))
            db.execute("INSERT INTO research_cost_records(event_id,product_id,signature,payload) VALUES('restart','recipe:Q','restart',%s)", (packed(dict(latest_cost='4', inventory_cost='12', status='ready')),))
        actor = dict(id=admin_id, is_system_admin=True, scope_levels={})
        context = settings, client, SalesStore(settings.database_url), actor
        batch = adopt(context, prepared(context))
        expected_batch = context[2].detail(batch['id'], actor)
        expected_trials = context[2].history(actor)
        expected_records = context[2].history(actor, True)
    for mode in ('prototype', 'off', 'active'):
        settings.workbench_modes['sales'] = mode
        with authenticated_client(settings) as client:
            response = client.get(prefix + '/batches/' + batch['id'])
            assert response.status_code == (200 if mode == 'active' else 404)
            if mode != 'active':
                assert client.post(prefix + '/batches', json={'name': '禁用测试'}).status_code == 404
            else:
                assert response.json() == expected_batch
                assert client.get(prefix + '/history').json() == expected_trials
                assert client.get(prefix + '/records').json() == expected_records


def test_snapshot_restore_preserves_sales_tables(sales, tmp_path, second_pg):
    from api.operations import _table_evidence, create_snapshot, restore_snapshot, verify_snapshot
    from api.settings import Settings

    settings, _, store, actor = sales
    batch = adopt(sales, prepared(sales))
    store.customer_code(batch['id'], {'revision': batch['revision'], 'customer_code': 'K8065'}, actor)
    with transaction(settings.database_url) as db:
        before = {name: evidence for name, evidence in _table_evidence(db).items() if name.startswith('sales_')}
    assert set(before) == {'sales_batches', 'sales_trials', 'sales_records', 'sales_events', 'sales_calculator_saved'}
    assert all(evidence['count'] > 0 for name, evidence in before.items() if name != 'sales_calculator_saved')
    snapshot = create_snapshot(settings, tmp_path / 'sales-snapshots')
    manifest = verify_snapshot(snapshot)
    assert {name: manifest['tables'][name] for name in before} == before
    target = Settings.from_data_dir(tmp_path / 'sales-restored', database_url=second_pg['migration_url'])
    restore_snapshot(target, snapshot)
    with transaction(second_pg['url']) as db:
        restored = {name: evidence for name, evidence in _table_evidence(db).items() if name.startswith('sales_')}
    assert restored == before
