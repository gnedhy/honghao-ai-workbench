"""Run snapshots and the bounded memory request; no real provider calls."""
import io
import hashlib
import tomllib
from pathlib import Path
import json
import threading
from uuid import uuid4

import pytest
from contextlib import closing

from api import codex_runtime as runtime
from api.personalization import PersonalizationStore
from api.postgres import transaction
from tests.test_ai_runtime import controlled, endpoint, ended
from tests.test_ai_workspace import submit


def test_running_rules_are_frozen_next_turn_uses_frozen_project(controlled, monkeypatch):
    settings, client, users, _ = controlled
    store = PersonalizationStore(settings.database_url, settings.data_dir)
    actor = users[0]['id']
    store.update(actor, 1, {'instructions': '个人流程'})
    projects = [client.post('/api/projects', json={'title': title}).json() for title in ('原项目', '新项目')]
    store.save_project(actor, projects[0]['id'], 0, '原项目规则一')
    store.save_project(actor, projects[1]['id'], 0, '不能串入新项目规则')
    first = submit(client, project_id=projects[0]['id'])
    client.post(endpoint(first), json={})
    done = ended(client, endpoint(first))
    store.save_project(actor, projects[0]['id'], 1, '原项目规则二')
    conversation = first['conversation']
    assert client.patch(f"/api/conversations/{conversation['id']}", json={'project_id': projects[1]['id'], 'revision': conversation['revision']}).status_code == 200
    follow = client.post(f"/api/conversations/{conversation['id']}/submissions", json={'mode': 'work', 'content': '继续', 'submission_key': str(uuid4())}).json()
    client.post(endpoint(follow), json={})
    next_run = ended(client, endpoint(follow))
    with transaction(settings.database_url) as db:
        rows = db.execute('SELECT id,personalization_snapshot,context_id FROM task_runs WHERE id=ANY(%s)', ([done['id'], next_run['id']],)).fetchall()
    records = {row[0]: row for row in rows}
    assert records[done['id']][1]['instructions'] == '原项目规则一'
    assert records[next_run['id']][1]['instructions'] == '原项目规则二'
    assert records[done['id']][2] != records[next_run['id']][2]
    assert next_run['task_id'] == done['task_id']


def test_native_proxy_routes_memory_usage_without_changing_reply(controlled,monkeypatch):
    import http.client
    from tests.test_ai_runtime import ORIGINAL_PROXY
    from tests.test_personalization import completed_run
    from api.database import Database
    settings,client,users,config=controlled
    actor=users[0]['id'];controller=runtime.CodexRuntime(settings)
    run_id,_=completed_run(settings,client,actor,controller.personalization)
    snapshot=controller.personalization.snapshot(actor_id=actor,mode='chat')
    run={'id':run_id,'owner_id':actor,'task_id':None,'personalization_snapshot':snapshot,'proxy_failure':None}
    sent=[]
    class Provider:
        sock=None
        def __init__(self,*args,**kwargs):pass
        def request(self,method,path,body,headers):sent.append(json.loads(body))
        def getresponse(self):
            class Result(io.BytesIO):status=200
            events=[{'type':'response.completed','response':{'output':[{'type':'function_call','name':'exec_command','arguments':'{}'}],'usage':{'total_tokens':33}}}]
            return Result((''.join('data: '+json.dumps(event)+'\n\n' for event in events)).encode())
        def close(self):pass
    monkeypatch.setattr(runtime.http.client,'HTTPSConnection',Provider)
    home=settings.data_dir/'native-synthetic-home'
    config={**config,'native_home':home}
    server=ORIGINAL_PROXY(controller,run,config,'loopback','synthetic-no-key')
    server.foreground_done.set()
    try:
        body={'model':'deepseek-flash','instructions':'Native consolidation instructions','reasoning':{'effort':'medium'},'input':[{'role':'user','content':'Synthetic consolidation'}],
              'tools':[{'type':'function','name':'exec_command'},{'type':'function','name':'unapproved_tool'}]}
        metadata={'thread_source':'memory_consolidation','request_kind':'turn','sandbox_mode':'workspace-write','workspaces':{str(home/'memories'):{}}}
        with closing(http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=3)) as connection:
            connection.request('POST','/responses',json.dumps(body),{'Authorization':'Bearer loopback','x-codex-turn-metadata':json.dumps(metadata)})
            response=connection.getresponse();assert response.status==200;response.read()
        assert sent[0]['instructions']=='Native consolidation instructions' and sent[0]['reasoning']['effort']=='medium'
        assert sent[0]['tools']==[{'type':'function','name':'exec_command'}] and sent[0]['max_output_tokens']==8192
        assert run['proxy_failure'] is None
        with transaction(settings.database_url) as db:
            row=db.execute('SELECT status,model_requests,model_tokens FROM task_runs WHERE id=%s',(run_id,)).fetchone()
        assert row==('completed',0,0)
        assert Database(settings.database_url).ai_usage(actor_id=actor)['tokens']==33
        metadata['workspaces']={'/other-account/memories':{}}
        with closing(http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=3)) as connection:
            connection.request('POST','/responses',json.dumps(body),{'Authorization':'Bearer loopback','x-codex-turn-metadata':json.dumps(metadata)})
            response=connection.getresponse();assert response.status==502;response.read()
        assert len(sent)==1 and run['proxy_failure'] is None
    finally:
        server.stopping.set();server.shutdown();server.server_close()


