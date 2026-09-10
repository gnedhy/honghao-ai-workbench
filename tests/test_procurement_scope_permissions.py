from api.identity import IdentityStore
from tests.helpers import authenticated_client
from tests.procurement_helpers import procurement_post
from tests.test_procurement_workbench import procurement_settings
from tests.test_procurement_isolation import import_prices, publish


PREFIX = '/api/workbenches/procurement'
PASSWORD = 'Scope-Test-Password-2026'


def sign_in(client, username):
    procurement_post(client, '/api/logout')
    assert procurement_post(client, '/api/login', json={'username': username, 'password': PASSWORD}).status_code == 200


def test_editor_can_return_and_view_archive_but_not_manage_catalog(tmp_path):
    settings = procurement_settings(tmp_path)
    with authenticated_client(settings) as client:
        update = import_prices(client, '2026-09-01', [('A', 10)])
        assert procurement_post(client, PREFIX+f"/updates/{update['id']}/submit").status_code == 200
        identities = IdentityStore(settings.database_path)
        for level in (2, 3):
            identities.create_user(username=f'level-{level}', display_name='采购', department='采购', password=PASSWORD, scope_levels={'procurement':level})
        sign_in(client, 'level-2')
        assert client.get(PREFIX+'/history/materials?include_archived=true').status_code == 403
        assert procurement_post(client, PREFIX+f"/updates/{update['id']}/return", json={'reason':'重新检查价格'}).status_code == 403
        sign_in(client, 'level-3')
        assert client.get(PREFIX+'/history/materials?include_archived=true').status_code == 200
        assert procurement_post(client, PREFIX+f"/updates/{update['id']}/return", json={'reason':'重新检查价格'}).status_code == 200
        assert procurement_post(client, PREFIX+'/materials', json={'code':'B'}).status_code == 403
        assert publish(client, update).status_code == 403


def test_manager_catalog_lifecycle_and_activation_without_delegation(tmp_path):
    settings = procurement_settings(tmp_path)
    with authenticated_client(settings) as client:
        update = import_prices(client, '2026-09-01', [('A', 10)])
        identities = IdentityStore(settings.database_path)
        user = identities.create_user(username='manager', display_name='采购管理', department='采购', password=PASSWORD, scope_levels={'procurement':4})
        sign_in(client, 'manager')
        overview = client.get(PREFIX+'/overview').json()
        assert overview['capabilities'] == {'can_edit':True, 'can_activate':True, 'can_manage_grants':False, 'can_cancel_round':False, 'can_manage_catalog':True}
        assert client.get(PREFIX+'/activation-grants').status_code == 403
        assert client.get('/api/users').status_code == 403
        assert procurement_post(client, PREFIX+f"/updates/{update['id']}/cancel", json={'reason':'取消权限测试'}).status_code == 403
        assert publish(client, update).status_code == 200
        created = procurement_post(client, PREFIX+'/materials', json={'code':'MANAGER-CATALOG'})
        assert created.status_code == 201, created.text
        material_id = created.json()['id']
        changed = client.patch(PREFIX+f'/materials/{material_id}', json={'code':'MANAGER-RENAMED', 'name':'MANAGER-RENAMED'})
        assert changed.status_code == 200, changed.text
        assert procurement_post(client, PREFIX+f'/materials/{material_id}/archive').status_code == 200
        assert client.get(PREFIX+f'/materials/{material_id}?include_archived=true').status_code == 200
        assert procurement_post(client, PREFIX+f'/materials/{material_id}/restore').status_code == 200
        identities.update_user(user['id'], is_active=False)
        assert client.get(PREFIX+'/overview').status_code == 401


def test_other_scope_manager_cannot_enter_procurement(tmp_path):
    settings = procurement_settings(tmp_path)
    with authenticated_client(settings) as client:
        IdentityStore(settings.database_path).create_user(username='sales-manager', display_name='销售管理', department='销售', password=PASSWORD, scope_levels={'sales':4})
        sign_in(client, 'sales-manager')
        assert client.get(PREFIX+'/overview').status_code == 403
        assert procurement_post(client, PREFIX+'/materials', json={'code':'DENIED'}).status_code == 403
