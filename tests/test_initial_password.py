
import pytest

from api.identity import IdentityStore, _hash_password
from api.postgres import transaction
from api.settings import Settings
from tests.helpers import authenticated_client


def test_initial_password_defaults_and_reset(tmp_path):
    settings = Settings.from_data_dir(tmp_path)
    with authenticated_client(settings) as client:
        store = IdentityStore(settings.database_url)
        admin = client.get('/api/me').json()
        for name, fields in [('default', {}), ('explicit', {'password': '123456'})]:
            response = client.post('/api/users', json={'username': name, 'display_name': name, **fields})
            assert response.status_code == 201
            assert store.login(name, '123456', 3600)
        assert client.post('/api/users', json={'username': 'bad', 'display_name': 'bad', 'password': '654321'}).status_code == 422
        user = store.create_user(username='reset', display_name='Reset', department='采购部', password='Old-Password-2026', scope_levels={'procurement': 3})
        store.login('reset', 'Old-Password-2026', 3600)
        before = store.get_user(user['id'])
        with transaction(settings.database_url) as db:
            admin_before = db.execute('SELECT * FROM identity_users WHERE id=%s', (admin['id'],)).fetchone()
            sessions = db.execute('SELECT * FROM identity_sessions WHERE user_id=%s', (admin['id'],)).fetchall()
        with pytest.raises(ValueError):
            store.reset_initial_passwords(actor_id=admin['id'], user_ids=[user['id'], 'missing'])
        assert store.login('reset', 'Old-Password-2026', 3600)
        with pytest.raises(ValueError):
            store.reset_initial_passwords(actor_id=admin['id'], user_ids=[admin['id']])
        with pytest.raises(PermissionError):
            store.reset_initial_passwords(actor_id=user['id'], user_ids=[admin['id']])
        assert store.reset_initial_passwords(actor_id=admin['id'], user_ids=[user['id']]) == 1
        assert store.get_user(user['id']) == before
        with transaction(settings.database_url) as db:
            assert db.execute('SELECT * FROM identity_users WHERE id=%s', (admin['id'],)).fetchone() == admin_before
            assert db.execute('SELECT * FROM identity_sessions WHERE user_id=%s', (admin['id'],)).fetchall() == sessions
            assert not db.execute('SELECT * FROM identity_sessions WHERE user_id=%s', (user['id'],)).fetchall()
            salt, hashed = db.execute('SELECT password_salt,password_hash FROM identity_users WHERE id=%s', (user['id'],)).fetchone()
            assert _hash_password('123456', salt) == hashed
        assert client.get('/api/me').status_code == 200
        assert store.change_password(user['id'], '', '123456', '', '') == 'invalid'
