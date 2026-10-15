"""Verified ERP pricing boundaries and legacy/frozen record compatibility."""
from copy import deepcopy
from decimal import Decimal
import json
import subprocess
from io import BytesIO

import pytest

from api.postgres import transaction
from api.research import capture, enqueue, packed, signature
from api.research_formulas import calculate, input_number
from api.sales import SalesStore
from openpyxl import load_workbook
from tests.test_procurement_rd5 import data, trial_data
from tests.test_research_workbench import ready, body_for, K, records


def recipe(key, lines, **fields):
    return dict(id=key, name=key, kind="recipe", owner="合成负责人", source_kind="erp_bom",
                **{"yield": "1"}, lines=[dict(kind="material", ref=c, code=c, quantity=q, source_row=None) for c,q in lines], **fields)


def test_concentration_recovery_fallback_and_legacy_boundaries():
    child = recipe("recipe:FH002", [("missing", "1")])
    parent = recipe("parent", [("CF232", "100"), ("回收CF232", "-10")])
    diluted = recipe("diluted", [("CF232A", "100")])
    fallback = recipe("fallback", [])
    fallback["lines"] = [dict(kind="recipe", ref=child["id"], code="FH002", quantity="1", source_row=None)]
    legacy = deepcopy(diluted)
    legacy.update(id="legacy", source_kind=None)
    graph = [child,parent,diluted,fallback,legacy]
    prices = {"CF232": {"latest_price": "10", "inventory_price": "6"}, "CF232A": {"latest_price": "99", "inventory_price": "88"}, "FH002": {"inventory_price": "4"}}
    package = {"recipes": graph, "materials": []}
    for policy, base, old in (("latest",Decimal(10),"99"),("inventory",Decimal(6),"88")):
        result = calculate(package,prices,price_policy=policy)
        assert result["parent"]["total_input"] == "90"
        assert Decimal(result["parent"]["cost"]) == (100*base-10*base*Decimal(".9"))/90
        assert Decimal(result["diluted"]["cost"]) == base*Decimal(".25")
        assert result["legacy"]["cost"] == old
        assert result["fallback"]["cost"] == "4" and result["fallback"]["missing_materials"] == []
        assert result["fallback"]["lines"][0]["basis"] == "erp_inventory_fallback"
    inputs = {"package":package,"prices":prices}
    results = {p:calculate(package,prices,price_policy=p) for p in ("latest","inventory")}
    before = signature(inputs,results,"fallback")
    prices["FH002"]["inventory_price"] = "5"
    after = {p:calculate(package,prices,price_policy=p) for p in ("latest","inventory")}
    assert signature(inputs,after,"fallback") != before
    for line in ({"kind":"material","ref":"CF232"},{"kind":"recipe","ref":"CF232D"}):
        with pytest.raises(ValueError):
            input_number("-1",line,"投料")
    with pytest.raises(ValueError):
        input_number("NaN",{"kind":"material","ref":"回收CF232"},"投料")
    cycle = recipe("cycle", [])
    cycle["lines"] = [dict(kind="recipe",ref="cycle",code="FH002",quantity="1",source_row=None)]
    with pytest.raises(ValueError,match="循环引用"):
        calculate({"recipes":[cycle], "materials": []},prices)

    identified = recipe("recipe:A-109", [("missing", "1")])
    buyer = recipe("buyer", [])
    buyer["lines"] = [dict(kind="recipe", ref=identified["id"], code="A-109", quantity="1", source_row=None)]
    identified_package = {"recipes": [identified, buyer], "materials": []}
    identified_prices = {"A-109": {"latest_price": "99", "inventory_price": "8"}}
    assert calculate(identified_package, identified_prices)["buyer"]["cost"] is None
    identified_package["current_policy"] = {"erp_inventory_fallback_codes": ["A-109"]}
    for policy in ("latest", "inventory"):
        result = calculate(identified_package, identified_prices, price_policy=policy)
        assert result["buyer"]["cost"] == "8"
        assert result["buyer"]["lines"][0]["basis"] == "erp_inventory_fallback"
    identified_prices["missing"] = {"latest_price": "2", "inventory_price": "3"}
    assert calculate(identified_package, identified_prices)["buyer"]["cost"] == "2"
    assert calculate(identified_package, identified_prices, price_policy="inventory")["buyer"]["cost"] == "3"
    identified["lines"] = [dict(kind="recipe", ref=identified["id"], code="A-109", quantity="1", source_row=None)]
    with pytest.raises(ValueError, match="循环引用"):
        calculate(identified_package, identified_prices)

    blend = recipe("blend", [("finished", "1"), ("raw", "1")])
    blend["lines"][0]["inventory_input"] = True
    adjusted = recipe("adjusted", [("纯水", "2")])
    adjusted["lines"].append(dict(kind="recipe", ref="blend", code="blend", quantity="2", source_row=3))
    blending_package = {"recipes": [blend, adjusted], "materials": []}
    blending_prices = {"finished": {"latest_price": "99", "inventory_price": "8"},
                       "raw": {"latest_price": "10", "inventory_price": "2"}, "纯水": {"latest_price": "0"}}
    for policy, expected in (("latest", "4.5"), ("inventory", "2.5")):
        result = calculate(blending_package, blending_prices, price_policy=policy)
        assert result["blend"]["lines"][0]["unit_cost"] == "8"
        assert result["blend"]["lines"][0]["basis"] == "inventory"
        assert result["adjusted"]["cost"] == expected
        assert result["adjusted"]["lines"][1]["basis"] == "recipe"
    blending_prices["finished"]["inventory_price"] = None
    assert calculate(blending_package, blending_prices)["adjusted"]["missing_materials"] == ["finished"]
    blend["source_kind"] = None
    assert calculate(blending_package, blending_prices)["blend"]["lines"][0]["unit_cost"] == "99"


