"""Actual H04 HTTP/controller/Codex/DeepSeek checks on an isolated Ubuntu test host.

Credentials come from protected service configuration, never arguments or receipts.
This command does not provision a database, change production or enable modules.
"""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import platform
import secrets
import subprocess
import sys
import time
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi.testclient import TestClient
from psycopg.conninfo import conninfo_to_dict
from api.main import create_app
from api.identity import IdentityStore
from api.postgres import transaction, connect, WRITE_LOCK
from api.settings import Settings


def check(condition, code):
    if not condition: raise RuntimeError(code)


def settings():
    parts=conninfo_to_dict(os.environ['HONGHAO_DATABASE_URL'])
    check(parts.get('host')=='127.0.0.1' and parts.get('dbname')=='honghao_test'
          and parts.get('user')=='honghao_test_app' and os.environ.get('HONGHAO_DATABASE_ENVIRONMENT')=='test', 'ISOLATED_DATABASE_REQUIRED')
    release=platform.freedesktop_os_release()
    check(sys.platform=='linux' and os.geteuid()!=0 and release.get('ID')=='ubuntu' and release.get('VERSION_ID')=='22.04','UBUNTU_NONROOT_REQUIRED')
    return Settings.from_data_dir(Path(os.environ['HONGHAO_DATA_DIR']),
        module_modes={'chat':'active','tasks':'active','knowledge':'off','automation':'off','workbench':'off'},
        workbench_modes={'procurement':'off','research':'off','sales':'off','management':'off'})


def path(value):
    return f'/api/conversations/{value["message"]["conversation_id"]}/messages/{value["message"]["id"]}/execution'


def read(client, route):
    result=client.get(route); check(result.status_code==200,'READ_EXECUTION'); return result.json()


def wait(client, route, *, partial=False):
    until=time.monotonic()+200
    while time.monotonic()<until:
        value=read(client,route)
        if value and (value['model_stream_started'] if partial else value['phase']=='ended'): return value
        if partial and value and value['phase']=='ended': raise RuntimeError('MODEL_STREAM_DID_NOT_START')
        time.sleep(.05)
    raise RuntimeError('EXECUTION_DEADLINE')


def submit(client, content, *, mode='work', conversation=None):
    request={'mode':mode,'content':content,'submission_key':str(uuid4())}
    if conversation:
        target=f'/api/conversations/{conversation}/submissions'
    else:
        request['title']='H04 synthetic validation'; target='/api/conversation-submissions'
    response=client.post(target,json=request); check(response.status_code==201,'ACCEPT_INPUT'); return response.json()


def start(client, value):
    result=client.post(path(value),json={}); check(result.status_code==200,'START_EXECUTION'); return result.json()


