"""H05 safe DTOs and project receipts on the dedicated PostgreSQL fixture."""
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

from tests.test_ai_runtime import controlled, endpoint, ended
from tests.test_ai_workspace import workspace, login, submit
from api.postgres import transaction
from datetime import UTC, datetime, timedelta


def test_my_ai_usage_is_private_includes_archives_and_filters_days(controlled):
    settings,client,users,_=controlled
    work=submit(client);chat=submit(client,mode='chat')
    for receipt in (work,chat):
        client.post(endpoint(receipt),json={});assert ended(client,endpoint(receipt))['status']=='completed'
    task=client.get('/api/tasks/'+work['task']['id']).json()
    run=client.get(endpoint(work)).json()
    assert client.post('/api/tasks/'+task['id']+'/acceptance',json={'run_id':run['id'],'revision':task['revision']}).status_code==200
    assert client.patch('/api/conversations/'+work['conversation']['id'],json={'archived':True,'revision':work['conversation']['revision']}).status_code==200
    with transaction(settings.database_url,write=True) as db:
        db.execute('UPDATE task_runs SET model_tokens=2000,started_at=%s WHERE id=%s',((datetime.now(UTC)-timedelta(days=12)).isoformat(),run['id']))
        db.execute("UPDATE task_runs SET model_tokens=1000,status='failed' WHERE input_message_id=%s",(chat['message']['id'],))
    summary=client.get('/api/me/ai-usage').json()
    assert (summary['executions'],summary['chats'],summary['work'],summary['tokens'],summary['accepted_tasks'])==(2,1,1,3000,1)
    assert (summary['successful'],summary['failed'],summary['stopped'],summary['active_days'])==(1,1,0,2)
    assert sum(day['runs'] for day in summary['activity'])==2
    week=client.get('/api/me/ai-usage?period=7').json()
    assert (week['executions'],week['work'],week['tokens'],week['accepted_tasks'])==(1,0,1000,1)
    assert client.get('/api/me/ai-usage?period=all').json()['tokens']==3000
    assert client.get('/api/me/ai-usage?period=90').status_code==422
    assert client.get('/api/me/ai-usage',headers={'X-Workspace-Actor':users[1]['id']}).status_code==401
    for username in ('bob','test-admin'):
        login(client,username);private=client.get('/api/me/ai-usage').json()
        assert private['tokens']==private['executions']==private['accepted_tasks']==0 and private['activity']==[]
    login(client,'alice')
    assert client.get('/api/me/ai-usage?owner_id='+users[1]['id']).json()['tokens']==3000


def test_project_removal_preserves_history_and_continuation(controlled):
    settings,client,users,_=controlled
    create={'title':'synthetic removable project','submission_key':str(uuid4())}
    project=client.post('/api/projects',json=create).json()
    first=submit(client,project_id=project['id'])
    client.post(endpoint(first),json={})
    run=ended(client,endpoint(first))
    task=client.get('/api/tasks/'+first['task']['id']).json()
    assert client.post('/api/tasks/'+task['id']+'/acceptance',json={'run_id':run['id'],'revision':task['revision']}).status_code==200
    tables=('conversations','conversation_messages','tasks','task_runs','ai_run_events','ai_contexts')
    def records():
        with transaction(settings.database_url) as db:
            return {table:db.execute('SELECT * FROM '+table+' ORDER BY _order').fetchall() if table not in ('ai_run_events','ai_contexts') else db.execute('SELECT * FROM '+table+' ORDER BY 1').fetchall() for table in tables}
    before=records()
    path='/api/projects/'+project['id'];body={'title':project['title'],'revision':project['revision'],'removed':True}
    assert client.patch(path,json={'title':project['title'],'removed':True}).status_code==428
    assert client.patch(path,json={**body,'removed':False}).status_code==422
    assert client.patch(path,json={**body,'title':'accidental rename'}).status_code==409
    for name in ('bob','test-admin'):
        login(client,name)
        assert client.patch(path,json=body).status_code==404
        assert client.get('/api/projects').json()==[]
    login(client,'alice')
    with ThreadPoolExecutor(max_workers=4) as pool:
        replies=list(pool.map(lambda _:client.patch(path,json=body),range(4)))
    assert sorted(reply.status_code for reply in replies)==[200,409,409,409]
    saved=next(reply.json() for reply in replies if reply.status_code==200)
    assert saved['removed'] and saved['revision']==project['revision']+1
    assert client.get('/api/projects').json()==[saved]
    assert client.post('/api/projects',json=create).json()==saved
    assert records()==before
    assert client.post('/api/conversations',json={'title':'new','project_id':project['id']}).status_code==409
    assert client.patch(path,json={'title':'rename removed','revision':saved['revision']}).status_code==409
    independent=client.post('/api/conversations',json={'title':'independent'}).json()
    assert client.patch('/api/conversations/'+independent['id'],json={'revision':independent['revision'],'project_id':project['id']}).status_code==409
    source=first['conversation']
    renamed=client.patch('/api/conversations/'+source['id'],json={'revision':source['revision'],'project_id':project['id'],'title':'continued source'}).json()
    assert renamed['project_id']==project['id']
    follow=client.post('/api/conversations/'+source['id']+'/submissions',json={'mode':'work','content':'extension after project removal','task_id':task['id'],'submission_key':str(uuid4())}).json()
    assert follow['task']['id']==task['id'] and follow['task']['project_id']==project['id']
    client.post(endpoint(follow),json={});assert ended(client,endpoint(follow))['status']=='completed'
    history=client.get('/api/tasks/'+task['id']+'/runs').json()
    assert len(history)==2 and next(row for row in history if row['id']==run['id'])['accepted_by']==users[0]['id']


