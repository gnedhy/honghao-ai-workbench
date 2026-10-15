"""Persistent admission and fair multi-user dispatch on the dedicated test database."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import suppress
import threading
import time
from uuid import uuid4

from api.codex_runtime import CodexRuntime, _finish
from api.database import Database
from api.identity import IdentityStore
from api.postgres import transaction
from tests.helpers import TEST_ADMIN_PASSWORD
from tests.test_ai_runtime import controlled, endpoint, ended
from tests.test_ai_workspace import login, submit


def wait_for(predicate, seconds=20):
    deadline=time.monotonic()+seconds
    while time.monotonic()<deadline:
        if predicate():return
        time.sleep(.02)
    raise AssertionError('Queue condition did not settle')


def test_admin_settings_are_private_revisioned_and_credentials_never_return(controlled):
    settings,client,users,_=controlled
    assert client.get('/api/admin/ai-config').status_code==403
    assert client.get('/api/admin/ai-usage').status_code==403
    assert client.get('/api/admin/ai-queue').status_code==403
    catalog=client.get('/api/me/ai-models').json()
    assert catalog['default_effort']=='high' and catalog['models'][0]['id']=='deepseek-flash'
    login(client,'test-admin')
    initial=client.get('/api/admin/ai-config').json()
    assert initial['models']['value']['enabled_models']==['deepseek-flash']
    value={**initial['models']['value'],'default_effort':'max'}
    result=client.put('/api/admin/ai-config/models',json={'revision':initial['models']['revision'],'value':value})
    assert result.status_code==200
    assert client.put('/api/admin/ai-config/models',json={'revision':initial['models']['revision'],'value':value}).status_code==409
    secret='sk-'+'SyntheticOnlyDoNotSend'+uuid4().hex
    assert client.post('/api/admin/ai-config/credential',json={'key':secret}).status_code==200
    assert secret not in client.get('/api/admin/ai-config').text
    assert secret not in client.get('/api/admin/audit-events').text
    login(client,'alice')
    assert client.get('/api/me/ai-models').json()['default_effort']=='max'
    receipt=submit(client)
    run=client.post(endpoint(receipt),json={'effort':'high'}).json()
    assert run['effort']=='high' and run['model']=='deepseek-flash'
    assert ended(client,endpoint(receipt))['status']=='completed'


def test_50_submitters_are_bounded_fair_cancellable_and_do_not_charge_queue(controlled,monkeypatch):
    settings,client,users,_=controlled
    controller=client.app.state.ai_runtime
    store=controller.control
    store.set_verified_capacity(4)
    with transaction(settings.database_url,write=True) as db:
        db.execute("UPDATE ai_control_settings SET value=jsonb_set(value,'{max_running}','4') WHERE section='concurrency'")
    release=threading.Event();lock=threading.Lock();order=[];active=set();peak=[0]
    def execute(self,run,*args):
        with lock:
            assert run['owner_id'] not in active
            active.add(run['owner_id']);order.append(run['owner_id']);peak[0]=max(peak[0],len(active))
        release.wait(30)
        with transaction(settings.database_url,write=True) as db:
            _finish(db,run['id'],'completed')
        with lock:active.remove(run['owner_id'])
        with self.lock:self.workers.pop(run['id'],None)
        self.queue_wakeup.set()
    monkeypatch.setattr(CodexRuntime,'_execute',execute)
    identity=IdentityStore(settings.database_url);database=Database(settings.database_url)
    actors=[users[0]['id'],users[1]['id']]+[identity.create_user(username=f'queue-{index}',display_name=f'Queue {index}',department=None,password=TEST_ADMIN_PASSWORD,ai_enabled=True)['id'] for index in range(48)]
    receipts=[database.create_conversation_submission('Synthetic queue',None,'chat','Synthetic only',str(uuid4()),actor_id=actor) for actor in actors]
    try:
        with ThreadPoolExecutor(max_workers=12) as pool:
            runs=list(pool.map(lambda pair:controller.start(pair[1]['message']['conversation_id'],pair[1]['message']['id'],pair[0]),zip(actors,receipts)))
        assert len({run['id'] for run in runs})==50
        wait_for(lambda:len(order)==4)
        state=controller.queue_status()
        assert state['running']==4 and state['queued']==46 and peak[0]==4
        queued=next(run for run in runs if run['status']=='queued')
        assert queued['started_at'] is None and queued['queued_at'] and not queued['output']
        actor=actors[runs.index(queued)]
        assert controller.stop(queued['conversation_id'],queued['id'],actor)['status']=='stopped'
        assert store.usage()['totals']['requests']==0
        # A second turn from the first already-served user waits behind never-served users.
        repeat=database.create_conversation_submission('Synthetic repeat',None,'chat','Synthetic repeat',str(uuid4()),actor_id=order[0])
        controller.start(repeat['message']['conversation_id'],repeat['message']['id'],order[0])
        release.set()
        wait_for(lambda:controller.queue_status()['running']==0 and controller.queue_status()['queued']==0,40)
        assert peak[0]<=4 and len(order)==50
        assert order[-1]==order[0]
        with transaction(settings.database_url) as db:
            assert db.execute("SELECT count(*) FROM task_runs WHERE status='completed'").fetchone()[0]==50
    finally:release.set()


def test_queue_survives_restart_and_expired_or_revoked_input_is_not_sent(controlled,monkeypatch):
    settings,client,users,_=controlled
    controller=client.app.state.ai_runtime
    # Retain a running row without a worker to exercise durable owner serialization.
    monkeypatch.setattr(CodexRuntime,'_execute',lambda *args:None)
    first=submit(client,mode='chat');client.post(endpoint(first),json={})
    pending=submit(client,mode='chat');queued=client.post(endpoint(pending),json={}).json()
    assert queued['status']=='queued' and queued['started_at'] is None
    controller.close()
    recovered=CodexRuntime(settings)
    try:
        recovered.recover()
        wait_for(lambda:recovered.get(pending['message']['conversation_id'],pending['message']['id'],users[0]['id'])['status']=='running')
        with transaction(settings.database_url) as db:
            assert db.execute('SELECT status FROM task_runs WHERE id=%s',(queued['id'],)).fetchone()[0]=='running'
            assert db.execute('SELECT status FROM task_runs WHERE input_message_id=%s',(first['message']['id'],)).fetchone()[0]=='stopped'
        next_input=submit(client,mode='chat')
        other=recovered.start(next_input['message']['conversation_id'],next_input['message']['id'],users[0]['id'])
        with transaction(settings.database_url,write=True) as db:
            db.execute("UPDATE task_runs SET queued_at=(now()-interval '31 minutes')::text WHERE id=%s",(other['id'],))
        recovered._dispatch()
        with transaction(settings.database_url) as db:
            assert db.execute('SELECT status,stop_reason FROM task_runs WHERE id=%s',(other['id'],)).fetchone()==('blocked','queue_expired')
        assert recovered.control.usage()['totals']['requests']==0
    finally:recovered.close()


def test_regrant_does_not_revive_previously_revoked_queue(controlled,monkeypatch):
    settings,client,users,_=controlled
    controller=client.app.state.ai_runtime
    monkeypatch.setattr(CodexRuntime,'_execute',lambda *args:None)
    first=submit(client,mode='chat');active=client.post(endpoint(first),json={}).json()
    second=submit(client,mode='chat');queued=client.post(endpoint(second),json={}).json()
    assert queued['status']=='queued'
    identity=IdentityStore(settings.database_url)
    identity.update_user(users[0]['id'],ai_enabled=False)
    identity.update_user(users[0]['id'],ai_enabled=True)
    with transaction(settings.database_url,write=True) as db:_finish(db,active['id'],'blocked','permission_changed')
    controller._dispatch()
    saved=controller.get(queued['conversation_id'],queued['input_message_id'],users[0]['id'])
    assert saved['status']=='blocked' and saved['stop_reason']=='permission_changed' and saved['started_at'] is None
    assert controller.control.usage()['totals']['requests']==0