def validate(receipt):
    configured=settings()
    username='h04-'+uuid4().hex[:12]; password=secrets.token_urlsafe(24)
    IdentityStore(configured.database_url).create_user(username=username,display_name='H04 synthetic employee',
        department=None,password=password,ai_enabled=True)
    receipt['environment']={'os':platform.freedesktop_os_release()['PRETTY_NAME'],'kernel':platform.release(),
        'uid':os.geteuid(),'python':platform.python_version(),'databaseHost':'SSH loopback tunnel to isolated Windows PostgreSQL 18.6',
        'production':'not-tested'}
    receipt['checks']=[]
    def passed(name, **fields): receipt['checks'].append({'id':name,'status':'passed',**fields})
    with TestClient(create_app(configured)) as client:
        check(client.get('/api/readiness').status_code==200,'APP_READINESS')
        check(client.post('/api/login',json={'username':username,'password':password}).status_code==200,'LOGIN')
        check(client.get('/api/conversations/runtime-status').json()['status']=='configured','RUNTIME_CONFIGURATION')
        passed('qualified-nonroot-runtime-configuration')
        first=submit(client,'Echo exactly H04-CHAT-7316. This is synthetic.',mode='chat')
        start(client,first); chat=wait(client,path(first))
        check(chat['status']=='completed' and 'H04-CHAT-7316' in chat['output'],'REAL_CHAT')
        check(chat['task_id'] is None and client.get('/api/tasks').json()==[],'CHAT_NO_TASK')
        events=client.get(f'/api/conversations/{chat["conversation_id"]}/executions/{chat["id"]}/events').text
        check('event: delta' in events and 'threadId' not in events,'PRODUCT_STREAM')
        passed('real-chat-stream-without-task',deltas=events.count('event: delta'),modelNetworkMs=chat['model_network_ms'],reportedModelTokens=chat['reported_model_tokens'])
        first=submit(client,'Remember H04-WORK-9254 for this task and echo it. Do not use tools.')
        original=start(client,first); work=wait(client,path(first))
        check(work['status']=='completed' and 'H04-WORK-9254' in work['output'],'REAL_WORK')
        check(client.post(path(first),json={}).json()['id']==original['id'],'IDEMPOTENT_START')
        passed('real-work-idempotent-start',modelNetworkMs=work['model_network_ms'],reportedModelTokens=work['reported_model_tokens'])
        next_input=submit(client,'What was the original synthetic task marker? Echo it.',conversation=work['conversation_id'])
        check(next_input['task']['id']==first['task']['id'],'CONTINUOUS_TASK')
        start(client,next_input); resumed=wait(client,path(next_input))
        check(resumed['status']=='completed' and 'H04-WORK-9254' in resumed['output'],'NATIVE_RESUME')
        with transaction(configured.database_url) as db:
            count=db.execute('SELECT count(DISTINCT context_id) FROM task_runs WHERE task_id=%s',(first['task']['id'],)).fetchone()[0]
        check(count==1,'STABLE_CONTEXT')
        passed('real-process-restart-and-thread-resume',modelNetworkMs=resumed['model_network_ms'])
        long_input=submit(client,'Write 3000 numbered synthetic example sentences. Do not use tools.',conversation=work['conversation_id'])
        start(client,long_input); current=wait(client,path(long_input),partial=True)
        unit='honghao-ai-'+current['id']+'.scope'
        result=subprocess.run(['systemctl','--user','show',unit,'--property=MemoryMax,MemorySwapMax,TasksMax,CPUQuotaPerSecUSec'],capture_output=True,text=True,timeout=10)
        check(result.returncode==0,'SCOPE_READ')
        properties=dict(line.split('=',1) for line in result.stdout.splitlines() if '=' in line)
        check(properties.get('MemoryMax')=='805306368' and properties.get('MemorySwapMax')=='0' and properties.get('TasksMax')=='48' and properties.get('CPUQuotaPerSecUSec')=='1s','SCOPE_LIMITS')
        passed('actual-systemd-scope-resource-limits',**properties)
        stop=client.post(f'/api/conversations/{current["conversation_id"]}/executions/{current["id"]}/stop',json={})
        check(stop.status_code==200 and stop.json()['stop_requested']==1,'STOP_ACK')
        cancelled=wait(client,path(long_input))
        check(cancelled['status']=='stopped','REAL_CANCEL')
        passed('real-cancel-after-provider-stream-start',partialCharacters=len(cancelled['output']),modelNetworkMs=cancelled['model_network_ms'])
        check(client.get('/api/readiness').status_code==200,'BUSINESS_READY_AFTER_CANCEL')
        passed('runtime-does-not-block-application-readiness')
    # Normal controller restart retains only a verified completed context; no active replay.
    with TestClient(create_app(configured)) as client:
        check(client.post('/api/login',json={'username':username,'password':password}).status_code==200,'RELOGIN')
        check(read(client,path(long_input))['status']=='stopped','RESTART_TERMINAL_STABLE')
        check(client.post(path(long_input),json={}).json()['id']==cancelled['id'],'RESTART_NO_REPLAY')
        passed('controller-restart-no-replay-of-interrupted-input')
    receipt['status']='passed'


def main():
    parser=argparse.ArgumentParser(); parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    receipt={'status':'failed','scope':'isolated-H04-real-controller','runtimeVersion':'0.160.0'}
    try:
        configured=settings()
        with connect(configured.database_url) as lease:
            check(lease.execute('SELECT pg_try_advisory_lock(%s)',(WRITE_LOCK+1,)).fetchone()[0],'TEST_DATABASE_BUSY')
            validate(receipt)
    except Exception as error:
        # Keep only our fixed check codes; never native exceptions, response bodies or paths.
        receipt['failure']=str(error) if type(error) is RuntimeError and re_safe(str(error)) else 'H04_NATIVE_FAILURE'
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(receipt,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(receipt,ensure_ascii=False))
    return 0 if receipt['status']=='passed' else 1


def re_safe(value):
    return bool(value) and len(value)<80 and all(char in 'ABCDEFGHIJKLMNOPQRSTUVWXYZ_' for char in value)


if __name__=='__main__': raise SystemExit(main())