def test_native_reset_uses_official_rpc_and_preserves_other_account(controlled,monkeypatch):
    import sqlite3
    settings,_,users,config=controlled
    actor,other=[row['id'] for row in users]
    controller=runtime.CodexRuntime(settings)
    owner=controller.personalization.native_directory(actor,create=True)
    memory=owner/'memories';memory.mkdir();(owner/'state').mkdir()
    (memory/'memory_summary.md').write_text('own synthetic memory')
    foreign=controller.personalization.native_directory(other,create=True)/'memories';foreign.mkdir();(foreign/'memory_summary.md').write_text('other account')
    thread=str(uuid4())
    with closing(sqlite3.connect(owner/'state/state_5.sqlite')) as db, db:
        db.execute('CREATE TABLE threads(id text,memory_mode text)');db.execute('INSERT INTO threads VALUES(?,?)',(thread,'enabled'))
    calls=[]
    class Native:
        def __init__(self,command,cwd,env):
            assert str(owner) in command and '--unshare-pid' in command
            assert 'sk-' not in json.dumps(command)
        def send(self,*args):pass
        def call(self,method,params,deadline):
            calls.append((method,params))
            if method=='memory/reset':
                (memory/'memory_summary.md').unlink()
            return {}
        def close(self):pass
    monkeypatch.setattr(runtime,'_Rpc',Native)
    before=controller.personalization.snapshot(actor_id=actor,mode='chat')['memory_epoch']
    controller.reset_memory(actor)
    assert ('thread/memoryMode/set',{'threadId':thread,'mode':'disabled'}) in calls and ('memory/reset',{}) in calls
    assert controller.personalization.memories(actor)['items']==[]
    assert (foreign/'memory_summary.md').read_text()=='other account'
    assert controller.personalization.snapshot(actor_id=actor,mode='chat')['memory_epoch']>before


@pytest.mark.parametrize('source', ['personal', 'project'])
def test_native_instruction_discovery_uses_only_frozen_effective_file(tmp_path, monkeypatch, source):
    monkeypatch.setattr(runtime, '_protected', lambda path, **kwargs: Path(path).resolve())
    home, cwd = tmp_path/'home', tmp_path/'cwd'
    home.mkdir(); cwd.mkdir()
    text = '# AGENTS.md\n\n' + '规则' * 7994
    raw = text.encode('utf-8')
    snapshot = {'instructions':text, 'instruction_source':source, 'instruction_sha256':hashlib.sha256(raw).hexdigest()}
    selected = runtime.native_instruction_file(snapshot, home, cwd)
    assert selected == (home if source == 'personal' else cwd)/'AGENTS.md'
    assert selected.read_bytes() == raw
    assert not ((cwd if source == 'personal' else home)/'AGENTS.md').exists()
    assert runtime.native_instruction_file(snapshot, home, cwd) == selected
    selected.write_text('tampered',encoding='utf-8')
    with pytest.raises(runtime.RuntimeBlocked,match='instruction_snapshot'):
        runtime.native_instruction_file(snapshot, home, cwd)


