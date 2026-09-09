from tests.helpers import authenticated_client
from tests.test_procurement_workbench import procurement_settings
from tests.test_procurement_isolation import import_prices, publish
from tests.test_procurement_bulk import payload, snapshot, URL

ROOT = '/api/workbenches/procurement'


def confirmation(client, items, day='2026-09-02'):
    result = procurement_post(client,ROOT + '/prices/preview-adjustments', json={'effective_date': day, 'items': items})
    assert result.status_code == 200, result.text
    data = result.json()
    return {'baseline_id': data['baseline_id'], 'references': {row['material_id']: row['reference_price'] for row in data['rows']}}


def test_confirmed_bulk_is_atomic_and_ready_to_publish(tmp_path):
    settings = procurement_settings(tmp_path)
    with authenticated_client(settings) as client:
        base = import_prices(client, '2026-09-01', [('A', 10), ('B', 10)])
        assert publish(client, base).status_code == 200
        a, b = [item['material_id'] for item in base['input_items']]
        items = [{'material_id': a, 'price': '20'}, {'material_id': b, 'price': '0'}]
        checked = confirmation(client, items)
        before = snapshot(settings.database_path)
        for bad in [{**checked, 'baseline_id': 'old'}, {**checked, 'references': {a: '9', b: '10'}}, {**checked, 'references': {a: '10'}}]:
            assert procurement_post(client,URL, json={**payload(None, items), 'price_confirmation': bad}).status_code == 409
            assert snapshot(settings.database_path) == before
        result = procurement_post(client,URL, json={**payload(None, items), 'price_confirmation': checked})
        assert result.status_code == 200, result.text
        current = result.json()['current_update']
        assert current['summary']['risk_count'] == 0
        assert all(issue['status'] == 'reviewed' and issue['review_reason'] == '供应商最新报价' for issue in current['issues'])
        assert len([event for event in current['events'] if event['event'] == 'risk_reviewed']) == 2
        assert all(item['published_price'] == '10' for item in result.json()['materials'])
        assert publish(client, current).status_code == 200


def test_single_save_confirmation_and_later_unconfirmed_change(tmp_path):
    with authenticated_client(procurement_settings(tmp_path)) as client:
        base = import_prices(client, '2026-09-01', [('A', 10)])
        assert publish(client, base).status_code == 200
        a = base['input_items'][0]['material_id']
        checked = confirmation(client, [{'material_id': a, 'price': '20'}])
        request = {'price': '20', 'effective_date': '2026-09-02', 'reason': '供应商最新报价', 'price_confirmation': checked}
        assert procurement_post(client,f'{ROOT}/materials/{a}/adjustments', json=request).status_code == 201
        current = client.get(ROOT + '/updates/current').json()['current']
        assert current['summary']['risk_count'] == 0
        # Legacy callers never acquire an implicit confirmation.
        assert procurement_post(client,f'{ROOT}/materials/{a}/adjustments', json={key: value for key, value in {**request, 'price': '25'}.items() if key != 'price_confirmation'}).status_code == 201
        current = client.get(ROOT + '/updates/current').json()['current']
        assert current['summary']['risk_count'] == 1
        assert publish(client, current).status_code == 409


def test_import_confirmation_keeps_missing_price_blocker(tmp_path):
    with authenticated_client(procurement_settings(tmp_path)) as client:
        base = import_prices(client, '2026-09-01', [('A', 10), ('B', 10)])
        assert publish(client, base).status_code == 200
        request = {'source_name': '供应商价格报表', 'effective_date': '2026-09-02', 'content': '编号,名称,单位,最新价\nA,A,kg,20\nB,B,kg,', 'reason': '供应商最新报价'}
        preview = procurement_post(client,ROOT + '/import-preview', json=request).json()
        assert preview['rows'][0]['reference_price'] == '10'
        assert preview['rows'][0]['change'] == 1
        checked = {'baseline_id': preview['baseline_id'], 'references': {row['code']: row['reference_price'] for row in preview['rows'] if row['importable']}}
        result = procurement_post(client,ROOT + '/imports', json={**request, 'price_confirmation': checked})
        assert result.status_code == 201, result.text
        current = client.get(ROOT + '/updates/current').json()['current']
        assert current['summary']['risk_count'] == 0
        assert current['summary']['error_count'] == 0
        assert publish(client, current).status_code == 200
        assert {m['code']: m['published_price'] for m in client.get(ROOT + '/overview').json()['materials']} == {'A': '20', 'B': '10'}
from tests.procurement_helpers import procurement_post