def test_inventory_price_review_propagates_without_fallback_or_zero():
    def recipe(code, lines, **extra):
        return dict(id=code, name=code, kind='recipe', source_kind='erp_bom', **extra, lines=lines, **{'yield': '1'})
    def line(ref, kind='material', **extra):
        return dict(code=ref, ref=ref, kind=kind, quantity='1', source_row=1, **extra)
    child = recipe('child', [line('CF003')])
    parent = recipe('parent', [line('child', 'recipe')], manual_costs={'inventory': '3'})
    mean = recipe('mean', [line('blend', price_refs=['CF003', 'other'])])
    zero = recipe('zero', [line('CF003', unpriced_cost_zero=True)])
    blend = recipe('stock', [line('CF003', inventory_input=True)])
    package = {'materials': [], 'recipes': [child, parent, mean, zero, blend], 'current_policy': {'erp_inventory_fallback_codes': ['child']}}
    prices = {'CF003': {'latest_price': '9', 'inventory_price': '718.6', 'inventory_price_pending_review': True},
              'child': {'inventory_price': '2'}, 'other': {'latest_price': '7', 'inventory_price': '7'}}
    results = calculate(package, prices, price_policy='inventory')
    assert all(r['cost'] is None and r['price_review_pending'] == ['CF003'] for r in results.values())
    assert results['parent']['lines'][0]['basis'] == 'recipe'
    assert results['parent']['manual_cost'] == '3'
    from api.research import signature
    inputs = {'package': package}
    held_signature = signature(inputs, {'latest': calculate(package, prices), 'inventory': results}, 'parent', include_basis=False)
    missing_prices = {c: dict(v) for c, v in prices.items()}
    missing_prices['CF003'] = {'latest_price': '9', 'inventory_price': None}
    missing_prices['child']['inventory_price'] = None
    missing_results = {p: calculate(package, missing_prices, price_policy=p) for p in ('latest', 'inventory')}
    assert held_signature != signature(inputs, missing_results, 'parent', include_basis=False)
    assert calculate(package, prices)['parent']['cost'] == '9'
    assert calculate(package, prices)['mean']['cost'] == '8'
    pending_without_value = {c: dict(v) for c, v in prices.items()}
    pending_without_value['CF003']['inventory_price'] = None
    assert calculate(package, pending_without_value, price_policy='inventory')['parent']['cost'] is None
    child['lines'].append(line('other'))
    child['lines'][0]['quantity'] = '0'
    clean = calculate(package, prices, price_policy='inventory')['child']
    assert clean['cost'] == '7' and 'price_review_pending' not in clean
    prices['CF003'].pop('inventory_price_pending_review')
    child['lines'][0]['quantity'] = '1'
    child['lines'].pop()
    assert calculate(package, prices, price_policy='inventory')['child']['cost'] == '718.6'