def test_native_instruction_empty_and_unsigned_snapshot_are_not_loaded(tmp_path):
    home, cwd = tmp_path/'home', tmp_path/'cwd'
    home.mkdir(); cwd.mkdir()
    assert runtime.native_instruction_file({'instructions':''},home,cwd) is None
    with pytest.raises(runtime.RuntimeBlocked,match='instruction_snapshot'):
        runtime.native_instruction_file({'instructions':'unverified','instruction_source':'personal'},home,cwd)
    assert not list(tmp_path.rglob('AGENTS.md'))
    config={'binary':tmp_path/'codex','catalog':tmp_path/'models.json','key_file':tmp_path/'key'}
    native=tomllib.loads(runtime._configuration(config,home,cwd,9,None))
    assert native['project_doc_max_bytes']==65536
    permissions=native['permissions']['honghao']['filesystem']
    assert permissions[str(home)]=='deny' and permissions[str(home/'AGENTS.md')]=='read'
    assert permissions[str(config['key_file'])]=='deny'


def test_native_background_fenced_after_identity_regrant(controlled):
    from api.identity import IdentityStore
    settings,client,users,_=controlled
    first=submit(client,mode='chat');client.post(endpoint(first),json={});done=ended(client,endpoint(first))
    with transaction(settings.database_url) as db:
        run=runtime._one(db,'SELECT * FROM task_runs WHERE id=%s',(done['id'],))
    controller=runtime.CodexRuntime(settings)
    assert controller._native_memory_current(run)['status']=='completed'
    identities=IdentityStore(settings.database_url)
    identities.update_user(users[0]['id'],ai_enabled=False);identities.update_user(users[0]['id'],ai_enabled=True)
    with pytest.raises(runtime.RuntimeBlocked,match='memory_cancelled'):controller._native_memory_current(run)


def test_permanent_delete_removes_native_thread_before_product_graph(controlled,monkeypatch):
    import sqlite3
    from contextlib import contextmanager
    from api.database import Database
    settings,client,users,_=controlled
    first=submit(client,mode='chat');client.post(endpoint(first),json={});done=ended(client,endpoint(first))
    actor=users[0]['id'];database=Database(settings.database_url);controller=runtime.CodexRuntime(settings)
    cid=first['conversation']['id']
    archived=database.update_conversation(cid,{'archived':True},1,actor_id=actor)
    with transaction(settings.database_url) as db:
        thread=db.execute('SELECT thread_id FROM ai_contexts WHERE conversation_id=%s',(cid,)).fetchone()[0]
    owner=controller.personalization.native_directory(actor,create=True);(owner/'state').mkdir(exist_ok=True)
    with closing(sqlite3.connect(owner/'state/state_5.sqlite')) as db,db:
        db.execute('CREATE TABLE threads(id text)');db.execute('INSERT INTO threads VALUES(?)',(thread,))
    calls=[]
    class Native:
        def call(self,method,params,deadline):
            calls.append((method,params))
            raise runtime.RuntimeBlocked('protocol_error')
    @contextmanager
    def maintenance(self,actor,context=None):yield Native(),owner,0
    monkeypatch.setattr(runtime.CodexRuntime,'_native_maintenance',maintenance)
    with pytest.raises(runtime.RuntimeBlocked):controller.delete_conversation(database,cid,archived['revision'],actor)
    assert calls==[('thread/delete',{'threadId':thread})]
    with transaction(settings.database_url) as db:assert db.execute('SELECT 1 FROM conversations WHERE id=%s',(cid,)).fetchone()
    monkeypatch.setattr(Native,'call',lambda self,*args:None)
    controller.delete_conversation(database,cid,archived['revision'],actor)
    with transaction(settings.database_url) as db:assert db.execute('SELECT 1 FROM conversations WHERE id=%s',(cid,)).fetchone() is None
