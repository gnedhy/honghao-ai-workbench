"""Human acceptance binds one successful result; the model is never called by acceptance."""
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

from api import postgres
from api.postgres import transaction
from tests.conftest import _grant_app
from tests.helpers import authenticated_client
from tests.test_ai_runtime import controlled, endpoint, ended
from tests.test_ai_workspace import login, submit
from tests.test_tasks import chat_and_task_settings


def test_latest_result_requires_owned_versioned_human_acceptance(controlled):
    settings, client, users, _ = controlled
    first = submit(client); task_path = '/api/tasks/' + first['task']['id']; path = task_path + '/acceptance'
    assert client.post(path, json={'revision': 1, 'run_id': 'missing'}).status_code == 409
    client.post(endpoint(first), json={}); finished = ended(client, endpoint(first))
    task = client.get(task_path).json(); assert task['status'] == 'review'
    payload = {'revision': task['revision'], 'run_id': finished['id']}
    before = client.get(task_path + '/runs').json()[0]
    for changes in ({'revision': None}, {'revision': True}, {'revision': '1'}, {'run_id': ''}, {'status': 'completed'}):
        assert client.post(path, json={**payload, **changes}).status_code == 422
    assert client.post(path, json={**payload, 'revision': 1}).status_code == 409
    assert client.post(path, json={**payload, 'run_id': str(uuid4())}).status_code == 409
    for actor in ('bob', 'test-admin'):
        login(client, actor); assert client.post(path, json=payload).status_code == 404
    login(client, 'alice')
    settings.module_modes['tasks'] = 'off'
    assert client.post(path, json=payload).status_code == 404
    settings.module_modes['tasks'] = 'active'
    settings.module_modes['chat'] = 'off'
    saved = client.post(path, json=payload); assert saved.status_code == 200
    assert saved.json()['status'] == 'completed' and saved.json()['revision'] == task['revision'] + 1
    accepted = client.get(task_path + '/runs').json()[0]
    assert accepted['accepted_at'] and accepted['accepted_by'] == users[0]['id']
    assert {key: value for key, value in accepted.items() if key not in ('accepted_at', 'accepted_by')} == {key: value for key, value in before.items() if key not in ('accepted_at', 'accepted_by')}
    assert client.post(path, json=payload).status_code == 409
    settings.module_modes['chat'] = 'active'
    second = client.post('/api/conversations/' + first['conversation']['id'] + '/submissions', json={
        'mode': 'work', 'task_id': first['task']['id'], 'content': 'LONG revised result', 'submission_key': str(uuid4())}).json()
    assert second['task']['id'] == first['task']['id']
    client.post(endpoint(second), json={})
    active = client.get(task_path).json()
    assert active['status'] == 'running' and client.post(path, json={'revision': active['revision'], 'run_id': finished['id']}).status_code == 409
    run = client.get(endpoint(second)).json()
    client.post('/api/conversations/' + first['conversation']['id'] + '/executions/' + run['id'] + '/stop', json={})
    assert ended(client, endpoint(second))['status'] == 'stopped'
    stopped = client.get(task_path).json()
    assert client.post(path, json={'revision': stopped['revision'], 'run_id': run['id']}).status_code == 409
    third = client.post('/api/conversations/' + first['conversation']['id'] + '/submissions', json={
        'mode': 'work', 'task_id': first['task']['id'], 'content': 'revised result', 'submission_key': str(uuid4())}).json()
    client.post(endpoint(third), json={}); latest = ended(client, endpoint(third))
    task = client.get(task_path).json(); assert task['status'] == 'review'
    assert client.post(path, json={'revision': task['revision'], 'run_id': finished['id']}).status_code == 409
    pending = client.post('/api/conversations/' + first['conversation']['id'] + '/submissions', json={
        'mode': 'work', 'task_id': first['task']['id'], 'content': 'pending revision', 'submission_key': str(uuid4())}).json()
    assert client.post(path, json={'revision': task['revision'], 'run_id': latest['id']}).status_code == 409
    client.post(endpoint(pending), json={}); latest = ended(client, endpoint(pending))
    task = client.get(task_path).json(); payload = {'revision': task['revision'], 'run_id': latest['id']}
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: client.post(path, json=payload).status_code, range(4)))
    assert results.count(200) == 1 and results.count(409) == 3
    history = client.get(task_path + '/runs').json()
    assert len(history) == 4 and history[0]['accepted_at'] == accepted['accepted_at']
    assert history[1]['accepted_at'] is None and history[2]['accepted_at'] is None and history[3]['accepted_by'] == users[0]['id']
    assert len(client.get('/api/tasks').json()) == 1
    row = next(row for row in client.get('/api/conversations').json() if row['id'] == first['conversation']['id'])
    client.patch('/api/conversations/' + row['id'], json={'archived': True, 'revision': row['revision']})
    assert client.get(task_path + '/runs').json() == history


def test_migration_does_not_invent_human_acceptance(tmp_path, pg_targets):
    with transaction(pg_targets[1], write=True) as db:
        db.execute('DROP SCHEMA public CASCADE'); db.execute('CREATE SCHEMA public')
        for version, _, _, content in postgres._migration_files()[1:]:
            if version < 13: db.execute(content)
        db.execute("INSERT INTO conversations(id,title) VALUES('old','old success')")
        db.execute("INSERT INTO conversation_messages(id,conversation_id,mode,content,created_at) VALUES('input','old','work','keep objective','now')")
        db.execute("INSERT INTO tasks(id,conversation_id,objective,status,created_at,message_id) VALUES('old-task','old','keep objective','completed','now','input')")
        db.execute("UPDATE conversation_messages SET task_id='old-task' WHERE id='input'")
        for version, _, _, content in postgres._migration_files()[1:]:
            if version >= 13: db.execute(content)
        _grant_app(db)
        assert db.execute("SELECT status,objective,revision FROM tasks WHERE id='old-task'").fetchone() == ('review','keep objective',2)
    with authenticated_client(chat_and_task_settings(tmp_path / 'data')) as client:
        assert client.get('/api/tasks/old-task').json()['status'] == 'review'
        assert client.get('/api/conversations/old/messages').json()[0]['content'] == 'keep objective'
        assert client.post('/api/tasks/old-task/acceptance', json={'revision': 2, 'run_id': 'no-run'}).status_code == 403
