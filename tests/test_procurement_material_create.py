"""Material creation and optional draft prices use one isolated transaction."""
from api.postgres import transaction

import pytest

from api.procurement import ProcurementStore
from tests.test_procurement_collaboration import real_data, overview, save, publish, login, PREFIX


def payload(client, **changes):
    data = overview(client)
    current = data['current_update']
    return {'code': 'NEW-CATALOG', 'name': '新原料（备注）',
            'department_ids': [g['id'] for g in data['departments'][:2]],
            'price': '12.50', 'effective_date': '2026-09-09', 'reason': '供应商报价',
            'update_id': current['id'] if current else None,
            'updated_at': current['updated_at'] if current else None,
            'baseline_id': data['batches'][0]['id'], **changes}


def test_new_material_draft_distribution_and_activation(real_data):
    settings, client, _ = real_data
    before = overview(client)
    response = client.post(PREFIX+'/materials', json=payload(client))
    assert response.status_code == 201, response.text
    material_id = response.json()['id']
    after = overview(client)
    material = next(m for m in after['materials'] if m['id'] == material_id)
    assert material['name'] == '新原料（备注）' and material['unit'] == 'kg'
    assert material['latest_price'] == '12.5' and material['published_price'] is None
    assert after['batches'] == before['batches']
    for index, group in enumerate(after['departments']):
        assert (material_id in group['material_ids']) == (index < 2)
        assert group['priced'] == before['departments'][index]['priced']
    detail = client.get(PREFIX+f'/materials/{material_id}').json()
    assert len(detail['changes']) == 1
    assert detail['changes'][0]['items'][0]['before'] is None
    assert detail['changes'][0]['items'][0]['after'] == '12.5'
    assert detail['changes'][0]['actor'] == client.get('/api/me').json()['display_name']
    assert publish(client).status_code == 200
    official = overview(client)
    assert next(m for m in official['materials'] if m['id'] == material_id)['published_price'] == '12.5'
    assert official['departments'][0]['priced'] == before['departments'][0]['priced'] + 1
    with transaction(settings.database_url) as db:
        assert db.execute("SELECT COUNT(*) FROM procurement_admin_events WHERE target_id=%s AND action='material.created'", (material_id,)).fetchone()[0] == 1


def test_optional_price_and_zero_price(real_data):
    _, client, _ = real_data
    before = overview(client)
    response = client.post(PREFIX+'/materials', json={'code': 'EMPTY-CATALOG'})
    assert response.status_code == 201
    empty = next(m for m in overview(client)['materials'] if m['code'] == 'EMPTY-CATALOG')
    assert empty['name'] == 'EMPTY-CATALOG' and empty['published_price'] is None
    assert overview(client)['current_update'] == before['current_update']
    assert client.post(PREFIX+'/materials', json=payload(client, price='0')).status_code == 201
    zero = next(m for m in overview(client)['materials'] if m['code'] == 'NEW-CATALOG')
    assert zero['latest_price'] == '0' and zero['published_price'] is None


@pytest.mark.parametrize('invalid', [
    {'code': '   '}, {'code': 'X'*65}, {'name': 'X'*121}, {'price': '-1'},
    {'price': '4..5'}, {'price': '10-11'}, {'price': 'NaN'},
    {'effective_date': None}, {'reason': '   '}, {'department_ids': ['missing']},
    {'is_system_admin': True},
])
def test_invalid_creation_leaves_no_partial_data(real_data, invalid):
    _, client, _ = real_data
    before = overview(client)
    response = client.post(PREFIX+'/materials', json=payload(client, **invalid))
    assert response.status_code == 422, response.text
    assert overview(client) == before


def test_duplicates_and_stale_round_roll_back(real_data):
    _, client, _ = real_data
    duplicate = payload(client, code='CF001L')
    assert client.post(PREFIX+'/materials', json=duplicate).status_code == 409
    repeated = payload(client)
    repeated['department_ids'] *= 2
    assert client.post(PREFIX+'/materials', json=repeated).status_code == 422
    stale = payload(client)
    assert save(client, 'CF001L', '13.6').status_code == 200
    before = overview(client)
    assert client.post(PREFIX+'/materials', json=stale).status_code == 409
    assert overview(client) == before
    refreshed = payload(client)
    assert client.post(PREFIX+'/materials', json=refreshed).status_code == 201
    assert client.post(PREFIX+'/materials', json=refreshed).status_code == 409


def test_wrong_date_and_price_failure_roll_back_all(real_data, monkeypatch):
    settings, client, _ = real_data
    assert save(client, 'CF001L', '13.6').status_code == 200
    before = overview(client)
    assert client.post(PREFIX+'/materials', json=payload(client, effective_date='2026-09-10')).status_code == 409
    assert overview(client) == before
    original = ProcurementStore._adjust_price
    def fail_after_write(self, *args, **kwargs):
        original(self, *args, **kwargs)
        raise ValueError('模拟价格保存失败')
    monkeypatch.setattr(ProcurementStore, '_adjust_price', fail_after_write)
    assert client.post(PREFIX+'/materials', json=payload(client)).status_code == 422
    assert overview(client) == before
    with transaction(settings.database_url) as db:
        assert db.execute("SELECT COUNT(*) FROM procurement_admin_events WHERE detail LIKE '%NEW-CATALOG%'").fetchone()[0] == 0


def test_buyers_cannot_create_even_with_activation_permission(real_data):
    _, client, _ = real_data
    request = payload(client)
    for index in (0, 1):
        login(client, index)
        assert client.post(PREFIX+'/materials', json=request).status_code == 403
        assert client.post(PREFIX+'/materials', json={'code': 'EMPTY-CATALOG'}).status_code == 403


def test_changed_baseline_does_not_accept_old_confirmation(real_data):
    _, client, _ = real_data
    stale = payload(client)
    assert save(client, 'CF001L', '13.6').status_code == 200
    assert publish(client).status_code == 200
    before = overview(client)
    assert client.post(PREFIX+'/materials', json=stale).status_code == 409
    assert overview(client) == before


def test_archived_code_and_alias_remain_reserved(real_data):
    settings, client, _ = real_data
    material = overview(client)['materials'][0]
    with transaction(settings.database_url, write=True) as db:
        db.execute("UPDATE procurement_materials SET archived_at='2026-09-09' WHERE id=%s", (material['id'],))
        db.execute("INSERT INTO procurement_material_aliases (alias_code, material_id, created_by, created_at) VALUES ('OLD-ARCHIVED',%s,'test','2026-09-09')", (material['id'],))
    for code in (material['code'], 'OLD-ARCHIVED'):
        response = client.post(PREFIX+'/materials', json={'code': code})
        assert response.status_code == 409