def test_imported_department_negative_edit_and_frozen_history(ready):
    settings, client, admin, store = ready
    frozen = records(store.url)
    with transaction(store.url,write=True) as db:
        metadata = json.loads(db.execute("SELECT payload FROM research_meta WHERE id=1").fetchone()[0])
        metadata["erp_inventory_fallback_codes"] = ["CF232"]
        db.execute("UPDATE research_meta SET payload=%s WHERE id=1", (packed(metadata),))
        assert capture(db)["package"]["current_policy"]["erp_inventory_fallback_codes"] == ["CF232"]
        for code in ("CF232","回收CF232"):
            db.execute("INSERT INTO procurement_materials(id,code,name,unit,updated_at) VALUES(%s,%s,%s,'kg','2026-10-06T00:00:00Z')",(code,code,code))
            db.execute("INSERT INTO procurement_inventory(material_id,quantity,price,raw_price,source_sha256,sheet,source_row,imported_by,imported_at) VALUES(%s,'100','6','6','synthetic','Sheet',2,%s,'2026-10-06T00:00:00Z')",(code,admin))
        formula = next(r for r in store.detail(K)["recipes"] if r["id"] == K)
        formula.update(source_kind="erp_bom",department="研发一部",yield_source={"kind":"mes_mean","count":2})
        formula["yield"] = "1"
        formula["lines"] = [dict(kind="material",ref=code,code=code,quantity=qty,source_row=None) for code,qty in (("CF232","100"),("回收CF232","-10"))]
        db.execute("UPDATE research_formulas SET formula=%s WHERE id=%s",(packed(formula),K))
        enqueue(db,"合成ERP导入")
    store.process_events()
    assert records(store.url)[:len(frozen)] == frozen
    detail = store.detail(K)
    assert detail["product"]["department"] == "研发一部"
    assert "CF232" in {r["code"] for r in detail["options"]["materials"]}
    body = body_for(store)
    body["formula"]["lines"][1].update(quantity="-20",ratio="-5")
    trial = store.simulate(K,body)
    assert trial["latest"]["total_input"] == "80"
    assert Decimal(trial["latest"]["cost"]) == Decimal("6.15")
    assert records(store.url)[:len(frozen)] == frozen
    assert client.get('/api/workbenches/research/products').status_code == 200


def test_browser_research_import():
    result = subprocess.run(['node','scripts/check-research-import.mjs'],capture_output=True,text=True,encoding='utf-8',timeout=120)
    assert result.returncode == 0, result.stdout + result.stderr


