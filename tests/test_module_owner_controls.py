from api.identity import IdentityStore
from api.settings import Settings
from tests.helpers import authenticated_client, TEST_ADMIN_PASSWORD


def test_disabled_modules_and_management_locked_for_all_admins(tmp_path):
    settings = Settings.from_data_dir(tmp_path)
    with authenticated_client(settings) as client:
        modes = client.get('/api/admin/module-settings').json()
        disabled = next(m['id'] for m in modes['modules'] if m['current_mode'] != 'active')
        assert not next(m for m in modes['modules'] if m['id'] == disabled)['can_change']
        assert not next(m for m in modes['workbenches'] if m['id'] == 'management')['can_change']
        for mode in ['off', 'prototype', 'active']:
            assert client.put(f'/api/admin/module-settings/{disabled}', json={'mode':mode}).status_code == 403
            assert client.put('/api/admin/workbench-settings/management', json={'mode':mode}).status_code == 403
        IdentityStore(settings.database_url).create_user(username='gnedhy', display_name='邓楚羿', department=None, password=TEST_ADMIN_PASSWORD, is_system_admin=True)
        assert client.post('/api/login', json={'username':'gnedhy','password':TEST_ADMIN_PASSWORD}).status_code == 200
        modes = client.get('/api/admin/module-settings').json()
        assert not next(m for m in modes['modules'] if m['id'] == disabled)['can_change']
        assert not next(m for m in modes['workbenches'] if m['id'] == 'management')['can_change']
        assert client.put(f'/api/admin/module-settings/{disabled}', json={'mode':'active'}).status_code == 403
        assert client.put('/api/admin/workbench-settings/management', json={'mode':'prototype'}).status_code == 403
