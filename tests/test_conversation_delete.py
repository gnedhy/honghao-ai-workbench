"""Permanent archived conversation deletion, with a real graph and synthetic runtime."""
from api.postgres import transaction
from tests.test_ai_runtime import controlled, endpoint, ended
from tests.test_ai_workspace import login, submit


def test_archived_delete_is_private_revision_checked_and_atomic(controlled):
    settings, client, _, _ = controlled
    project = client.post('/api/projects', json={'title': 'retained project'}).json()
    first = submit(client, project_id=project['id'])
    client.post(endpoint(first), json={}); run = ended(client, endpoint(first))
    keep = submit(client, mode='chat', content='keep this unrelated conversation')
    row = next(value for value in client.get('/api/conversations').json() if value['id'] == first['conversation']['id'])
    path = '/api/conversations/' + row['id']
    assert client.request('DELETE', path, json={'revision': row['revision']}).status_code == 409
    row = client.patch(path, json={'archived': True, 'pinned': True, 'revision': row['revision']}).json()
    assert 'trashed' not in row
    assert client.patch(path, json={'trashed': True, 'revision': row['revision']}).status_code == 422
    assert client.request('DELETE', path, json={}).status_code == 428
    for payload in ({'revision': 0}, {'revision': '2'}, {'revision': True}, {'revision': row['revision'], 'archived': True}):
        assert client.request('DELETE', path, json=payload).status_code == 422
    assert client.request('DELETE', path, json={'revision': row['revision'] - 1}).status_code == 409
    with transaction(settings.database_url, write=True) as db:
        db.execute("INSERT INTO conversations(id,title,archived) VALUES('delete-legacy','read only legacy',true)")
    for actor in ('bob', 'test-admin'):
        login(client, actor)
        assert client.request('DELETE', path, json={'revision': row['revision']}).status_code == 404
    assert client.request('DELETE', '/api/conversations/delete-legacy', json={'revision': 1}).status_code == 403
    login(client, 'alice')
    assert client.request('DELETE', path, json={'revision': row['revision']}).status_code == 204
    assert client.get(path + '/messages').status_code == 404
    assert client.get(endpoint(first)).status_code == 404
    assert client.get('/api/tasks/' + first['task']['id']).status_code == 404
    assert client.get('/api/tasks').json() == []
    assert [value['id'] for value in client.get('/api/conversations').json()] == [keep['conversation']['id']]
    assert client.get('/api/projects').json()[0]['id'] == project['id']
    with transaction(settings.database_url) as db:
        for table in ('tasks', 'task_runs', 'ai_contexts', 'ai_run_events'):
            assert db.execute(f'SELECT count(*) FROM {table}').fetchone() == (0,)
        assert db.execute('SELECT count(*) FROM conversation_messages').fetchone() == (1,)
        assert db.execute("SELECT count(*) FROM conversations WHERE id='delete-legacy'").fetchone() == (1,)
    assert client.request('DELETE', path, json={'revision': row['revision']}).status_code == 404


def test_archived_delete_requires_stopped_run(controlled):
    _, client, _, _ = controlled
    first = submit(client, content='LONG'); path = '/api/conversations/' + first['conversation']['id']
    run = client.post(endpoint(first), json={}).json()
    row = client.patch(path, json={'archived': True, 'revision': first['conversation']['revision']}).json()
    assert client.request('DELETE', path, json={'revision': row['revision']}).status_code == 409
    assert client.get(path + '/messages').status_code == 200
    assert client.post(path + '/executions/' + run['id'] + '/stop', json={}).status_code == 200
    assert ended(client, endpoint(first))['status'] == 'stopped'
    assert client.request('DELETE', path, json={'revision': row['revision']}).status_code == 204


def test_archived_task_leaves_daily_panel_and_restore_keeps_history(controlled):
    settings, client, _, _ = controlled
    first = submit(client, content='original archived task goal')
    client.post(endpoint(first), json={}); ended(client, endpoint(first))
    path = '/api/conversations/' + first['conversation']['id']
    task_path = '/api/tasks/' + first['task']['id']
    messages = client.get(path + '/messages').json()
    task = client.get(task_path).json(); runs = client.get(task_path + '/runs').json()
    row = next(value for value in client.get('/api/conversations').json() if value['id'] == first['conversation']['id'])
    row = client.patch(path, json={'archived': True, 'revision': row['revision']}).json()
    assert client.get('/api/tasks').json() == []
    assert client.get(task_path).json() == task
    assert client.get(task_path + '/runs').json() == runs
    assert client.get(path + '/messages').json() == messages
    settings.module_modes['chat'] = 'off'
    assert client.get('/api/tasks').json() == []
    settings.module_modes['chat'] = 'active'
    assert client.patch(path, json={'archived': False, 'revision': row['revision']}).status_code == 200
    assert client.get('/api/tasks').json() == [task]
