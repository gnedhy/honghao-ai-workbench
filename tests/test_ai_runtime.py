"""Owned PostgreSQL + real controller/stdio; model, Linux scope and sandbox are mocked."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path
import sys
import time
import io
import json
import http.client
import threading
from uuid import uuid4

import pytest

from api import codex_runtime as runtime
from api.identity import IdentityStore
from api.postgres import transaction
from tests.helpers import authenticated_client, TEST_ADMIN_PASSWORD
from tests.test_ai_workspace import login, submit
from tests.test_tasks import chat_and_task_settings

ORIGINAL_PROXY = runtime.CodexRuntime._proxy
ORIGINAL_STOP_SCOPE = runtime.CodexRuntime._stop_scope


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
    assert events.count('event: delta') == 3 and events.count('event: state') == 3
    assert 'threadId' not in events and 'synthetic-thread' not in events
    assert client.get(events_path, headers={'Last-Event-ID': '2'}).text.count('event: state') == 1
    assert client.get(events_path, params={'after': 100}).status_code == 409
    assert client.get(events_path, headers={'Last-Event-ID': 'bad'}).status_code == 400
    assert client.post(path, json={'cwd': '/etc'}).status_code == 422
    assert client.get('/api/tasks').json()[0]['status'] == 'completed'
    assert client.get(f'/api/conversations/{run["conversation_id"]}/messages').json()[-1]['run_id'] == run['id']
    second = client.post(f'/api/conversations/{run["conversation_id"]}/submissions', json={
        'mode': 'work', 'content': 'follow up', 'submission_key': str(uuid4())}).json()
    assert second['task']['id'] == first['task']['id']
    client.post(endpoint(second), json={})
    assert ended(client, endpoint(second))['status'] == 'completed'
    with transaction(settings.database_url) as db:
        assert db.execute('SELECT count(*) FROM ai_contexts').fetchone() == (1,)
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


@pytest.mark.parametrize('prompt,reason', [('EOF','protocol_eof'), ('MALFORMED','protocol_eof'),
    ('TOOL','tool_unavailable'), ('OUTPUT_BUDGET','output_budget')])
def test_native_protocol_failures_keep_input_and_never_fake_success(controlled, prompt, reason):
    _, client, _, _ = controlled
    first = submit(client, content=prompt)
    path = endpoint(first)
    client.post(path, json={})
    run = ended(client, path)
    assert run['status'] == ('failed' if prompt in ('EOF','MALFORMED') else 'blocked') and run['stop_reason'] == reason
    assert run['output'] == 'synthetic '
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
    controller.recover()
    run = client.get(endpoint(first)).json()
    assert run['id'] == original['id'] and run['status'] == 'stopped' and run['stop_reason'] == 'controller_restart'
    assert client.post(endpoint(first), json={}).json()['id'] == original['id']
    monkeypatch.setattr(runtime.CodexRuntime, '_config', lambda self: runtime._require(False, 'runtime_version'))
    next_input = submit(client, content='separate target')
    assert client.post(endpoint(next_input), json={}).status_code == 503
    assert client.get(endpoint(next_input)).json() is None
    assert client.get('/api/projects').status_code == client.get('/api/readiness').status_code == 200


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
    server = ORIGINAL_PROXY(controller, run, config, 'private-token', 'synthetic-provider-key')
    def request(token):
        with closing(http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=5)) as connection:
            connection.request('POST','/responses',json.dumps({'model':'deepseek-flash','tools':[{'name':'forbidden'}], 'previous_response_id':'foreign'}),{'Authorization':'Bearer '+token})
            response=connection.getresponse(); response.read(); return response.status
    try:
        assert request('wrong-token') == 404 and run['proxy_failure'] is None
        assert request('private-token') == 200
        assert sent[0]['tools'] == [] and sent[0]['tool_choice'] == 'none'
        assert sent[0]['max_output_tokens'] == config['output_tokens'] and 'previous_response_id' not in sent[0]
        assert request('private-token') == 502 and run['proxy_failure'] == 'model_budget'
        value = client.get(endpoint(first)).json()
        assert value['model_requests'] == 1 and value['reported_model_tokens'] == 10
        assert value['model_stream_started'] is True
    finally:
        server.shutdown(); server.server_close()


def test_stop_closes_delayed_model_connection_before_worker_ends(controlled, monkeypatch):
    settings, client, _, _ = controlled
    released = threading.Event()
    class Socket:
        def shutdown(self, *args): released.set()
    class Provider:
        sock = Socket()
        def __init__(self, *args, **kwargs): pass
        def request(self, *args): pass
        def getresponse(self):
            class Result:
                status = 200
                def readline(self, size):
                    assert released.wait(45), 'Upstream connection was not cancelled'
                    return b''
            return Result()
        def close(self): released.set()
    monkeypatch.setattr(runtime.http.client, 'HTTPSConnection', Provider)
    monkeypatch.setattr(runtime.CodexRuntime, '_proxy', ORIGINAL_PROXY)
    first = submit(client, content='LONG PROXY_DELAY')
    path = endpoint(first)
    run = client.post(path, json={}).json()
    until=time.monotonic()+10
    while not client.get(path).json()['model_requests'] and time.monotonic()<until: time.sleep(.02)
    assert client.get(path).json()['model_requests'] == 1
    started=time.monotonic()
    client.post(f'/api/conversations/{run["conversation_id"]}/executions/{run["id"]}/stop',json={})
    assert ended(client,path)['status'] == 'stopped'
    assert released.is_set() and time.monotonic()-started < 5


def test_context_storage_limit_blocks_without_deleting_records(controlled, monkeypatch):
    settings, client, _, config = controlled
    first=submit(client);client.post(endpoint(first),json={});ended(client,endpoint(first))
    with transaction(settings.database_url) as db:
        context=db.execute('SELECT context_id FROM task_runs WHERE input_message_id=%s',(first['message']['id'],)).fetchone()[0]
    oversized=config['runtime_root']/context/'home'/'oversized-cache'
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
