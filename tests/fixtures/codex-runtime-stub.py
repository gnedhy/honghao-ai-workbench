"""Deterministic stdio failure injection, never a sandbox/model verification."""
import json
import os
import sys
import threading
import time
import tomllib
import urllib.request

lock = threading.Lock()
cancelled = threading.Event()


def emit(value):
    with lock:
        print(json.dumps(value), flush=True)


def turn(thread, prompt):
    if 'PROXY_DELAY' in prompt:
        def model():
            try:
                config = tomllib.loads(open(os.path.join(os.environ['CODEX_HOME'], 'config.toml')).read())
                request = urllib.request.Request(config['model_providers']['deepseek']['base_url'] + '/responses',
                    data=json.dumps({'model': 'deepseek-flash', 'input': []}).encode(),
                    headers={'Authorization': 'Bearer ' + os.environ['HONGHAO_MODEL_TOKEN']})
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                with opener.open(request, timeout=45) as response: response.read()
            except Exception as error:
                with open(os.path.join(os.environ['CODEX_HOME'], 'stub-model-error'), 'w') as report:
                    cause = getattr(error, 'reason', error)
                    report.write(json.dumps({'type': type(error).__name__, 'cause': type(cause).__name__, 'errno': getattr(cause, 'errno', None)}))
        threading.Thread(target=model, daemon=True).start()
    for delta in ('synthetic ', 'runtime ', 'reply'):
        if cancelled.wait(0.12 if 'LONG' not in prompt else 0.5):
            break
        emit({'method': 'item/agentMessage/delta', 'params': {'threadId': thread, 'turnId': 'turn-1', 'itemId': 'item-1', 'delta': delta}})
        if 'EOF' in prompt:
            os._exit(0)
        if 'MALFORMED' in prompt:
            print('{broken', flush=True)
            os._exit(0)
        if 'TOOL' in prompt:
            emit({'id': 999, 'method': 'item/commandExecution/requestApproval', 'params': {'threadId': thread}})
            return
        if 'OUTPUT_BUDGET' in prompt:
            emit({'method': 'item/agentMessage/delta', 'params': {'threadId': thread, 'turnId': 'turn-1', 'delta': 'x' * 65537}})
            return
    if 'LONG' in prompt:
        cancelled.wait(10)
    emit({'method': 'turn/completed', 'params': {'threadId': thread, 'turn': {'id': 'turn-1', 'status': 'interrupted' if cancelled.is_set() else 'completed'}}})


for line in sys.stdin:
    request = json.loads(line)
    if 'id' not in request:
        continue
    method, params = request['method'], request.get('params', {})
    if method == 'initialize':
        assert params['capabilities']['experimentalApi'] is False
        assert not any(name in os.environ for name in ('DEEPSEEK_API_KEY', 'HONGHAO_DATABASE_URL', 'H01_DEEPSEEK_API_KEY'))
        result = {}
    elif method == 'skills/list':
        result = {'data': []}
    elif method in ('thread/start', 'thread/resume'):
        result = {'thread': {'id': params.get('threadId', 'synthetic-thread')}}
    elif method == 'turn/start':
        result = {'turn': {'id': 'turn-1'}}
    elif method == 'turn/interrupt':
        cancelled.set()
        result = {}
    else:
        result = {}
    emit({'id': request['id'], 'result': result})
    if method == 'turn/start':
        threading.Thread(target=turn, args=(params['threadId'], params['input'][0]['text']), daemon=True).start()