def test_imported_reference_scope_edit_export_and_sales_department(ready):
    _, client, admin, store = ready
    frozen = records(store.url)
    with transaction(store.url, write=True) as db:
        for code, price in (('REF-A', '6'), ('REF-B', '8'), ('UNUSED-REF', '9')):
            db.execute("INSERT INTO procurement_materials(id,code,name,unit,updated_at) VALUES(%s,%s,%s,'kg','2026-10-08T00:00:00Z')", (code, code, code))
            db.execute("INSERT INTO procurement_inventory(material_id,quantity,price,raw_price,source_sha256,sheet,source_row,imported_by,imported_at) VALUES(%s,'100',%s,%s,'synthetic','Sheet',2,%s,'2026-10-08T00:00:00Z')", (code, price, price, admin))
        formula = next(r for r in store.detail(K)['recipes'] if r['id'] == K)
        formula.update({'source_kind': 'erp_bom', 'department': '研发一部', 'yield': '1', 'yield_source': {'kind': 'user_confirmed', 'count': 2},
                        'lines': [dict(kind='material', ref='A', code='A', quantity='1', source_row=9001, price_refs=['REF-A', 'REF-B'])]})
        db.execute('UPDATE research_formulas SET formula=%s WHERE id=%s', (packed(formula), K))
        enqueue(db, '合成参考取价候选')
    store.process_events()
    assert records(store.url)[:len(frozen)] == frozen
    scope = {r['code']: r['in_formula_scope'] for r in store.material_prices()['materials']}
    assert scope['REF-A'] and scope['REF-B'] and not scope['UNUSED-REF']
    body = body_for(store)
    body['formula']['lines'][0].update(quantity='2', price_refs=['UNUSED-REF', 'REF-A'])
    response = client.post('/api/workbenches/research/products/' + K + '/simulate', json=body)
    assert response.status_code == 200, response.text
    trial = response.json()
    assert trial['formula']['lines'][0]['price_refs'] == ['REF-A', 'REF-B']
    assert trial['latest']['cost'] == trial['inventory']['cost'] == '7'
    assert trial['formula']['yield_source']['kind'] == 'user_confirmed'
    body['formula']['yield'] = '0.8'
    adjusted = client.post('/api/workbenches/research/products/' + K + '/simulate', json=body)
    assert adjusted.status_code == 200, adjusted.text
    assert adjusted.json()['formula']['yield_source'] == {'kind': 'manual_edit'}
    assert adjusted.json()['latest']['cost'] == '8.75'
    book = load_workbook(BytesIO(client.get('/api/workbenches/research/products/export').content), data_only=False)
    assert any('参考原料有价算术平均 · REF-A／REF-B（2/2有价）' == cell.value for sheet in book for row in sheet for cell in row)
    catalog = SalesStore(store.url).products({'id': admin, 'is_system_admin': True})['products']
    current = next(p for p in catalog if p['id'] == 'research:' + K)
    assert current['department'] == '研发一部' and current['latest_cost'] == current['inventory_cost'] == '7'
    assert any(p['department'] == '研发五部' for p in catalog if p['source'] == 'research' and p['id'] != 'research:' + K)
    with transaction(store.url, write=True) as db:
        formula['yield'] = '1.1'
        db.execute('UPDATE research_formulas SET formula=%s WHERE id=%s', (packed(formula), K))
    body = body_for(store)
    assert store.simulate(K, body)['warnings'] == []
    body['formula']['yield'] = '1.2'
    assert store.simulate(K, body)['warnings']


