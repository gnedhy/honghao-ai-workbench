"""Owned PostgreSQL + real controller/stdio; model, Linux scope and sandbox are mocked."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path
import sys
import time
import io
import json
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
import tomllib
from uuid import UUID, uuid4

import pytest

from api import codex_runtime as runtime
from api.identity import IdentityStore
from api.postgres import transaction
from tests.helpers import authenticated_client, TEST_ADMIN_PASSWORD
from tests.test_ai_workspace import login, submit
from tests.test_tasks import chat_and_task_settings

ORIGINAL_PROXY = runtime.CodexRuntime._proxy
ORIGINAL_STOP_SCOPE = runtime.CodexRuntime._stop_scope


def test_native_context_policy_is_independent_of_run_budget(tmp_path):
    config = {'binary':tmp_path/'codex', 'catalog':tmp_path/'models.json', 'key_file':tmp_path/'key', 'tokens':runtime.MODEL_CONTEXT_WINDOW}
    values = tomllib.loads(runtime._configuration(config,tmp_path/'home',tmp_path/'cwd',9,None))
    assert values['model_context_window'] == 1048576
    assert values['model_reasoning_effort'] == 'high'
    assert 'model_auto_compact_token_limit' not in values
    assert runtime.AUTO_COMPACT_TOKENS == 943718


@pytest.fixture
def controlled(tmp_path, monkeypatch):
    monkeypatch.setattr(runtime.os, 'geteuid', lambda: 1001, raising=False)
    settings = chat_and_task_settings(tmp_path / 'data')
    root = tmp_path / 'runtime'; root.mkdir()
    key = tmp_path / 'synthetic-key'; key.write_text('sk-' + 'synthetic' * 5)
    config = {name: value[0] for name, value in runtime.LIMITS.items()}
    config.update(binary=Path(sys.executable), catalog=Path('scripts/fixtures/codex-h01-models.json').resolve(),
                  key_file=key, runtime_root=root, fingerprint='synthetic')
    rpc = runtime._Rpc
    monkeypatch.setattr(runtime.CodexRuntime, '_config', lambda self: config.copy())
    monkeypatch.setattr(runtime.CodexRuntime, '_sandbox', lambda *args: None)
    monkeypatch.setattr(runtime.CodexRuntime, '_native_background', lambda *args: None)
    monkeypatch.setattr(runtime.CodexRuntime, '_stop_scope', lambda *args: True)
    monkeypatch.setattr(runtime, '_protected', lambda path, **kwargs: Path(path).resolve())

    class NoNetwork:
        server_port = 9
        stopping = runtime.threading.Event()
        active_socket = None
        def shutdown(self): pass
        def server_close(self): pass
    monkeypatch.setattr(runtime.CodexRuntime, '_proxy', lambda *args: NoNetwork())
    def simulated_rpc(command, cwd, env, **kwargs):
        # Windows Winsock needs SystemRoot; this is only the synthetic subprocess.
        if runtime.os.name == 'nt': env = {**env, 'SystemRoot': runtime.os.environ['SystemRoot']}
        return rpc([sys.executable, str(Path('tests/fixtures/codex-runtime-stub.py').resolve())], cwd, env, **kwargs)
    monkeypatch.setattr(runtime, '_Rpc', simulated_rpc)
    with authenticated_client(settings) as client:
        store = IdentityStore(settings.database_url)
        users = [store.create_user(username=name, display_name=name, department=None,
            password=TEST_ADMIN_PASSWORD, ai_enabled=True) for name in ('alice', 'bob')]
        login(client, 'alice')
        yield settings, client, users, config


def endpoint(value):
    return f'/api/conversations/{value["message"]["conversation_id"]}/messages/{value["message"]["id"]}/execution'


def ended(client, path):
    until = time.monotonic() + 15
    while time.monotonic() < until:
        response = client.get(path); assert response.status_code == 200
        value = response.json()
        if value and value['phase'] == 'ended': return value
        time.sleep(0.03)
    raise AssertionError('Controller did not reach a terminal state')


def test_old_context_usage_keeps_history_and_reads_current_compact_policy(controlled):
    settings, client, _, _ = controlled
    first = submit(client)
    path = endpoint(first)
    client.post(path, json={})
    run = ended(client, path)
    legacy = {'used_tokens': 1802, 'window_tokens': 996147, 'auto_compact_tokens': 4464}
    with transaction(settings.database_url, write=True) as db:
        runtime._event(db, run['id'], 'state', {'context_usage': legacy})
    restored = client.get(path).json()
    assert restored['context_usage'] == legacy
    assert restored['configured_auto_compact_tokens'] == 943718
    assert restored['id'] == run['id'] and restored['output'] == run['output']
    with transaction(settings.database_url) as db:
        assert db.execute("SELECT payload->'context_usage' FROM ai_run_events WHERE run_id=%s AND payload ? 'context_usage' ORDER BY seq DESC LIMIT 1", (run['id'],)).fetchone()[0] == legacy
        assert db.execute('SELECT count(*) FROM task_runs').fetchone() == (1,)


def test_execution_private_idempotent_stream_and_continuous_task(controlled):
    settings, client, users, _ = controlled
    first = submit(client)
    path = endpoint(first)
    assert client.get(path).json() is None
    with ThreadPoolExecutor(max_workers=6) as pool:
        responses = list(pool.map(lambda _: client.post(path, json={}), range(6)))
    assert all(value.status_code == 200 for value in responses)
    assert len({value.json()['id'] for value in responses}) == 1
    run = ended(client, path)
    assert run['status'] == 'completed' and run['output'] == 'synthetic runtime reply'
    assert client.post(path, json={}).json()['id'] == run['id']
    events_path = f'/api/conversations/{run["conversation_id"]}/executions/{run["id"]}/events'
    events = client.get(events_path).text
    assert events.count('event: delta') == 3 and events.count('event: state') == 4
    assert '"status": "queued"' in events
    assert 'threadId' not in events and 'synthetic-thread' not in events
    assert client.get(events_path, headers={'Last-Event-ID': '2'}).text.count('event: state') == 2
    assert client.get(events_path, params={'after': 100}).status_code == 409
    assert client.get(events_path, headers={'Last-Event-ID': 'bad'}).status_code == 400
    assert client.post(path, json={'cwd': '/etc'}).status_code == 422
    assert client.get('/api/tasks').json()[0]['status'] == 'review'
    assert client.get(f'/api/conversations/{run["conversation_id"]}/messages').json()[-1]['run_id'] == run['id']
    second = client.post(f'/api/conversations/{run["conversation_id"]}/submissions', json={
        'mode': 'work', 'content': 'follow up', 'submission_key': str(uuid4())}).json()
    assert second['task']['id'] == first['task']['id']
    client.post(endpoint(second), json={})
    assert ended(client, endpoint(second))['status'] == 'completed'
    with transaction(settings.database_url) as db:
        assert db.execute('SELECT count(*) FROM ai_contexts').fetchone() == (1,)
    summary_input=submit(client,mode='chat',content='H05 summary-only')
    client.post(endpoint(summary_input),json={})
    summary_run=ended(client,endpoint(summary_input))
    assert summary_run['thinking_started'] and summary_run['thinking_summary']=='核对合成输入，准备回复。'
    assert summary_run['context_usage']=={'used_tokens':2400,'window_tokens':996147,'auto_compact_tokens':943718}
    assert summary_run['context_compacting'] is False
    assert all(step['status'] and step['phase'] for step in summary_run['activity']), 'Context metadata polluted processing steps'
    assert any(step['thinking'] for step in summary_run['activity'])
    assert all(step['at'] for step in summary_run['activity'])
    public=json.dumps(summary_run)+client.get(f'/api/conversations/{summary_run["conversation_id"]}/executions/{summary_run["id"]}/events').text
    assert 'PRIVATE_SYNTHETIC_REASONING_NOT_FOR_UI' not in public and 'FOREIGN_SYNTHETIC_SUMMARY' not in public
    recorded=client.get(f'/api/conversations/{summary_run["conversation_id"]}/messages').json()
    assert recorded[0]['execution_status']=='completed' and recorded[0]['execution_ended_at']
    login(client, 'bob')
    assert client.get(path).status_code == client.post(path, json={}).status_code == 404
    login(client, 'test-admin')
    assert client.get(path).status_code == 404


def test_chat_has_no_task_and_cancel_preserves_partial_text(controlled):
    _, client, _, _ = controlled
    first = submit(client, mode='chat', content='LONG')
    path = endpoint(first)
    run = client.post(path, json={}).json()
    until = time.monotonic() + 10
    while not client.get(path).json()['output'] and time.monotonic() < until: time.sleep(0.03)
    assert client.post(f'/api/conversations/{run["conversation_id"]}/submissions', json={'mode': 'chat', 'content': 'overlap', 'submission_key': str(uuid4())}).status_code == 409
    stop = f'/api/conversations/{run["conversation_id"]}/executions/{run["id"]}/stop'
    assert client.post(stop, json={}).json()['stop_requested'] == 1
    done = ended(client, path)
    assert done['status'] == 'stopped' and done['output']
    assert done['task_id'] is None and client.get('/api/tasks').json() == []
    assert client.post(stop, json={}).json()['status'] == 'stopped'
    assert client.post(path, json={}).json()['id'] == done['id']


def test_native_stub_waits_for_model_response_before_completing(controlled, tmp_path):
    entered, release = threading.Event(), threading.Event()

    class Provider(BaseHTTPRequestHandler):
        def log_message(self, *args): pass
        def do_POST(self):
            self.rfile.read(int(self.headers['Content-Length']))
            entered.set()
            assert release.wait(5)
            self.send_response(200)
            self.send_header('Content-Length', '2')
            self.end_headers()
            self.wfile.write(b'{}')

    home = tmp_path / 'stub-response-order'; home.mkdir()
    with ThreadingHTTPServer(('127.0.0.1', 0), Provider) as server:
        worker = threading.Thread(target=server.serve_forever, daemon=True); worker.start()
        (home / 'config.toml').write_text(
            f'[model_providers.deepseek]\nbase_url = "http://127.0.0.1:{server.server_port}"\n', encoding='utf-8')
        rpc = runtime._Rpc([], home, {'CODEX_HOME':str(home), 'HONGHAO_MODEL_TOKEN':'synthetic-only'})
        try:
            rpc.call('turn/start', {'threadId':'synthetic-thread', 'effort':'high',
                'input':[{'text':'PROXY_DELAY controlled response ordering'}]}, time.monotonic()+5)
            assert entered.wait(5)
            deltas = 0
            deadline = time.monotonic()+5
            while deltas < 3 and time.monotonic() < deadline:
                event = rpc.next(.25)
                if event and event.get('method')=='item/agentMessage/delta': deltas += 1
            assert deltas == 3
            assert rpc.next(1) is None, 'Native completion preceded the model response'
            release.set()
            event = rpc.next(5)
            assert event['method']=='turn/completed' and event['params']['turn']['status']=='completed'
        finally:
            release.set(); rpc.close(); server.shutdown(); worker.join(timeout=5)
            assert not worker.is_alive()


@pytest.mark.parametrize('recovery', ['resume_rejected', 'failed_turn', 'config_changed'])
def test_continuation_uses_owned_product_history_after_native_context_loss(controlled, monkeypatch, recovery):
    settings, client, _, config = controlled
    sent = []
    class Provider:
        sock = None
        def __init__(self, *args, **kwargs): pass
        def request(self, method, path, body, headers):
            assert isinstance(body, bytes), 'Chinese HTTP payload must be UTF-8 bytes'
            sent.append(json.loads(body.decode('utf-8')))
        def getresponse(self):
            class Result(io.BytesIO): status = 200
            return Result(b'data: {"type":"response.completed","response":{"usage":{"total_tokens":10}}}\n\n')
        def close(self): pass
    monkeypatch.setattr(runtime.http.client, 'HTTPSConnection', Provider)
    monkeypatch.setattr(runtime.CodexRuntime, '_proxy', ORIGINAL_PROXY)
    first = submit(client, mode='chat', content='PROXY_DELAY 喜欢的水果：pineapple')
    client.post(endpoint(first), json={})
    assert ended(client, endpoint(first))['status'] == 'completed'
    # A different owned conversation and future accepted input must never leak in.
    submit(client, mode='chat', content='FOREIGN_CONVERSATION_SECRET')
    if recovery == 'failed_turn':
        failure = client.post(f'/api/conversations/{first["conversation"]["id"]}/submissions', json={
            'mode':'chat', 'content':'RPC_ERROR', 'submission_key':str(uuid4())}).json()
        client.post(endpoint(failure), json={})
        assert ended(client, endpoint(failure))['status'] == 'failed'
    elif recovery == 'config_changed':
        config['fingerprint'] = 'new-config'
    else:
        original_rpc = runtime._Rpc
        def rejected_resume(*args, **kwargs):
            rpc = original_rpc(*args, **kwargs)
            original_call = rpc.call
            def call(method, params, deadline):
                if method == 'thread/resume': raise runtime.RuntimeBlocked('protocol_error')
                return original_call(method, params, deadline)
            rpc.call = call
            return rpc
        monkeypatch.setattr(runtime, '_Rpc', rejected_resume)
    follow = client.post(f'/api/conversations/{first["conversation"]["id"]}/submissions', json={
        'mode':'chat', 'content':'PROXY_DELAY what is my favorite fruit?', 'submission_key':str(uuid4())}).json()
    client.post(f'/api/conversations/{first["conversation"]["id"]}/submissions', json={
        'mode':'chat', 'content':'FUTURE_INPUT_SECRET', 'submission_key':str(uuid4())})
    client.post(endpoint(follow), json={})
    final = ended(client, endpoint(follow))
    assert final['status'] == 'completed', final['stop_reason']
    assert len(sent) == 2, 'Recovery replayed a model request'
    history = sent[-1]['input']
    assert history[-1]['role']=='user' and history[-1]['content'].endswith(follow['message']['content'])
    assert any(item['role']=='user' and 'pineapple' in item['content'] for item in history)
    assert 'synthetic runtime reply' in json.dumps(history)
    assert 'FOREIGN_CONVERSATION_SECRET' not in json.dumps(sent[-1])
    assert 'FUTURE_INPUT_SECRET' not in json.dumps(sent[-1])
    assert client.get('/api/tasks').json() == []


def test_model_context_is_bounded_without_truncating_current_input(controlled, monkeypatch):
    settings, client, users, config = controlled
    monkeypatch.setattr(runtime.CodexRuntime, '_execute', lambda *args: None)
    first = submit(client, mode='chat', content='old topic')
    conversation = first['conversation']['id']
    client.post(endpoint(first), json={})
    with transaction(settings.database_url, write=True) as db:
        runtime._finish(db, client.get(endpoint(first)).json()['id'], 'failed', 'protocol_error')
        for content in ('old response '*1000, '<｜｜DSML｜｜ calls> invalid tool output'):
            db.execute("INSERT INTO conversation_messages(id,conversation_id,owner_id,role,mode,content,created_at) VALUES(%s,%s,%s,'assistant','chat',%s,%s)", (str(uuid4()),conversation,users[0]['id'],content,'2026-10-08T00:00:00Z'))
    follow = client.post(f'/api/conversations/{conversation}/submissions', json={
        'mode':'chat', 'content':'complete current input 中文', 'submission_key':str(uuid4())}).json()
    run = client.post(endpoint(follow), json={}).json(); run['owner_id']=users[0]['id']
    controller = runtime.CodexRuntime(settings)
    history = controller._model_input(run, 500)
    assert history == [{'role':'user','content':follow['message']['content']}]
    assert len(json.dumps(history, ensure_ascii=False).encode()) <= 500
    with pytest.raises(runtime.RuntimeBlocked, match='model_budget'):
        controller._model_input(run, 10)


@pytest.mark.parametrize('prompt,reason', [('EOF','protocol_eof'), ('MALFORMED','protocol_eof'),
    ('TOOL','tool_unavailable'), ('DSML','tool_unavailable'), ('OUTPUT_BUDGET','output_budget'),('RPC_ERROR','protocol_error')])
def test_native_protocol_failures_keep_input_and_never_fake_success(controlled, prompt, reason,caplog):
    _, client, _, _ = controlled
    first = submit(client, content=prompt)
    path = endpoint(first)
    client.post(path, json={})
    run = ended(client, path)
    assert run['status'] == ('failed' if prompt in ('EOF','MALFORMED','RPC_ERROR') else 'blocked') and run['stop_reason'] == reason
    assert run['output'] == ('' if prompt in ('RPC_ERROR','DSML') else 'synthetic ')
    if prompt=='RPC_ERROR':
        assert 'stage=submit code=-32000' in caplog.text
        assert 'PRIVATE_NATIVE_ERROR_NOT_FOR_LOG_OR_UI' not in caplog.text+json.dumps(run)
    assert client.get('/api/health').status_code == client.get('/api/readiness').status_code == 200


def test_permission_change_stops_run_even_after_immediate_regrant(controlled):
    settings, client, users, _ = controlled
    first = submit(client, content='LONG')
    client.post(endpoint(first), json={})
    store = IdentityStore(settings.database_url)
    store.update_user(users[0]['id'], ai_enabled=False)
    store.update_user(users[0]['id'], ai_enabled=True)
    login(client, 'alice')
    value = ended(client, endpoint(first))
    assert value['status'] == 'blocked' and value['stop_reason'] == 'permission_changed'
    with transaction(settings.database_url) as db:
        assert db.execute('SELECT reusable FROM ai_contexts').fetchall() == [(0,)]


def test_restart_reconciles_without_replaying_and_runtime_fault_is_local(controlled, monkeypatch):
    settings, client, users, _ = controlled
    monkeypatch.setattr(runtime.CodexRuntime, '_execute', lambda *args: None)
    first = submit(client)
    original = client.post(endpoint(first), json={}).json()
    controller = runtime.CodexRuntime(settings)
    try:
        controller.recover()
    finally:
        controller.close()
    run = client.get(endpoint(first)).json()
    assert run['id'] == original['id'] and run['status'] == 'stopped' and run['stop_reason'] == 'controller_restart'
    assert client.post(endpoint(first), json={}).json()['id'] == original['id']
    monkeypatch.setattr(runtime.CodexRuntime, '_config', lambda self: runtime._require(False, 'runtime_version'))
    next_input = submit(client, content='separate target')
    assert client.post(endpoint(next_input), json={}).status_code == 503
    assert client.get(endpoint(next_input)).json() is None
    assert client.get('/api/projects').status_code == client.get('/api/readiness').status_code == 200
    assert not controller.scheduler.is_alive(), 'Recovered controller leaked its dispatcher'


def test_accepted_order_and_wall_clock_budget_are_enforced(controlled):
    _, client, _, config = controlled
    first = submit(client, content='LONG')
    second = client.post(f'/api/conversations/{first["message"]["conversation_id"]}/submissions', json={
        'mode': 'work', 'content': 'later', 'submission_key': str(uuid4())}).json()
    assert client.post(endpoint(second), json={}).status_code == 409
    config['seconds'] = 1
    client.post(endpoint(first), json={})
    value = ended(client, endpoint(first))
    assert value['status'] == 'blocked' and value['stop_reason'] == 'time_budget'
    client.post(endpoint(second), json={})
    assert ended(client, endpoint(second))['status'] == 'completed'


def test_model_proxy_rejects_strangers_and_limits_actual_requests(controlled, monkeypatch):
    settings, client, users, config = controlled
    monkeypatch.setattr(runtime.CodexRuntime, '_execute', lambda *args: None)
    first = submit(client)
    run = client.post(endpoint(first), json={}).json()
    run['owner_id'] = users[0]['id']; run['proxy_failure'] = None
    sent = []
    class Provider:
        sock = None
        def __init__(self, *args, **kwargs): pass
        def request(self, method, path, body, headers):
            sent.append(json.loads(body))
            assert headers['Authorization'] == 'Bearer synthetic-provider-key'
        def getresponse(self):
            class Result(io.BytesIO): status = 200
            return Result(b'data: {"type":"response.completed","response":{"usage":{"total_tokens":10}}}\n\n')
        def close(self): pass
    monkeypatch.setattr(runtime.http.client, 'HTTPSConnection', Provider)
    controller = runtime.CodexRuntime(settings)
    config['requests'] = 1
    checks=[]
    original_current=controller._current
    def counted_current(value,db=None):
        checks.append(db)
        return original_current(value,db)
    monkeypatch.setattr(controller,'_current',counted_current)
    server = ORIGINAL_PROXY(controller, run, config, 'private-token', 'synthetic-provider-key')
    def request(token):
        with closing(http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=5)) as connection:
            inputs=[{'type':'message','role':'developer','content':[{'type':'input_text','text':'PRIVATE_HARNESS_SETUP'*2000}]},
                    {'type':'message','role':'user','content':[{'type':'input_text','text':'<environment_context>PRIVATE_RUNTIME_PATH</environment_context>'}]},
                    {'type':'message','role':'user','content':[{'type':'input_text','text':'Native compacted summary: favorite fruit is pineapple.'}]},
                    {'type':'message','role':'user','content':[{'type':'input_text','text':first['message']['content']}]}]
            connection.request('POST','/responses',json.dumps({'model':'deepseek-flash','input':inputs,'tools':[{'name':'forbidden'}], 'previous_response_id':'foreign'}),{'Authorization':'Bearer '+token})
            response=connection.getresponse(); response.read(); return response.status
    try:
        assert request('wrong-token') == 404 and run['proxy_failure'] is None
        assert request('private-token') == 200
        assert len(checks)==2,'Empty SSE separators repeated the database authorization lookup'
        assert checks[0] is checks[1] and checks[0] is not None
        assert sent[0]['tools'] == [] and sent[0]['tool_choice'] == 'none'
        assert sent[0]['reasoning'] == {'effort':'high'}
        assert sent[0]['input']==[{'role':'user','content':'Native compacted summary: favorite fruit is pineapple.'},{'role':'user','content':first['message']['content']}]
        assert 'PRIVATE_' not in json.dumps(sent[0])
        assert sent[0]['max_output_tokens'] == config['output_tokens'] and 'previous_response_id' not in sent[0]
        assert request('private-token') == 502 and run['proxy_failure'] == 'model_budget'
        value = client.get(endpoint(first)).json()
        assert value['model_requests'] == 1 and value['reported_model_tokens'] == 10
        assert value['model_stream_started'] is True
        with runtime.connect(settings.database_url) as guard_db:
            assert not original_current(run,guard_db)['stop_requested']
            from api import postgres
            class LostLease:
                def execute(self,*args):raise OSError('Synthetic lost service lease')
            with monkeypatch.context() as lease_patch:
                lease_patch.setitem(postgres._LEASES,settings.database_url,LostLease())
                with pytest.raises(OSError,match='Synthetic lost service lease'):
                    original_current(run,guard_db)
            with transaction(settings.database_url,write=True) as db:
                db.execute('UPDATE task_runs SET stop_requested=1 WHERE id=%s',(run['id'],))
            assert original_current(run,guard_db)['stop_requested']
            IdentityStore(settings.database_url).update_user(users[0]['id'],ai_enabled=False)
            with pytest.raises(runtime.WorkspaceAccessError):
                original_current(run,guard_db)
    finally:
        server.shutdown(); server.server_close()


def test_large_utf8_history_and_compaction_share_a_token_only_budget(controlled, monkeypatch):
    settings, client, users, config = controlled
    monkeypatch.setattr(runtime.CodexRuntime, '_execute', lambda *args: None)
    first = submit(client, mode='chat', content='synthetic large history')
    run = client.post(endpoint(first),json={}).json()
    run.update(owner_id=users[0]['id'], proxy_failure=None)
    sent = []
    class Provider:
        sock = None
        def __init__(self,*args,**kwargs): pass
        def request(self,method,path,body,headers):
            sent.append(len(body))
            assert json.loads(body)['reasoning'] == {'effort':'high'}
        def getresponse(self):
            class Result(io.BytesIO): status = 200
            return Result(('data: '+json.dumps({'type':'response.completed','response':{'usage':{'total_tokens':943718}}})+'\n\n').encode())
        def close(self): pass
    monkeypatch.setattr(runtime.http.client,'HTTPSConnection',Provider)
    server = ORIGINAL_PROXY(runtime.CodexRuntime(settings),run,config,'private-token','synthetic-key')
    payload = json.dumps({'model':'deepseek-flash','input':[{'role':'user','content':'合成历史'*180000}]},ensure_ascii=False).encode()
    assert 1048576 < len(payload) < runtime.MODEL_REQUEST_BYTES
    try:
        statuses = []
        for _ in range(3):
            with closing(http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=10)) as connection:
                connection.request('POST','/responses',payload,{'Authorization':'Bearer private-token'})
                response = connection.getresponse(); response.read(); statuses.append(response.status)
        assert statuses == [200,200,502]
        assert len(sent) == 2 and run['proxy_failure'] == 'model_budget'
        assert client.get(endpoint(first)).json()['reported_model_tokens'] == 943718*2
        assert server.reserved_tokens == 0
        with closing(http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=10)) as connection:
            connection.request('POST','/responses',headers={'Authorization':'Bearer private-token','Content-Length':str(runtime.MODEL_REQUEST_BYTES+1)})
            response=connection.getresponse();response.read()
            assert response.status==502 and len(sent)==2 and run['proxy_failure']=='model_request'
    finally:
        server.shutdown();server.server_close()


def test_title_is_bounded_once_revision_safe_and_does_not_block_reply(controlled,monkeypatch):
    settings,client,users,config=controlled
    monkeypatch.setattr(runtime.CodexRuntime,'_execute',lambda *args:None)
    sent=[];rename=None;failed=False;hold=None;body_sent=threading.Event()
    class Provider:
        sock=None
        def __init__(self,*args,**kwargs):pass
        def request(self,method,path,body,headers):self.body=json.loads(body);sent.append(self.body);body_sent.set()
        def getresponse(self):
            if not self.body['stream']:
                assert self.body.get('reasoning')=={'effort':'none'},'Short title budget was consumed by hidden reasoning'
                if rename:rename()
                class Result(io.BytesIO):status=500 if failed else 200
                return Result(json.dumps({'usage':{'total_tokens':7},'output':[{'type':'message','content':[{'type':'output_text','text':'日常闲聊与兴趣话题'}]}]}).encode())
            class Result(io.BytesIO):
                status=200
                def readline(self,size):
                    if hold:assert hold.wait(5)
                    return super().readline(size)
            return Result(b'data: {"type":"response.completed","response":{"usage":{"total_tokens":10}}}\n\n')
        def close(self):pass
    monkeypatch.setattr(runtime.http.client,'HTTPSConnection',Provider)
    controller=runtime.CodexRuntime(settings)
    def rename_conversation(original):
        with transaction(settings.database_url,write=True) as db:
            db.execute('UPDATE conversations SET title=%s,revision=revision+1 WHERE id=%s',('本人手动命名',original['id']))
    for mode,case in [('chat','normal'),('work','normal'),('work','manual'),('work','failed'),('work','budget'),('work','stopped')]:
        content='合成标题验证：讨论近期兴趣、读书和日常生活。'*20
        first=submit(client,mode=mode,content=content,title=content[:28]+'…')
        run=client.post(endpoint(first),json={}).json();run['owner_id']=users[0]['id'];run['proxy_failure']=None
        original=first['conversation']
        if mode=='work' and case=='normal':
            original=client.patch('/api/conversations/'+original['id'],json={'pinned':True,'revision':original['revision']}).json()
        rename=(lambda:rename_conversation(original)) if case=='manual' else None
        failed=case=='failed';config['requests']=1 if case=='budget' else 8
        if case=='stopped':client.post(f'/api/conversations/{run["conversation_id"]}/executions/{run["id"]}/stop',json={})
        server=ORIGINAL_PROXY(controller,run,config,'private-token','synthetic-provider-key')
        def request(path,body=None):
            with closing(http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=5)) as connection:
                connection.request('POST',path,json.dumps(body or {'model':'deepseek-flash','input':[]}),{'Authorization':'Bearer private-token'})
                response=connection.getresponse();response.read();return response.status
        try:
            if case!='stopped':assert request('/responses')==200
            before=len(sent)
            assert request('/title') in (204,409,502)
            assert run['proxy_failure'] is None
            value=client.get(endpoint(first)).json()
            if case=='normal':
                assert value['conversation']['title']=='日常闲聊与兴趣话题' and value['conversation']['revision']==original['revision']+1
                assert len(value['activity'])==3,'Metadata appeared as a processing step'
                assert value['reported_model_tokens']==17
            elif case=='manual':
                assert value['conversation']['title']=='本人手动命名'
                assert client.get('/api/tasks').json()[-1]['objective']==content
            else:assert value['conversation']['title']==original['title']
            if mode=='work':
                task=client.get('/api/tasks').json()[-1]
                assert task['objective']==content
                assert task.get('title')==('日常闲聊与兴趣话题' if case in ('normal','manual') else None)
                assert value.get('task_title')==task.get('title')
                if case=='normal':
                    assert value['model_requests']==2,'Task naming duplicated the conversation title request'
                    assert value['conversation']['pinned'] is True and value['conversation']['archived'] is False
            if case=='failed':assert server.reserved_tokens>0,'Unknown title usage was released'
            assert request('/title') in (204,409)
            if case in ('budget','stopped'):assert len(sent)==before
            else:
                title_body=sent[before]
                assert title_body['max_output_tokens']==32 and not title_body['stream']
                assert title_body['input'][1]['content']==content[:256] and title_body['tools']==[]
                assert len(sent)==before+1,'Title was generated more than once'
            if case not in ('stopped','budget'):assert request('/responses')==200
            assert run['proxy_failure'] is None
        finally:
            server.shutdown();server.server_close()
            with transaction(settings.database_url,write=True) as db:runtime._finish(db,run['id'],'completed')
    # Older mixed conversations remain compatible: task naming uses its own
    # first objective and never overwrites the existing chat title.
    failed=False;rename=None;config.update(requests=8,tokens=runtime.MODEL_CONTEXT_WINDOW*2)
    first=submit(client,mode='chat',content='original chat topic',title='original chat topic')
    run=client.post(endpoint(first),json={}).json();run['owner_id']=users[0]['id'];run['proxy_failure']=None
    server=ORIGINAL_PROXY(controller,run,config,'private-token','synthetic-provider-key')
    try:assert request('/responses')==200 and request('/title')==204
    finally:server.shutdown();server.server_close()
    with transaction(settings.database_url,write=True) as db:runtime._finish(db,run['id'],'completed')
    path=f"/api/conversations/{first['conversation']['id']}/submissions"
    work=client.post(path,json={'mode':'work','content':'separate task objective','submission_key':str(uuid4())}).json()
    run=client.post(endpoint(work),json={}).json();run['owner_id']=users[0]['id'];run['proxy_failure']=None
    server=ORIGINAL_PROXY(controller,run,config,'private-token','synthetic-provider-key');before=len(sent)
    try:
        assert request('/responses')==200 and request('/title')==204
        assert sent[-1]['input'][1]['content']=='separate task objective'
        assert len(sent)==before+2
        assert client.get(endpoint(work)).json()['conversation']['revision']==2
        assert client.get('/api/tasks').json()[-1]['title']=='日常闲聊与兴趣话题'
    finally:server.shutdown();server.server_close()
    with transaction(settings.database_url,write=True) as db:runtime._finish(db,run['id'],'completed')
    next_input=client.post(path,json={'mode':'work','task_id':work['task']['id'],'content':'task supplement','submission_key':str(uuid4())}).json()
    assert next_input['task']['id']==work['task']['id'] and next_input['task']['title']=='日常闲聊与兴趣话题'
    run=client.post(endpoint(next_input),json={}).json();run['owner_id']=users[0]['id'];run['proxy_failure']=None
    server=ORIGINAL_PROXY(controller,run,config,'private-token','synthetic-provider-key');before=len(sent)
    try:
        assert request('/responses')==200 and request('/title')==204
        assert len(sent)==before+1,'Continuation generated another task title'
    finally:server.shutdown();server.server_close()
    with transaction(settings.database_url,write=True) as db:runtime._finish(db,run['id'],'completed')
    failed=False;rename=None;hold=threading.Event();body_sent.clear();config.update(requests=8,tokens=runtime.MODEL_CONTEXT_WINDOW+1024)
    first=submit(client,mode='chat',content='x'*3000,title='x'*28+'…')
    run=client.post(endpoint(first),json={}).json();run['owner_id']=users[0]['id'];run['proxy_failure']=None
    server=ORIGINAL_PROXY(controller,run,config,'private-token','synthetic-provider-key');before=len(sent)
    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            body=pool.submit(request,'/responses',{'model':'deepseek-flash','input':[{'role':'user','content':'x'*3000}]})
            assert server.body_started.wait(5)
            # Budget reservation precedes request-slot acquisition and provider dispatch.
            assert body_sent.wait(5), "Provider has not received the foreground request"
            assert request('/title')==204 and len(sent)==before+1
            hold.set();assert body.result(timeout=5)==200
        assert run['proxy_failure'] is None and server.reserved_tokens==0
    finally:hold.set();server.shutdown();server.server_close()


def test_stop_closes_delayed_model_connection_before_worker_ends(controlled, monkeypatch):
    settings, client, _, _ = controlled
    store=runtime.AIControlStore(settings.database_url,settings.data_dir)
    store.set_verified_capacity(2)
    with transaction(settings.database_url,write=True) as db:
        db.execute("UPDATE ai_control_settings SET value=jsonb_set(value,'{max_running}','2') WHERE section='concurrency'")
    released = threading.Event()
    body_entered = threading.Event()
    body_shutdown = threading.Event()
    title_closed = threading.Event()
    class Socket:
        def __init__(self, stream): self.stream = stream
        def shutdown(self, *args):
            if self.stream:
                body_shutdown.set(); released.set()
    class Provider:
        def __init__(self, *args, **kwargs): self.stream = None; self.sock = None
        def request(self, method, path, body, headers):
            self.stream = json.loads(body)['stream']
            self.sock = Socket(self.stream)
        def getresponse(self):
            if not self.stream:
                class TitleResult(io.BytesIO): status = 200
                return TitleResult(json.dumps({'output': [{'type': 'message', 'content': [{'type': 'output_text', 'text': '停止连接验证'}]}],
                                              'usage': {'total_tokens': 10}}).encode('utf-8'))
            class Result:
                status = 200
                def readline(self, size):
                    body_entered.set()
                    assert released.wait(45), 'Upstream connection was not cancelled'
                    return b''
            return Result()
        def close(self):
            if not self.stream: title_closed.set()
    monkeypatch.setattr(runtime.http.client, 'HTTPSConnection', Provider)
    monkeypatch.setattr(runtime.CodexRuntime, '_proxy', ORIGINAL_PROXY)
    first = submit(client, content='LONG PROXY_DELAY')
    path = endpoint(first)
    run = client.post(path, json={}).json()
    assert body_entered.wait(10), 'Body stream did not reach its delayed read'
    assert title_closed.wait(5), 'The independent title request did not finish'
    assert client.get(path).json()['model_requests'] == 2
    assert not released.is_set(), 'Closing the title connection released the body stream'
    started=time.monotonic()
    client.post(f'/api/conversations/{run["conversation_id"]}/executions/{run["id"]}/stop',json={})
    assert ended(client,path)['status'] == 'stopped'
    assert body_shutdown.is_set() and released.is_set() and time.monotonic()-started < 5


def test_context_storage_limit_blocks_without_deleting_records(controlled, monkeypatch):
    settings, client, users, config = controlled
    first=submit(client);client.post(endpoint(first),json={});initial=ended(client,endpoint(first))
    assert initial['status']=='completed', initial['stop_reason']
    with transaction(settings.database_url) as db:
        context=db.execute('SELECT context_id FROM task_runs WHERE input_message_id=%s',(first['message']['id'],)).fetchone()[0]
    oversized=settings.data_dir/'controlled-work/native'/UUID(users[0]['id']).hex/'contexts'/context/'home'/'oversized-cache'
    with oversized.open('wb') as stream: stream.truncate(67108865)
    follow=client.post(f'/api/conversations/{first["message"]["conversation_id"]}/submissions',json={
        'mode':'work','content':'continue after cache growth','submission_key':str(uuid4())}).json()
    client.post(endpoint(follow),json={})
    assert ended(client,endpoint(follow))['stop_reason']=='context_storage_budget'
    assert oversized.stat().st_size==67108865
    assert len(client.get('/api/tasks').json())==1


def test_os_recovery_failure_keeps_uncertain_state_and_business_reads(controlled, monkeypatch):
    settings,client,_,_=controlled
    monkeypatch.setattr(runtime.CodexRuntime,'_execute',lambda *args:None)
    first=submit(client);client.post(endpoint(first),json={})
    controller=runtime.CodexRuntime(settings);controller.config_path=None
    monkeypatch.setattr(runtime.CodexRuntime,'_stop_scope',ORIGINAL_STOP_SCOPE)
    monkeypatch.setattr(runtime.sys,'platform','linux')
    monkeypatch.setattr(runtime.subprocess,'run',lambda *args,**kwargs:type('Result',(),{'returncode':1})())
    controller.recover()
    assert controller.status()['status']=='blocked'
    assert client.get(endpoint(first)).json()['status']=='running'
    assert client.get('/api/projects').status_code==client.get('/api/readiness').status_code==200


@pytest.mark.parametrize('failure', ['scope', 'transport'])
def test_cleanup_failure_keeps_run_unconfirmed_and_blocks_new_execution(controlled, monkeypatch, failure):
    settings,client,_,_=controlled
    if failure == 'scope':
        monkeypatch.setattr(runtime.CodexRuntime,'_stop_scope',lambda *args:False)
    else:
        original_close = runtime._Rpc  # Fixture returns the actual transport.
        def broken_rpc(*args, **kwargs):
            rpc = original_close(*args, **kwargs)
            close = rpc.close
            def fail_close():
                close()
                raise OSError('synthetic cleanup failure')
            rpc.close = fail_close
            return rpc
        monkeypatch.setattr(runtime,'_Rpc',broken_rpc)
    first=submit(client);client.post(endpoint(first),json={})
    until=time.monotonic()+10
    while client.get('/api/conversations/runtime-status').json()['status']!='blocked' and time.monotonic()<until:
        time.sleep(.03)
    assert client.get('/api/conversations/runtime-status').json()['status']=='blocked'
    assert client.get(endpoint(first)).json()['phase']!='ended'
    with transaction(settings.database_url) as db:
        assert db.execute('SELECT COUNT(*) FROM conversation_messages WHERE run_id IS NOT NULL').fetchone()[0]==0
    another=submit(client)
    assert client.post(endpoint(another),json={}).status_code==503


def test_runtime_snapshot_preserves_context_events_output_and_owner(controlled, tmp_path, second_pg):
    from api.operations import _table_evidence, create_snapshot, restore_snapshot
    from api.settings import Settings
    settings,client,_,_=controlled
    first=submit(client);client.post(endpoint(first),json={});ended(client,endpoint(first))
    names={'ai_contexts','ai_run_events','task_runs','conversation_messages','tasks','conversations'}
    with transaction(settings.database_url) as db:
        before={name:value for name,value in _table_evidence(db).items() if name in names}
    snapshot=create_snapshot(settings,tmp_path/'snapshots')
    target=Settings.from_data_dir(tmp_path/'restored',database_url=second_pg['migration_url'])
    restore_snapshot(target,snapshot)
    with transaction(second_pg['url']) as db:
        assert {name:value for name,value in _table_evidence(db).items() if name in names}==before
