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
context_file = os.path.join(os.environ['CODEX_HOME'], 'stub-context.json')
history = []


def emit(value):
    with lock:
        print(json.dumps(value), flush=True)


def turn(thread, prompt):
    prompt = prompt.rsplit('\nCurrent message:\n',1)[-1]
    if prompt=='DSML':
        emit({'method':'item/agentMessage/delta','params':{'threadId':thread,'turnId':'turn-1','delta':'<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="exec">'}})
        return
    if 'H05' in prompt:
        usage={'last':{'totalTokens':2400},'total':{'totalTokens':18000},'modelContextWindow':996147}
        emit({'method':'thread/tokenUsage/updated','params':{'threadId':'foreign-thread','turnId':'turn-1','tokenUsage':{**usage,'last':{'totalTokens':9999}}}})
        emit({'method':'thread/tokenUsage/updated','params':{'threadId':thread,'turnId':'turn-1','tokenUsage':usage}})
        for method in ('item/started','item/completed'):
            emit({'method':method,'params':{'threadId':thread,'turnId':'turn-1','item':{'type':'contextCompaction','id':'compact-1'}}})
            if method=='item/started' and prompt=='H05 first work':cancelled.wait(1.5)
        emit({'method':'item/started','params':{'threadId':thread,'turnId':'turn-1','item':{'type':'reasoning','id':'reasoning-1'}}})
        if prompt!='H05 summary-only':emit({'method':'item/reasoning/summaryTextDelta','params':{'threadId':thread,'turnId':'turn-1','itemId':'reasoning-1','summaryIndex':0,'delta':'核对合成输入，准备回复。'}})
        emit({'method':'item/reasoning/textDelta','params':{'threadId':thread,'turnId':'turn-1','itemId':'reasoning-1','delta':'PRIVATE_SYNTHETIC_REASONING_NOT_FOR_UI'}})
        emit({'method':'item/reasoning/summaryTextDelta','params':{'threadId':'foreign-thread','turnId':'turn-1','itemId':'reasoning-1','summaryIndex':0,'delta':'FOREIGN_SYNTHETIC_SUMMARY'}})
        if prompt=='H05 summary-only':emit({'method':'item/completed','params':{'threadId':thread,'turnId':'turn-1','item':{'type':'reasoning','id':'reasoning-1','summary':['核对合成输入，准备回复。'],'content':['PRIVATE_SYNTHETIC_REASONING_NOT_FOR_UI']}}})
        if prompt=='H05 chat question':cancelled.wait(1.5)
    model_done = None
    if 'PROXY_DELAY' in prompt:
        model_done = threading.Event()
        def model():
            try:
                config = tomllib.loads(open(os.path.join(os.environ['CODEX_HOME'], 'config.toml')).read())
                request = urllib.request.Request(config['model_providers']['deepseek']['base_url'] + '/responses',
                    data=json.dumps({'model': 'deepseek-flash', 'input': history}).encode(),
                    headers={'Authorization': 'Bearer ' + os.environ['HONGHAO_MODEL_TOKEN']})
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                with opener.open(request, timeout=45) as response: response.read()
            except Exception as error:
                with open(os.path.join(os.environ['CODEX_HOME'], 'stub-model-error'), 'w') as report:
                    cause = getattr(error, 'reason', error)
                    report.write(json.dumps({'type': type(error).__name__, 'cause': type(cause).__name__, 'errno': getattr(cause, 'errno', None)}))
            finally:
                model_done.set()
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
    if 'MARKDOWN' in prompt:
        markdown='\n\n## 合成排班表\n\n**合成说明**：按人员和日期核对。\n\n| 人员 | 周一 | 周二 | 周三 | 周四 | 周五 | 周六 | 周日 |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| 合成员工甲 | 早班 | 中班 | 晚班 | 早班 | 中班 | 晚班 | 休息 |\n\n- 第一项\n- 第二项\n\n> 仅用于测试\n\n```python\nprint("synthetic")\n```\n\n[安全链接](https://example.com) [不安全链接](javascript:alert(1))\n\n![合成图片](https://invalid.example/synthetic.png)\n\n<script>window.syntheticMarkdownExecuted=true</script>\n'
        emit({'method':'item/agentMessage/delta','params':{'threadId':thread,'turnId':'turn-1','itemId':'item-1','delta':markdown}})
    if 'LONG' in prompt:
        cancelled.wait(10)
    if model_done is not None:
        while not cancelled.is_set() and not model_done.wait(.02):
            pass
    if not cancelled.is_set():
        history.append({'role':'assistant','content':'synthetic runtime reply'})
        with open(context_file,'w') as stored: json.dump(history,stored)
    emit({'method': 'turn/completed', 'params': {'threadId': thread, 'turn': {'id': 'turn-1', 'status': 'interrupted' if cancelled.is_set() else 'completed'}}})


for line in sys.stdin:
    request = json.loads(line)
    if 'id' not in request:
        continue
    method, params = request['method'], request.get('params', {})
    if method == 'initialize':
        assert params['capabilities']['experimentalApi'] is True
        assert not any(name in os.environ for name in ('DEEPSEEK_API_KEY', 'HONGHAO_DATABASE_URL', 'H01_DEEPSEEK_API_KEY'))
        result = {}
    elif method == 'skills/list':
        result = {'data': []}
    elif method in ('thread/start', 'thread/resume'):
        if method=='thread/resume' and os.path.exists(context_file):
            with open(context_file) as stored: history=json.load(stored)
        else: history=[]
        result = {'thread': {'id': params.get('threadId', 'synthetic-thread')}}
    elif method == 'turn/start':
        assert params['effort'] == 'high'
        if params['input'][0]['text'].rsplit('\nCurrent message:\n',1)[-1]=='RPC_ERROR':
            emit({'id':request['id'],'error':{'code':-32000,'message':'PRIVATE_NATIVE_ERROR_NOT_FOR_LOG_OR_UI'}})
            continue
        history.append({'role':'user','content':params['input'][0]['text']})
        result = {'turn': {'id': 'turn-1'}}
    elif method == 'turn/interrupt':
        cancelled.set()
        result = {}
    else:
        result = {}
    emit({'id': request['id'], 'result': result})
    if method == 'turn/start':
        threading.Thread(target=turn, args=(params['threadId'], params['input'][0]['text']), daemon=True).start()
