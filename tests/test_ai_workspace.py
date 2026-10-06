"""Synthetic employees on the dedicated PostgreSQL fixture; no model or business data."""
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest

from api.database import Database, WorkspaceAccessError, WorkspaceConflictError, WorkspaceNotFoundError
from api.identity import IdentityStore
from api.postgres import transaction
from tests.helpers import authenticated_client, TEST_ADMIN_PASSWORD
from tests.test_tasks import chat_and_task_settings


@pytest.fixture
def workspace(tmp_path):
    settings = chat_and_task_settings(tmp_path / 'data')
    with authenticated_client(settings) as client:
        store = IdentityStore(settings.database_url)
        users = [store.create_user(username=name, display_name=name, department=None,
            password=TEST_ADMIN_PASSWORD, ai_enabled=True) for name in ('alice', 'bob')]
        yield settings, client, users


def login(client, name):
    response = client.post('/api/login', json={'username':name, 'password':TEST_ADMIN_PASSWORD})
    assert response.status_code == 200
    return response.json()


def submit(client, content='synthetic', **extra):
    response = client.post('/api/conversation-submissions', json={
        'title':'synthetic goal', 'mode':'work', 'content':content, 'submission_key':str(uuid4()), **extra})
    assert response.status_code == 201, response.json()
    return response.json()


def test_private_graph_and_modules_are_isolated_even_from_administrators(workspace):
    _, client, users = workspace
    login(client, 'alice')
    assert {m['id'] for m in client.get('/api/modules').json()} == {'chat','tasks'}
    project = client.post('/api/projects', json={'title':'private'}).json()
    own = submit(client, project_id=project['id'])
    assert own['conversation']['owner_id'] == own['task']['owner_id'] == users[0]['id']
    for name in ('bob','test-admin'):
        login(client, name)
        assert client.get('/api/projects').json() == []
        assert client.get('/api/conversations').json() == []
        assert client.get('/api/tasks').json() == []
        paths = [f"/api/conversations/{own['conversation']['id']}/messages",
            f"/api/tasks/{own['task']['id']}", f"/api/tasks/{own['task']['id']}/runs",
            f"/api/conversations?project_id={project['id']}"]
        assert all(client.get(path).status_code == 404 for path in paths)
        assert client.patch(f"/api/projects/{project['id']}", json={'title':'takeover','revision':1}).status_code == 404
        assert client.post('/api/conversations', json={'title':'cross','project_id':project['id']}).status_code == 404
    assert client.post('/api/projects', json={'title':'spoof', 'owner_id':users[0]['id']}).status_code == 422


def test_continuation_and_request_receipts_survive_reassociation_and_retries(workspace):
    _, client, _ = workspace
    login(client,'alice')
    project = client.post('/api/projects', json={'title':'original'}).json()
    key = str(uuid4())
    payload = {'title':'original title','project_id':project['id'],'mode':'work','content':'original goal','submission_key':key}
    first = client.post('/api/conversation-submissions',json=payload).json()
    conv = first['conversation']; task = first['task']
    assert client.patch(f"/api/projects/{project['id']}",json={'title':'renamed','revision':1}).status_code == 200
    assert client.patch(f"/api/conversations/{conv['id']}",json={'project_id':None,'revision':1}).status_code == 200
    assert client.post('/api/conversation-submissions',json=payload).json() == first
    assert client.post('/api/conversation-submissions',json={**payload,'content':'different'}).status_code == 409
    follow = {'mode':'work','content':'supplement','task_id':task['id'],'submission_key':str(uuid4())}
    path = f"/api/conversations/{conv['id']}/submissions"
    accepted = client.post(path,json=follow).json()
    assert accepted['task'] == task
    assert client.post(path,json=follow).json() == accepted
    assert client.post(path,json={**follow,'task_id':None}).status_code == 409
    other = submit(client)
    assert client.post(path,json={**follow,'task_id':other['task']['id'],'submission_key':str(uuid4())}).status_code == 404
    messages = client.get(f"/api/conversations/{conv['id']}/messages").json()
    assert [m['task_id'] for m in messages] == [task['id'], task['id']]
    assert task['objective'] == 'original goal' and task['project_id'] == project['id']
    login(client,'bob')
    assert client.post('/api/conversation-submissions',json=payload).status_code == 404
    independent = client.post('/api/conversation-submissions',json={**payload,'project_id':None}).json()
    assert independent['task']['id'] != task['id']


