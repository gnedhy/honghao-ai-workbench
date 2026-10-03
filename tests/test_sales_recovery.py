"""Real browser/API/PostgreSQL recovery; only the conftest-controlled test database."""
import json
import os
import re
import socket
import subprocess
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from threading import Thread
from time import monotonic, sleep
from uuid import uuid4

import pytest
import uvicorn

from api.postgres import transaction
from api.sales import NewBatch
from tests.helpers import TEST_ADMIN_PASSWORD
from tests.test_sales import prepared, sales  # Reuse the synthetic catalog and authenticated test app.


def test_sales_request_replay_binding_permissions_and_versions(sales):
    settings, client, store, actor = sales
    base = '/api/workbenches/sales/batches'
    create = dict(name='W2 合成重试', mode='domestic_direct', request_id=str(uuid4()))
    first = client.post(base, json=create)
    assert first.status_code == 200
    batch = first.json()['batch']
    assert batch['id'] == create['request_id']
    body = NewBatch.model_validate(create).model_dump()
    with ThreadPoolExecutor(max_workers=2) as pool:
        concurrent = list(pool.map(lambda _: store.create(deepcopy(body), actor), range(2)))
    assert all(result['batch'] == batch for result in concurrent)
    assert client.post(base, json=create).json()['batch'] == batch
    assert client.post(base, json=dict(create, name='另一个请求')).status_code == 409
    assert client.post(base, json=dict(create, request_id='not-a-uuid')).status_code == 422
    other = dict(id='other', is_system_admin=False, scope_levels={'sales': 4})
    with pytest.raises(PermissionError):
        store.create(body, other)
    with pytest.raises(RuntimeError):
        store.create(body, dict(other, is_system_admin=True))
    key = base + '/' + batch['id']
    draft = {field: deepcopy(batch[field]) for field in ('revision', 'name', 'mode', 'customer_name', 'customer_code', 'uncoded', 'salesperson', 'items')}
    draft.update(request_id=str(uuid4()), customer_name='W2 合成客户', salesperson='W2 合成销售', uncoded=True,
                 items=[dict(product_id='research:recipe:Q', final_price='5.000')])
    saved = client.put(key + '/draft', json=draft)
    assert saved.status_code == 200
    assert client.put(key + '/draft', json=draft).json() == saved.json()
    assert client.put(key + '/draft', json=dict(draft, customer_name='不同内容')).status_code == 409
    assert client.post(base, json=create).status_code == 409
    calculate = dict(request_id=str(uuid4()), revision=2, product_ids=['research:recipe:Q'], confirm_manual_prices=True)
    calculated = client.post(key + '/calculate', json=calculate)
    assert calculated.status_code == 200
    assert client.post(key + '/calculate', json=calculate).json() == calculated.json()
    assert client.post(key + '/calculate', json=dict(calculate, confirm_manual_prices=False)).status_code == 409
    assert client.put(key + '/draft', json=draft).status_code == 409
    for user in [other, dict(actor, is_system_admin=False, scope_levels={'sales': 0})]:
        with pytest.raises(PermissionError):
            store.trial(batch['id'], calculate, user)
    with pytest.raises(RuntimeError):
        store.trial(batch['id'], calculate, dict(other, is_system_admin=True))
    later = dict(draft, request_id=str(uuid4()), revision=3, customer_name='W2 后续修改')
    assert client.put(key + '/draft', json=later).status_code == 200
    assert client.post(key + '/calculate', json=calculate).status_code == 409
    detail = client.get(key).json()
    assert detail['batch']['revision'] == 4
    assert [event['kind'] for event in detail['events']] == ['create', 'save_draft', 'calculate', 'save_draft']
    with transaction(settings.database_url) as db:
        assert db.execute('SELECT count(*) FROM sales_batches').fetchone()[0] == 1
        assert db.execute('SELECT count(*) FROM sales_trials').fetchone()[0] == 1


def test_browser_sales_recovery(sales, request):
    assert not (os.environ.get('W4_QUOTE_ONLY') == '1' and request.config.option.xmlpath), 'JUnit gate requires all 18 browser scenarios'
    settings, client, _, _ = sales
    snapshot = prepared(sales)
    # A real newer catalog cost; the previously saved quote must retain cost 4.
    with transaction(settings.database_url, write=True) as db:
        db.execute("UPDATE research_cost_records SET payload=jsonb_set(payload::jsonb,'{latest_cost}', '\"12\"'::jsonb) WHERE product_id='recipe:Q'")
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        listener.listen()
        port = listener.getsockname()[1]
        # authenticated_client owns startup/shutdown and the database service lease.
        server = uvicorn.Server(uvicorn.Config(client.app, lifespan='off', log_level='critical', access_log=False))
        thread = Thread(target=server.run, kwargs={'sockets': [listener]}, daemon=True)
        thread.start()
        deadline = monotonic() + 10
        try:
            while not server.started and thread.is_alive() and monotonic() < deadline:
                sleep(.02)
            assert server.started
            result = subprocess.run(
                ['node', 'scripts/check-sales-recovery.mjs'],
                env={**os.environ, 'W2_TEST_API': f'http://127.0.0.1:{port}', 'W2_TEST_PASSWORD': TEST_ADMIN_PASSWORD, 'W4_SNAPSHOT_BATCH': snapshot['id']},
                capture_output=True, text=True, encoding='utf-8', timeout=180,
            )
            print(result.stdout)
            stderr = re.sub(r'(?i)(honghao_session=)[^\s\x27\x22;]+', r'\1[redacted]', result.stderr)
            result.stderr = stderr
            assert result.returncode == 0, stderr
            evidence = json.loads(result.stdout)
            names = [case['name'] for case in evidence]
            assert len(names) == len(set(names)) == (5 if os.environ.get('W4_QUOTE_ONLY') == '1' else 18)
            assert all(case['status'] == 'passed' for case in evidence)
            with transaction(settings.database_url) as db:
                for case in evidence:
                    if not case.get('id'):
                        continue
                    key = case['id']
                    assert db.execute('SELECT revision FROM sales_batches WHERE id=%s', (key,)).fetchone()[0] == case['revision']
                    assert db.execute('SELECT count(*) FROM sales_trials WHERE batch_id=%s', (key,)).fetchone()[0] == case['trials']
                    assert db.execute('SELECT count(*) FROM sales_events WHERE batch_id=%s', (key,)).fetchone()[0] == case['events']
        finally:
            server.should_exit = True
            thread.join(timeout=10)
            assert not thread.is_alive()
