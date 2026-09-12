"""Exercise consecutive procurement rounds on a synthetic, isolated database."""
from tests.helpers import authenticated_client
from tests.test_procurement_collaboration import real_data, overview, publish, save, PREFIX
from tests.test_procurement_material_create import payload
from tests.test_procurement_save_confirmation import confirmation
from tests.test_procurement_bulk import payload as bulk_payload


def test_catalog_to_department_prices_history_cancel_and_restart(real_data):
    settings, client, _ = real_data
    before = overview(client)
    created = client.post(PREFIX + '/materials', json=payload(client))
    assert created.status_code == 201, created.text
    material_id = created.json()['id']
    material = lambda data: next(m for m in data['materials'] if m['id'] == material_id)
    assert material(overview(client))['published_price'] is None
    first = publish(client)
    assert first.status_code == 200, first.text
    first_id = first.json()['id']
    frozen = client.get(PREFIX + '/batches/' + first_id).json()
    assert material(overview(client))['published_price'] == '12.5'

    # A saved high-volatility quote must not change any official consumer yet.
    assert save(client, 'NEW-CATALOG', '25').status_code == 200
    draft = overview(client)
    assert draft['current_update']['summary']['risk_count'] > 0
    assert publish(client).status_code == 409
    assert material(overview(client))['published_price'] == '12.5'
    items = [{'material_id': material_id, 'price': '25'}]
    checked = confirmation(client, items, '2026-09-09')
    saved = client.post(PREFIX + '/prices/bulk-adjustments', json={
        **bulk_payload(draft['current_update'], items, '2026-09-09'),
        'price_confirmation': checked,
    })
    assert saved.status_code == 200, saved.text
    second = publish(client)
    assert second.status_code == 200, second.text
    second_id = second.json()['id']
    official = overview(client)
    assert official['current_update'] is None
    assert material(official)['published_price'] == '25'
    assert second.json()['version'] == first.json()['version'] + 1
    for index, group in enumerate(official['departments']):
        assert (material_id in group['material_ids']) == (index < 2)
        assert group['priced'] == before['departments'][index]['priced'] + (index < 2)
    historical = {**frozen, 'status': 'historical'}
    assert client.get(PREFIX + '/batches/' + first_id).json() == historical
    detail = client.get(PREFIX + '/materials/' + material_id).json()
    assert {row['latest_price'] for row in detail['official_history']} == {'12.5', '25'}

    # Cancelling the next round must leave the published version intact.
    assert save(client, 'NEW-CATALOG', '26').status_code == 200
    current = overview(client)['current_update']
    cancelled = client.post(PREFIX + '/updates/' + current['id'] + '/cancel',
                            json={'reason': '闭环测试撤回下一轮报价'})
    assert cancelled.status_code == 200, cancelled.text
    assert material(overview(client))['published_price'] == '25'
    assert overview(client)['batches'][0]['id'] == second_id
    # Close this app lifespan before opening another against the same test data.
    client.exit_stack.close()
    with authenticated_client(settings) as restarted:
        restored = overview(restarted)
        assert restored['current_update'] is None
        assert restored['batches'][0]['id'] == second_id
        assert material(restored)['published_price'] == '25'
        assert restarted.get(PREFIX + '/batches/' + first_id).json() == historical