def test_required_revision_serializes_competing_updates_without_blind_overwrite(workspace):
    _, client, _ = workspace
    login(client,'alice')
    project = client.post('/api/projects',json={'title':'base'}).json()
    path = f"/api/projects/{project['id']}"
    assert client.patch(path,json={'title':'old client'}).status_code == 428
    assert client.patch(path,json={'title':'bad','revision':0}).status_code == 422
    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(lambda i:client.patch(path,json={'title':f'v{i}','revision':1}).status_code,range(6)))
    assert results.count(200) == 1 and results.count(409) == 5
    assert client.get('/api/projects').json()[0]['revision'] == 2


def test_concurrent_new_work_messages_continue_one_task(workspace):
    _, client, _ = workspace
    login(client,'alice')
    conv=client.post('/api/conversations',json={'title':'concurrent'}).json()
    path=f"/api/conversations/{conv['id']}/submissions"
    with ThreadPoolExecutor(max_workers=6) as pool:
        results=list(pool.map(lambda i:client.post(path,json={'mode':'work','content':f'part {i}',
            'submission_key':str(uuid4())}),range(6)))
    assert all(result.status_code==201 for result in results)
    ids={result.json()['task']['id'] for result in results}
    assert len(ids)==1 and len(client.get('/api/tasks').json())==1
    messages=client.get(f"/api/conversations/{conv['id']}/messages").json()
    assert len(messages)==6 and {message['task_id'] for message in messages}==ids


def test_multiple_historical_tasks_require_explicit_target_without_merging(workspace):
    settings, client, users=workspace
    login(client,'alice')
    first=submit(client); conv=first['conversation']['id']; owner=users[0]['id']
    # Synthetic owned multi-task history; no production ownership is inferred.
    with transaction(settings.database_url,write=True) as db:
        db.execute("INSERT INTO conversation_messages(id,conversation_id,owner_id,mode,content,created_at) VALUES('history-message',%s,%s,'work','second historical goal','now')",(conv,owner))
        db.execute("INSERT INTO tasks(id,conversation_id,owner_id,objective,status,created_at,message_id) VALUES('history-task',%s,%s,'second historical goal','created','now','history-message')",(conv,owner))
        db.execute("UPDATE conversation_messages SET task_id='history-task' WHERE id='history-message'")
    path=f'/api/conversations/{conv}/submissions'
    payload={'mode':'work','content':'supplement','submission_key':str(uuid4())}
    assert client.post(path,json=payload).status_code==409
    accepted=client.post(path,json={**payload,'task_id':'history-task'})
    assert accepted.status_code==201 and accepted.json()['task']['id']=='history-task'
    assert len(client.get('/api/tasks').json())==2
    assert client.get(f"/api/tasks/{first['task']['id']}").json()==first['task']


