"""H05 safe DTOs and project receipts on the dedicated PostgreSQL fixture."""
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

from tests.test_ai_runtime import controlled, endpoint, ended
from tests.test_ai_workspace import workspace, login, submit


def test_project_create_receipt_survives_rename_and_owner_isolation(workspace):
    _, client, users = workspace
    login(client, 'alice')
    wrong_actor={'X-Workspace-Actor':users[1]['id']}
    assert client.post('/api/projects',json={'title':'must not create'},headers=wrong_actor).status_code==401
    assert client.get('/api/projects',headers=wrong_actor).status_code==401
    assert client.get('/api/me').json()['id']==users[0]['id']
    assert client.get('/api/projects').json()==[]
    body = {'title': 'synthetic project', 'submission_key': str(uuid4())}
    with ThreadPoolExecutor(max_workers=4) as pool:
        replies = list(pool.map(lambda _: client.post('/api/projects', json=body), range(4)))
    assert all(reply.status_code == 201 for reply in replies)
    assert len({reply.json()['id'] for reply in replies}) == 1
    project = replies[0].json()
    assert 'creation_key' not in project and 'creation_title' not in project
    renamed = client.patch('/api/projects/' + project['id'], json={
        'title': 'changed name', 'revision': project['revision']})
    assert renamed.status_code == 200
    assert client.post('/api/projects', json=body).json() == renamed.json()
    assert client.post('/api/projects', json={**body, 'title': 'different'}).status_code == 409
    assert client.post('/api/projects', json={'title': 'legacy title only'}).status_code == 201
    login(client, 'bob')
    other = client.post('/api/projects', json=body)
    assert other.status_code == 201 and other.json()['id'] != project['id']
    assert client.patch('/api/projects/' + project['id'], json={
        'title': 'denied', 'revision': 2}).status_code == 404


def test_active_execution_uses_running_input_and_run_history_is_safe(controlled):
    _, client, _, _ = controlled
    first = submit(client, content='LONG synthetic active input')
    conversation = first['message']['conversation_id']
    active_path = f'/api/conversations/{conversation}/active-execution'
    assert client.get(active_path).json() is None
    # A newer accepted pending input must not hide the older active execution.
    second = client.post(f'/api/conversations/{conversation}/submissions', json={
        'mode': 'work', 'content': 'later pending', 'submission_key': str(uuid4())})
    assert second.status_code == 201
    run = client.post(endpoint(first), json={}).json()
    active = client.get(active_path)
    assert active.status_code == 200 and active.json()['input_message_id'] == first['message']['id']
    assert active.json()['id'] == run['id']
    for forbidden in ('context_id', 'native_thread', 'model_tokens', 'workspace', 'key_file'):
        assert forbidden not in active.json()
    client.post(f'/api/conversations/{conversation}/executions/{run["id"]}/stop', json={})
    done = ended(client, endpoint(first))
    assert done['status'] == 'stopped'
    assert client.get(active_path).json() is None
    history = client.get(f'/api/tasks/{first["task"]["id"]}/runs')
    assert history.status_code == 200 and len(history.json()) == 1
    assert history.json()[0]['phase'] == 'ended'
    assert history.json()[0]['output'] == done['output']
    assert history.json()[0]['reported_model_tokens'] >= 0
    assert 'context_id' not in history.json()[0] and 'model_tokens' not in history.json()[0]
    login(client, 'bob')
    assert client.get(active_path).status_code == client.get(f'/api/tasks/{first["task"]["id"]}/runs').status_code == 404
    login(client, 'test-admin')
    assert client.get(active_path).status_code == 404