def test_project_create_receipt_survives_rename_and_owner_isolation(workspace):
    _, client, users = workspace
    login(client, 'alice')
    wrong_actor={'X-Workspace-Actor':users[1]['id']}
    assert client.post('/api/projects',json={'title':'must not create'},headers=wrong_actor).status_code==401
    assert client.get('/api/projects',headers=wrong_actor).status_code==401
    assert client.get('/api/me').json()['id']==users[0]['id']
    assert client.get('/api/projects').json()==[]
    body = {'title': 'synthetic project', 'submission_key': str(uuid4()), 'icon':'flask', 'color':'violet'}
    with ThreadPoolExecutor(max_workers=4) as pool:
        replies = list(pool.map(lambda _: client.post('/api/projects', json=body), range(4)))
    assert all(reply.status_code == 201 for reply in replies)
    assert len({reply.json()['id'] for reply in replies}) == 1
    project = replies[0].json()
    assert not {'creation_key','creation_title','creation_icon','creation_color'} & project.keys()
    assert project['icon']=='flask' and project['color']=='violet'
    renamed = client.patch('/api/projects/' + project['id'], json={
        'title': 'changed name', 'revision': project['revision'], 'icon':'chart','color':'rose'})
    assert renamed.status_code == 200
    assert client.post('/api/projects', json=body).json() == renamed.json()
    assert renamed.json()['icon']=='chart' and renamed.json()['color']=='rose'
    assert client.post('/api/projects',json={**body,'color':'blue'}).status_code==409
    assert client.post('/api/projects',json={'title':'invalid','icon':'unknown'}).status_code==422
    assert client.patch('/api/projects/'+project['id'],json={'title':'invalid','revision':2,'color':'invalid'}).status_code==422
    assert client.patch('/api/projects/'+project['id'],json={'title':'stale','revision':1,'color':'green'}).status_code==409
    legacy=client.patch('/api/projects/'+project['id'],json={'title':'legacy rename','revision':2})
    assert legacy.status_code==200 and legacy.json()['icon']=='chart' and legacy.json()['color']=='rose'
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


def test_work_conversation_mode_matches_mutations_and_submission_replay(workspace):
    _, client, _ = workspace
    login(client, 'alice')
    key = str(uuid4())
    first = submit(client, content='synthetic mode consistency', submission_key=key)
    conversation = first['conversation']
    assert conversation['mode'] == 'work'
    assert submit(client, content='synthetic mode consistency', submission_key=key) == first
    path = '/api/conversations/' + conversation['id']
    for changes in ({'title': 'renamed work'}, {'pinned': True}, {'archived': True}, {'archived': False}):
        saved = client.patch(path, json={**changes, 'revision': conversation['revision']})
        assert saved.status_code == 200
        conversation = saved.json()
        assert conversation['mode'] == 'work'
        assert client.get('/api/conversations').json() == [conversation]