def test_runtime_input_and_active_run_are_protected_and_revocation_is_immediate(workspace):
    settings, client, users = workspace
    login(client,'alice')
    first, other = submit(client), submit(client)
    store = Database(settings.database_url); actor = users[0]['id']; task = first['task']['id']
    with pytest.raises(WorkspaceNotFoundError):
        store.create_run(task,other['message']['id'],'synthetic-controller',actor_id=actor)
    run = store.create_run(task,first['message']['id'],'synthetic-controller',actor_id=actor)
    with pytest.raises(WorkspaceConflictError):
        store.create_run(task,first['message']['id'],'synthetic-controller',actor_id=actor)
    assert client.get(f'/api/tasks/{task}').json()['latest_run'] == run['id']
    assert [r['id'] for r in client.get(f'/api/tasks/{task}/runs').json()] == [run['id']]
    assert client.post(f'/api/tasks/{task}/runs',json={'status':'completed'}).status_code == 405
    assert client.post(f"/api/conversations/{first['conversation']['id']}/submissions",json={
        'mode':'work','content':'parallel','submission_key':str(uuid4())}).status_code == 409
    IdentityStore(settings.database_url).update_user(actor,ai_enabled=False)
    assert client.get('/api/tasks').status_code == 401
    login(client,'alice')
    assert client.get('/api/tasks').status_code == 403
    with pytest.raises(WorkspaceAccessError):
        store.create_run(task,first['message']['id'],'synthetic-controller',actor_id=actor)
    login(client,'test-admin')
    assert client.get(f'/api/tasks/{task}/runs').status_code == 404
    with transaction(settings.database_url) as db:
        assert db.execute('SELECT count(*) FROM task_runs').fetchone() == (1,)


def test_old_history_is_read_only_and_migration_preserves_every_task(tmp_path, pg_targets):
    from api import postgres
    from tests.conftest import _grant_app
    with transaction(pg_targets[1],write=True) as db:
        db.execute('DROP SCHEMA public CASCADE'); db.execute('CREATE SCHEMA public')
        for _,_,_,content in postgres._migration_files()[1:-1]:
            db.execute(content)
        db.execute("INSERT INTO projects(id,title) VALUES('old-project','historical')")
        db.execute("INSERT INTO conversations(id,title,project_id) VALUES('old-conv','history','old-project')")
        for i in range(2):
            db.execute("INSERT INTO conversation_messages(id,conversation_id,mode,content,created_at) VALUES(%s,'old-conv','work','unchanged','now')",(f'old-message-{i}',))
            db.execute("INSERT INTO tasks(id,conversation_id,objective,project_id,status,created_at,message_id) VALUES(%s,'old-conv','unchanged','old-project','created','now',%s)",(f'old-task-{i}',f'old-message-{i}'))
        db.execute(postgres._migration_files()[-1][3]); _grant_app(db)
    settings = chat_and_task_settings(tmp_path/'data')
    with authenticated_client(settings) as client:
        assert [t['id'] for t in client.get('/api/tasks').json()] == ['old-task-0','old-task-1']
        assert [m['task_id'] for m in client.get('/api/conversations/old-conv/messages').json()] == ['old-task-0','old-task-1']
        assert client.patch('/api/projects/old-project',json={'title':'claim','revision':1}).status_code == 403
        assert client.post('/api/conversations/old-conv/submissions',json={'mode':'work','content':'claim','submission_key':str(uuid4())}).status_code == 403
        assert client.get('/api/tasks/old-task-0/runs').json() == []
        IdentityStore(settings.database_url).create_user(username='alice',display_name='alice',department=None,password=TEST_ADMIN_PASSWORD,ai_enabled=True)
        login(client,'alice')
        assert client.get('/api/projects').json() == client.get('/api/tasks').json() == []


def test_workspace_snapshot_restores_owners_links_receipts_and_runs(workspace, tmp_path, second_pg):
    from api.operations import _table_evidence, create_snapshot, restore_snapshot, verify_snapshot
    from api.settings import Settings
    settings, client, users = workspace
    login(client,'alice')
    first = submit(client)
    Database(settings.database_url).create_run(first['task']['id'], first['message']['id'],
        'synthetic-controller', actor_id=users[0]['id'])
    names = {'projects','conversations','conversation_messages','tasks','task_runs','identity_users'}
    with transaction(settings.database_url) as db:
        before = {k:v for k,v in _table_evidence(db).items() if k in names}
    snapshot = create_snapshot(settings,tmp_path/'snapshots')
    manifest = verify_snapshot(snapshot)
    assert {k:manifest['tables'][k] for k in names} == before
    target = Settings.from_data_dir(tmp_path/'restored',database_url=second_pg['migration_url'])
    restore_snapshot(target,snapshot)
    with transaction(second_pg['url']) as db:
        assert {k:v for k,v in _table_evidence(db).items() if k in names} == before