def test_confirmed_unpriced_input_zero_and_price_recovery():
    formula = recipe('catalyst-example', [('raw', '10'), ('催化剂', '1')])
    formula['lines'][1]['unpriced_cost_zero'] = True
    package = {'recipes': [formula], 'materials': []}
    prices = {'raw': {'latest_price': '11', 'inventory_price': '22'}}
    for policy, expected in (('latest', '10'), ('inventory', '20')):
        result = calculate(package, prices, price_policy=policy)['catalyst-example']
        assert result['cost'] == expected and result['total_input'] == '11'
        assert result['missing_materials'] == []
        assert result['lines'][1]['unit_cost'] == result['lines'][1]['amount'] == '0'
        assert result['lines'][1]['basis'] == 'unpriced_zero_assumption'
    prices['催化剂'] = {'latest_price': '33', 'inventory_price': '44'}
    assert calculate(package, prices)['catalyst-example']['cost'] == '13'
    assert calculate(package, prices, price_policy='inventory')['catalyst-example']['cost'] == '24'
    prices.pop('催化剂')
    formula['manual_costs'] = {'latest': '123', 'inventory': '456'}
    assert calculate(package, prices)['catalyst-example']['cost'] == '123'
    assert calculate(package, prices, price_policy='inventory')['catalyst-example']['cost'] == '456'
    formula.pop('manual_costs')
    formula['source_kind'] = None
    assert calculate(package, prices)['catalyst-example']['missing_materials'] == ['催化剂']
    formula['source_kind'] = 'erp_bom'
    formula['lines'][1].pop('unpriced_cost_zero')
    assert calculate(package, prices)['catalyst-example']['missing_materials'] == ['催化剂']


def test_confirmed_price_reference_preserves_material_identity_and_signature():
    formula = recipe('price-reference', [('CF001B', '1')])
    formula['lines'][0]['price_ref'] = 'CF001'
    package = {'recipes': [formula], 'materials': []}
    prices = {'CF001B': {'latest_price': '99'}, 'CF001': {'latest_price': '10', 'inventory_price': '8'}}
    results = {p: calculate(package, prices, price_policy=p) for p in ('latest', 'inventory')}
    for p, expected in [('latest', '10'), ('inventory', '8')]:
        result = results[p]['price-reference']
        assert result['cost'] == expected
        assert result['lines'][0]['code'] == result['lines'][0]['ref'] == 'CF001B'
        assert result['lines'][0]['price_ref'] == 'CF001'
    before = signature({'package': package}, results, 'price-reference')
    prices['CF002'] = prices['CF001']
    formula['lines'][0]['price_ref'] = 'CF002'
    after = {p: calculate(package, prices, price_policy=p) for p in ('latest', 'inventory')}
    assert signature({'package': package}, after, 'price-reference') != before
    prices.pop('CF002')
    assert calculate(package, prices)['price-reference']['missing_materials'] == ['CF002']
    formula['source_kind'] = None
    assert calculate(package, prices)['price-reference']['cost'] == '99'


def test_confirmed_reference_mean_uses_available_prices_and_preserves_inputs():
    f = recipe('mean-reference', [('unpriced-original', '1')])
    f['lines'][0]['price_refs'] = ['A', 'B', 'missing']
    package = {'recipes': [f], 'materials': []}
    prices = {'A': {'latest_price': '10', 'inventory_price': '6'}, 'B': {'latest_price': '14', 'inventory_price': '8'}, 'unpriced-original': {'latest_price': '99'}}
    results = {p: calculate(package, prices, price_policy=p) for p in ('latest', 'inventory')}
    for p, expected in [('latest', '12'), ('inventory', '7')]:
        r = results[p]['mean-reference']
        assert r['cost'] == expected and r['missing_materials'] == []
        assert r['lines'][0]['ref'] == r['lines'][0]['code'] == 'unpriced-original'
        assert r['lines'][0]['basis'] == 'reference_mean'
        assert len([v for v in r['lines'][0]['price_reference_values'] if v['unit_cost'] is not None]) == 2
    before = signature({'package': package}, results, 'mean-reference', include_basis=False)
    prices['A']['latest_price'], prices['B']['latest_price'] = '11', '13'
    after = {p: calculate(package, prices, price_policy=p) for p in ('latest', 'inventory')}
    assert after['latest']['mean-reference']['cost'] == '12'
    assert signature({'package': package}, after, 'mean-reference', include_basis=False) != before
    f['lines'][0]['price_refs'] = ['A', 'missing']
    assert calculate(package, prices)['mean-reference']['cost'] == '11'
    f['lines'][0]['price_refs'] = ['absent', 'missing']
    r = calculate(package, prices)['mean-reference']
    assert r['cost'] is None and r['missing_materials'] == ['absent', 'missing']
    f['source_kind'] = None
    assert calculate(package, prices)['mean-reference']['cost'] == '99'
    f['source_kind'] = 'erp_bom'
    f['lines'][0]['price_refs'] = ['A', 'A']
    with pytest.raises(ValueError, match='清单无效'):
        calculate(package, prices)


