from datetime import UTC, datetime, timedelta
from api.postgres import transaction
from fastapi.testclient import TestClient
from api.identity import IdentityStore
from api.main import create_app

from tests.helpers import authenticated_client
from tests.test_procurement_workbench import procurement_settings
from tests.test_procurement_isolation import import_prices, publish, confirm_risks


URL = '/api/workbenches/procurement/prices/bulk-adjustments'


def payload(current, items, day='2026-09-02'):
    return {'update_id': current['id'] if current else None,
            'updated_at': current['updated_at'] if current else None,
            'effective_date': day, 'reason': '供应商最新报价', 'items': items}


def snapshot(path):
    with transaction(path) as db:
        tables = ['procurement_updates', 'procurement_price_history', 'procurement_price_adjustments', 'procurement_update_events', 'procurement_update_items']
        return {table: db.execute(f'SELECT * FROM {table} ORDER BY _order').fetchall() for table in tables}


def test_bulk_atomic_new_draft_retry_and_zero(tmp_path):
    settings = procurement_settings(tmp_path)
    with authenticated_client(settings) as client:
        base = import_prices(client, '2026-09-01', [('A', 10), ('B', 10)])
        assert publish(client, base).status_code == 200
        a, b = [item['material_id'] for item in base['input_items']]
        before = snapshot(settings.database_url)
        invalid = payload(None, [{'material_id': a, 'price': '11'}, {'material_id': 'missing', 'price': '12'}])
        assert procurement_post(client,URL, json=invalid).status_code == 404
        assert snapshot(settings.database_url) == before
        valid = payload(None, [{'material_id': a, 'price': '11'}, {'material_id': b, 'price': '0'}])
        result = procurement_post(client,URL, json=valid)
        assert result.status_code == 200, result.text
        overview = result.json()
        assert overview['next_action'] == client.get('/api/workbenches/procurement/overview').json()['next_action']
        assert {item['code']: item['draft_price'] for item in overview['current_update']['input_items']} == {'A': '11', 'B': '0'}
        assert all(item['published_price'] == '10' for item in overview['materials'])
        saved = snapshot(settings.database_url)
        assert procurement_post(client,URL, json=valid).status_code == 409
        assert snapshot(settings.database_url) == saved


def test_bulk_existing_draft_validation_and_stale_revision(tmp_path):
    settings = procurement_settings(tmp_path)
    with authenticated_client(settings) as client:
        current = import_prices(client, '2026-09-01', [('A', 10), ('B', 10)])
        a, b = [item['material_id'] for item in current['input_items']]
        valid = payload(current, [{'material_id': a, 'price': '11'}, {'material_id': b, 'price': '12'}], '2026-09-01')
        before = snapshot(settings.database_url)
        for bad in [{**valid, 'reason': '    '}, {**valid, 'effective_date': '2026-08-01'}, {**valid, 'items': valid['items'] * 2}, {**valid, 'items': [{'material_id': a, 'price': '-1'}]}]:
            assert procurement_post(client,URL, json=bad).status_code in (409, 422)
            assert snapshot(settings.database_url) == before
        changed = procurement_post(client,URL, json=valid)
        assert changed.status_code == 200, changed.text
        assert changed.json()['current_update']['summary']['error_count'] == 0
        assert procurement_post(client,URL, json=valid).status_code == 409
        assert procurement_post(client,URL, json={**valid, 'update_id': None, 'updated_at': None}).status_code == 409


def test_bulk_schedule_isolation_confirmation_and_cancel(tmp_path):
    with authenticated_client(procurement_settings(tmp_path)) as client:
        base = import_prices(client, '2026-09-01', [('A', 10), ('B', 10)])
        assert publish(client, base).status_code == 200
        a, b = [item['material_id'] for item in base['input_items']]
        current = procurement_post(client,URL, json=payload(None, [{'material_id': a, 'price': '20'}])).json()['current_update']
        assert publish(client, current).status_code == 409
        confirm_risks(client, current)
        assert procurement_post(client,URL, json=payload(current, [{'material_id': a, 'price': '21'}])).status_code == 409
        fresh = client.get('/api/workbenches/procurement/updates/current').json()['current']
        modified = procurement_post(client,URL, json=payload(fresh, [{'material_id': a, 'price': '21'}])).json()['current_update']
        assert modified['summary']['risk_count'] == 1
        confirm_risks(client, modified)
        assert publish(client, modified, mode='scheduled', activate_at=(datetime.now(UTC) + timedelta(days=1)).isoformat()).status_code == 200
        draft = procurement_post(client,URL, json=payload(None, [{'material_id': b, 'price': '11'}], '2026-09-03')).json()
        assert [item['material_id'] for item in draft['current_update']['input_items']] == [b]
        assert all(item['published_price'] == '10' for item in draft['materials'])
        assert procurement_post(client,f"/api/workbenches/procurement/updates/{draft['current_update']['id']}/cancel", json={'reason': '撤销测试草稿'}).status_code == 200
        final = client.get('/api/workbenches/procurement/overview').json()
        assert final['current_update'] is None
        assert final['scheduled_update']['id'] == modified['id']
        assert all(item['published_price'] == '10' for item in final['materials'])


def test_bulk_requires_edit_scope_and_ignores_legacy_field_restriction(tmp_path):
    settings = procurement_settings(tmp_path)
    with authenticated_client(settings) as admin:
        base = import_prices(admin, '2026-09-01', [('A', 10)])
        assert publish(admin, base).status_code == 200
        request = payload(None, [{'material_id': base['input_items'][0]['material_id'], 'price': '11'}])
        for level in [2, 3]:
            IdentityStore(settings.database_url).create_user(username=f'bulk-{level}', display_name='采购测试', department='采购', password='Bulk-Test-Password-2026', scope_levels={'procurement': level})
        from api.authorization import AuthorizationStore
        AuthorizationStore(settings.database_url).set_field_policy("procurement.material_unit_price", 2, 4, ["procurement"], ["procurement"])
    before = snapshot(settings.database_url)
    for level in [2, 3]:
        with TestClient(create_app(settings)) as client:
            assert procurement_post(client,'/api/login', json={'username': f'bulk-{level}', 'password': 'Bulk-Test-Password-2026'}).status_code == 200
            response = procurement_post(client,URL, json=request)
            assert response.status_code == (403 if level == 2 else 200)
            if level == 2:
                assert snapshot(settings.database_url) == before
from tests.procurement_helpers import procurement_post
