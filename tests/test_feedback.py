import base64
from io import BytesIO

from PIL import Image
from fastapi.testclient import TestClient

from api.identity import IdentityStore
from api.main import create_app
from api.settings import Settings
from tests.helpers import TEST_ADMIN_PASSWORD, authenticated_client


def login(client, name):
    assert client.post('/api/login', json={'username': name, 'password': TEST_ADMIN_PASSWORD}).status_code == 200


def accounts(settings):
    identities = IdentityStore(settings.database_path)
    for name in ('alice', 'bob', 'admin2'):
        identities.create_user(username=name, display_name=name, department=None,
            password=TEST_ADMIN_PASSWORD, is_system_admin=name == 'admin2')


def submit(client, **extra):
    response = client.post('/api/feedback', json={'kind': '问题反馈', 'text': '测试内容', **extra})
    assert response.status_code == 200, response.text
    return response.json()


def test_feedback_permissions_and_notification_loop(tmp_path):
    settings = Settings.from_data_dir(tmp_path)
    with authenticated_client(settings) as client:
        accounts(settings)
        login(client, 'alice')
        item = submit(client)
        path = '/api/feedback/' + item['id']
        assert not item['unread']
        login(client, 'bob')
        assert client.get('/api/feedback').json() == []
        assert client.post(path + '/read', json={'revision': 1}).status_code == 404
        assert client.get(path + '/image').status_code == 404
        assert client.patch(path, json={'revision': 1, 'status': '处理中'}).status_code == 403
        login(client, 'test-admin')
        assert client.get('/api/feedback/unread').json() == {'count': 1}
        assert client.get('/api/feedback').json()[0]['unread']
        assert client.get('/api/feedback/unread').json() == {'count': 1}
        assert client.post(path + '/read', json={'revision': 1}).status_code == 200
        assert client.get('/api/feedback/unread').json() == {'count': 0}
        assert client.get('/api/feedback').json()[0]['status'] == '待处理'
        login(client, 'admin2')
        assert client.get('/api/feedback/unread').json() == {'count': 1}
        assert client.patch(path, json={'revision': 1, 'status': '已处理', 'result': '   '}).status_code == 422
        assert client.patch(path, json={'revision': 1, 'status': '处理中', 'result': '未完成内容'}).status_code == 422
        updated = client.patch(path, json={'revision': 1, 'status': '已处理', 'result': '已修复'}).json()
        assert updated['revision'] == 2
        assert client.patch(path, json={'revision': 1, 'status': '处理中'}).status_code == 409
        login(client, 'alice')
        assert client.get('/api/feedback/unread').json() == {'count': 1}
        assert client.post(path + '/read', json={'revision': 1}).status_code == 200
        assert client.get('/api/feedback/unread').json() == {'count': 1}
        assert client.post(path + '/read', json={'revision': 3}).status_code == 409
        assert client.post(path + '/read', json={'revision': 2}).status_code == 200
        assert client.get('/api/feedback/unread').json() == {'count': 0}
    with authenticated_client(settings) as client:
        login(client, 'alice')
        assert client.get('/api/feedback').json()[0]['result'] == '已修复'
        assert client.get('/api/feedback/unread').json() == {'count': 0}


def test_admin_own_feedback_and_noop(tmp_path):
    settings = Settings.from_data_dir(tmp_path)
    with authenticated_client(settings) as client:
        accounts(settings)
        item = submit(client)
        path = '/api/feedback/' + item['id']
        assert client.get('/api/feedback/unread').json() == {'count': 0}
        done = client.patch(path, json={'revision': 1, 'status': '已处理', 'result': '自行修复'}).json()
        assert not done['unread']
        same = client.patch(path, json={'revision': 2, 'status': '已处理', 'result': '自行修复'}).json()
        assert same['revision'] == 2
        login(client, 'admin2')
        client.patch(path, json={'revision': 2, 'status': '已处理', 'result': '补充说明'})
        login(client, 'test-admin')
        assert client.get('/api/feedback/unread').json() == {'count': 1}


def test_feedback_images_and_validation(tmp_path):
    settings = Settings.from_data_dir(tmp_path)
    with authenticated_client(settings) as client:
        accounts(settings)
        for fmt, mime in [('PNG', 'png'), ('JPEG', 'jpeg'), ('WEBP', 'webp')]:
            stream = BytesIO()
            Image.new('RGB', (4, 4), 'blue').save(stream, format=fmt)
            data = stream.getvalue()
            item = submit(client, image='data:image/' + mime + ';base64,' + base64.b64encode(data).decode())
            assert item['has_image'] and 'image' not in item
            response = client.get('/api/feedback/' + item['id'] + '/image')
            assert response.content == data
            assert response.headers['content-type'] == 'image/' + mime
            assert response.headers['cache-control'] == 'no-store'
        for extra in [{'text': ' '}, {'kind': 'other'}, {'image': 'data:image/png;base64,AAAA'},
                      {'image': 'data:image/svg+xml;base64,AAAA'}, {'owner_id': 'spoof'},
                      {'image': 'data:image/png;base64,' + base64.b64encode(b'x' * (5*1024*1024+1)).decode()}]:
            assert client.post('/api/feedback', json={'kind': '问题反馈', 'text': 'test', **extra}).status_code == 422
        login(client, 'alice')
        assert client.get('/api/feedback/' + item['id'] + '/image').status_code == 404


def test_feedback_authentication_and_csrf(tmp_path):
    settings = Settings.from_data_dir(tmp_path)
    with TestClient(create_app(settings)) as client:
        assert client.get('/api/feedback').status_code == 401
        assert client.get('/api/feedback/unread').status_code == 401
        assert client.post('/api/feedback', json={}).status_code == 401
    with authenticated_client(settings) as client:
        payload = {'kind': '问题反馈', 'text': 'test'}
        assert client.post('/api/feedback', json=payload, headers={'Origin': 'https://evil.test'}).status_code == 403
        assert client.post('/api/feedback', json=payload, headers={'Sec-Fetch-Site': 'cross-site'}).status_code == 403
        assert client.post('/api/feedback', json=payload, headers={'Origin': 'http://testserver'}).status_code == 200