def test_erp_inventory_mean_does_not_mix_unapproved_purchase_prices():
    f = recipe('erp-mean', [('original', '1')])
    f['lines'][0]['price_refs'] = ['A', 'B']
    prices = {'A': {'latest_price': '16.5', 'inventory_price': None}, 'B': {'inventory_price': '14.159292'}}
    package = {'recipes': [f], 'materials': []}
    result = calculate(package, prices, price_policy='inventory')['erp-mean']
    assert result['cost'] == '14.159292'
    assert result['lines'][0]['price_reference_values'][0]['unit_cost'] is None
    f['lines'] = [dict(kind='material',ref='A',code='A',quantity='1',source_row=None)]
    assert calculate(package, prices, price_policy='inventory')['erp-mean']['cost'] is None
    f['source_kind'] = None
    assert calculate(package, prices, price_policy='inventory')['erp-mean']['cost'] == '16.5'


def test_confirmed_inventory_price_is_separate_and_expires_on_next_import(ready):
    from api.procurement_inventory import inventory_snapshot
    _, _, admin, store = ready
    with transaction(store.url, write=True) as db:
        db.execute("INSERT INTO procurement_materials(id,code,name,unit,updated_at) VALUES('ERP-PRICE','ERP-PRICE','ERP-PRICE','kg','2026-10-12')")
        db.execute("INSERT INTO procurement_inventory(material_id,quantity,price,raw_price,source_sha256,sheet,source_row,imported_by,imported_at) VALUES('ERP-PRICE','1','718.6','718.6','batch-one','Sheet',29,%s,'2026-10-12')",(admin,))
        metadata=json.loads(db.execute('SELECT payload FROM research_meta WHERE id=1').fetchone()[0])
        metadata['inventory_price_overrides']={'ERP-PRICE':{'price':'7.186','basis':'confirmed_manual_inventory_price','source_sha256':'batch-one'}}
        db.execute('UPDATE research_meta SET payload=%s WHERE id=1',(packed(metadata),))
        price=capture(db)['prices']['ERP-PRICE']
        assert price['inventory_price']=='7.186' and price['ERP_inventory_price']=='718.6'
        assert db.execute("SELECT price,raw_price FROM procurement_inventory WHERE material_id='ERP-PRICE'").fetchone()==('718.6','718.6')
        db.execute("INSERT INTO procurement_material_sources(material_id,sheet,source_row,raw_json,sha256) VALUES('ERP-PRICE','ERP库存汇总',1,%s,'batch-one')",(packed(['','ERP-PRICE',{'source':'ERP 库存','as_of':'2026-10-07','evidence':{'单位成本':718.6}}]),))
        assert inventory_snapshot(db)['ERP-PRICE'] == ('1','718.6',{'source':'ERP 库存','as_of':'2026-10-07','imported_at':'2026-10-12'})
        db.execute("UPDATE procurement_inventory SET price='7.186' WHERE material_id='ERP-PRICE'")
        assert capture(db)['prices']['ERP-PRICE']['ERP_inventory_price']=='718.6'
        assert inventory_snapshot(db)['ERP-PRICE'][1]=='7.186'
        db.execute("UPDATE procurement_inventory SET source_sha256='batch-two',price='8' WHERE material_id='ERP-PRICE'")
        assert capture(db)['prices']['ERP-PRICE']=={'latest_price':None,'inventory_price':'8'}
        assert inventory_snapshot(db)['ERP-PRICE'] == ('1','8',None)
