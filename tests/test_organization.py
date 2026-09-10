import sqlite3

from api.identity import IdentityStore
from api.settings import Settings
from tests.helpers import authenticated_client


def test_department_hierarchy_membership_and_permissions(tmp_path):
    settings = Settings.from_data_dir(tmp_path / 'organization')
    with authenticated_client(settings) as client:
        store = IdentityStore(settings.database_path)
        me = client.get('/api/me').json()
        root = client.post('/api/departments', json={'name': '总经办'}).json()
        purchase = client.post('/api/departments', json={'name': '采购部'}).json()
        child = client.post('/api/departments', json={'name': '原料组', 'parent_id': purchase['id']}).json()
        assert client.post('/api/departments', json={'name': ' 采购部 '}).status_code == 422
        assert client.patch('/api/departments/'+purchase['id'], json={'name': '采购部', 'parent_id': child['id']}).status_code == 422
        assert client.patch('/api/departments/'+root['id'], json={'name': '总经办', 'parent_id': root['id']}).status_code == 422
        assert client.post('/api/departments', json={'name': '坏部门', 'parent_id': 'missing'}).status_code == 422
        buyer = store.create_user(username='buyer', display_name='采购人员', department=None, password='Buyer-Password-2026', scope_levels={'procurement': 3})
        url = f'/api/users/{buyer["id"]}/departments'
        membership = {'primary_department_id': child['id'], 'additional_department_ids': [root['id'], purchase['id']]}
        changed = client.put(url, json=membership)
        assert changed.status_code == 200
        assert changed.json()['department'] == '原料组'
        assert changed.json()['scope_levels'] == buyer['scope_levels']
        for bad in [dict(membership, primary_department_id=None), dict(membership, additional_department_ids=[child['id']]), dict(membership, additional_department_ids=[root['id'], root['id']]), dict(membership, primary_department_id='missing')]:
            assert client.put(url, json=bad).status_code == 422
            assert store.get_user(buyer['id']) == changed.json()
        assert client.delete('/api/departments/'+purchase['id']).status_code == 422
        assert client.delete('/api/departments/'+child['id']).status_code == 422
        renamed = client.patch('/api/departments/'+child['id'], json={'name': '原料采购组', 'parent_id': root['id']})
        assert renamed.status_code == 200
        assert store.get_user(buyer['id'])['department'] == '原料采购组'
        assert client.put(f'/api/users/{me["id"]}/departments', json={'primary_department_id': root['id']}).status_code == 200
        assert client.get('/api/me').json()['is_system_admin']
        # Changing membership never rewrites an concurrently updated name or credentials.
        store.update_profile(buyer['id'], actor_id=me['id'], display_name='新姓名')
        assert client.put(url, json=membership).json()['display_name'] == '新姓名'
        before = store.get_user(buyer['id'])
        assert client.post('/api/login', json={'username':'buyer', 'password':'Buyer-Password-2026'}).status_code == 200
        assert client.get('/api/departments').status_code == 403
        assert client.post('/api/departments', json={'name':'越权'}).status_code == 403
        assert client.patch('/api/departments/'+root['id'], json={'name':'越权'}).status_code == 403
        assert client.delete('/api/departments/'+child['id']).status_code == 403
        assert client.put(url, json=membership).status_code == 403
        assert client.patch('/api/me/profile', json={'display_name':'越权','department':'总经办'}).status_code == 403
        assert client.patch('/api/me/profile', json={'display_name':'越权','membership':membership}).status_code == 422
        assert store.get_user(buyer['id']) == before


def test_empty_delete_creation_and_migration_idempotence(tmp_path):
    settings = Settings.from_data_dir(tmp_path / 'organization')
    with authenticated_client(settings) as client:
        store = IdentityStore(settings.database_path)
        user = store.create_user(username='legacy', display_name='原用户', department='采购部', password='Legacy-Password-2026')
        with sqlite3.connect(settings.database_path) as db:
            db.execute('DELETE FROM organization_memberships')
            db.execute('DELETE FROM organization_departments')
            db.execute("DELETE FROM schema_metadata WHERE key='organization_schema_version'")
            db.execute("UPDATE schema_metadata SET value=5 WHERE key='identity_schema_version'")
            before = db.execute('SELECT * FROM identity_users ORDER BY id').fetchall()
        store.initialize()
        first = client.get('/api/departments').json()
        assert len(first) == 1 and first[0]['name'] == '采购部'
        store.initialize()
        assert client.get('/api/departments').json() == first
        assert store.get_user(user['id'])['primary_department_id'] == first[0]['id']
        with sqlite3.connect(settings.database_path) as db:
            assert db.execute('SELECT * FROM identity_users ORDER BY id').fetchall() == before
        empty = client.post('/api/departments', json={'name':'空部门'}).json()
        assert client.delete('/api/departments/'+empty['id']).status_code == 204
        assert client.get('/api/departments').json() == first
        new = client.post('/api/users', json={'username':'new-member','display_name':'新成员','password':'New-Password-2026','primary_department_id':first[0]['id']})
        assert new.status_code == 201 and new.json()['department'] == '采购部'
        before_count = len(store.list_users())
        assert client.post('/api/users', json={'username':'invalid','display_name':'无效','password':'New-Password-2026','primary_department_id':'missing'}).status_code == 422
        assert len(store.list_users()) == before_count
        events = client.get('/api/admin/audit-events').json()
        assert any(e['action'] == 'department.deleted' for e in events)
