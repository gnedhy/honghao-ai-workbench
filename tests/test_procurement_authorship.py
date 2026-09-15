import json
from api.postgres import transaction

from api.identity import IdentityStore
from tests.test_procurement_collaboration import real_data, overview, save, publish, login, PREFIX


def test_editor_roster_includes_unmodified_buyers_not_admin(real_data):
    _, client, users = real_data
    data = overview(client)
    assert {u['id'] for u in data['editors']} == {u['id'] for u in users}
    assert client.get('/api/me').json()['id'] not in {u['id'] for u in data['editors']}
    assert client.get(PREFIX+'/overview', params={'editor_id': users[1]['id']}).json()['materials'] == []


def test_source_purchaser_is_not_a_system_modifier(real_data):
    settings, client, users = real_data
    data = overview(client)
    material = next(m for m in data['materials'] if m['code'] == 'CF001L')
    assert material['price_modifier'] == {'kind': 'source', 'name': '来源采购员', 'id': None}
    detail = client.get(PREFIX+f"/materials/{material['id']}").json()
    assert all(row['modifier']['kind'] == 'source' for row in detail['official_history'])
    assert detail['changes'] == []
    with transaction(settings.database_url, write=True) as db:
        rows = db.execute('SELECT _order,raw_json FROM procurement_material_sources WHERE material_id=%s', (material['id'],)).fetchall()
        for order, raw in rows:
            values = json.loads(raw); values[0] = users[1]['display_name']
            db.execute('UPDATE procurement_material_sources SET raw_json=%s WHERE _order=%s', (json.dumps(values), order))
    assert client.get(PREFIX+'/overview', params={'editor_id': users[1]['id']}).json()['materials'] == []
    historical = client.get(PREFIX+'/overview', params={'editor_id': users[1]['id'], 'editor_scope': 'all'}).json()
    assert len(historical['materials']) == 1
    assert historical['materials'][0]['participants'] == []


def test_latest_saved_actor_and_immutable_published_attribution(real_data):
    settings, client, users = real_data
    login(client, 1)
    assert save(client, 'CF001L', '13.6').status_code == 200
    login(client, 2)
    assert save(client, 'CF001L', '13.7').status_code == 200
    data = overview(client)
    material = next(m for m in data['materials'] if m['code'] == 'CF001L')
    assert material['price_modifier']['name'] == users[2]['display_name']
    assert {u['id'] for u in material['round_participants']} == {users[1]['id'], users[2]['id']}
    login(client, 0)
    assert publish(client).status_code == 200
    assert save(client, 'CF001M', '10.1').status_code == 200
    assert publish(client).status_code == 200
    with transaction(settings.database_url, write=True) as db:
        db.execute("UPDATE identity_users SET display_name='新姓名' WHERE id=%s", (users[2]['id'],))
    detail = client.get(PREFIX+f"/materials/{material['id']}").json()
    assert detail['official_history'][-1]['modifier']['name'] == users[2]['display_name']
    assert detail['official_history'][-2]['modifier']['name'] == users[2]['display_name']
    assert detail['official_history'][0]['modifier']['kind'] == 'source'
    assert save(client, 'CF001L', '13.8').status_code == 200
    update = overview(client)['current_update']
    assert client.post(PREFIX+f"/updates/{update['id']}/cancel", json={'reason': '取消测试修改'}).status_code == 200
    material = next(m for m in overview(client)['materials'] if m['code'] == 'CF001L')
    assert material['price_modifier']['name'] == users[2]['display_name']
