"""Mounted independent calculator against the fixture-owned API and PostgreSQL."""
import json
import os
import re
import socket
import subprocess
from threading import Thread
from time import monotonic, sleep

import uvicorn

from api.operations import _table_evidence
from api.identity import IdentityStore
from api.postgres import transaction
from api.sales_calculator import CalculatorStore, SavedInput
from tests.helpers import TEST_ADMIN_PASSWORD
from tests.test_sales import sales


def test_browser_sales_calculator(sales):
    settings, client, store, actor = sales
    snapshot = CalculatorStore(store).save(SavedInput(kind='workspace', payload={
        'source': {'kind': 'product', 'product_id': 'research:recipe:Q', 'basis': 'latest'},
        'panels': [{'id': 'frozen-panel', 'name': '旧成本', 'mode': 'domestic_direct', 'steps': []}],
    }), actor)
    with transaction(settings.database_url, write=True) as db:
        db.execute("UPDATE research_cost_records SET payload=jsonb_set(payload::jsonb,'{latest_cost}', '\"12\"'::jsonb) WHERE product_id='recipe:Q'")
    with transaction(settings.database_url) as db:
        before = {name: row for name, row in _table_evidence(db).items()
                  if name.startswith(('sales_', 'procurement_', 'research_')) and name != 'sales_calculator_saved'}
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        listener.listen()
        server = uvicorn.Server(uvicorn.Config(client.app, lifespan='off', log_level='critical', access_log=False))
        thread = Thread(target=server.run, kwargs={'sockets': [listener]}, daemon=True)
        thread.start()
        deadline = monotonic() + 10
        try:
            while not server.started and thread.is_alive() and monotonic() < deadline:
                sleep(.02)
            assert server.started
            result = subprocess.run(['node', 'scripts/check-sales-calculator.mjs'],
                                    env={**os.environ, 'W5_TEST_API': f'http://127.0.0.1:{listener.getsockname()[1]}',
                                         'W5_TEST_PASSWORD': TEST_ADMIN_PASSWORD, 'W5_SNAPSHOT_ID': snapshot['id']},
                                    capture_output=True, text=True, encoding='utf-8', timeout=180)
            stderr = re.sub(r'(?i)(honghao_session=)[^\s\x27\x22;]+', r'\1[redacted]', result.stderr)
            assert result.returncode == 0, stderr
            evidence = json.loads(result.stdout)
            print(result.stdout)
            assert len({row['name'] for row in evidence}) == len(evidence) == 8
            assert all(row['status'] == 'passed' for row in evidence)
            with transaction(settings.database_url) as db:
                after = {name: row for name, row in _table_evidence(db).items()
                         if name.startswith(('sales_', 'procurement_', 'research_')) and name != 'sales_calculator_saved'}
                assert after == before
                for row in evidence:
                    for key in row['ids']:
                        assert db.execute('SELECT revision FROM sales_calculator_saved WHERE id=%s', (key,)).fetchone()[0] == 1
        finally:
            server.should_exit = True
            thread.join(timeout=10)
            assert not thread.is_alive()


def test_calculator_http_private_permissions_and_conflict(sales):
    settings, client, _, _ = sales
    prefix = '/api/workbenches/sales/calculator'
    identities = IdentityStore(settings.database_url)
    password = 'Calculator-Password-2026'
    users = {level: identities.create_user(username=f'calculator-{level}', display_name=f'测算{level}',
                                           department=None, password=password, scope_levels={'sales': level} if level else {'procurement': 2})
             for level in (0, 2, 3, 4)}
    payload = {'source': {'kind': 'manual', 'cost': '0'},
               'panels': [{'id': 'p', 'name': '边界', 'mode': 'export_direct', 'steps': []}]}
    body = {'kind': 'workspace', 'payload': payload}
    with transaction(settings.database_url) as db:
        before = {name: row for name, row in _table_evidence(db).items()
                  if name.startswith(('sales_', 'procurement_', 'research_')) and name != 'sales_calculator_saved'}

    def login(level):
        client.post('/api/logout')
        assert client.post('/api/login', json={'username': f'calculator-{level}', 'password': password}).status_code == 200

    client.post('/api/logout')
    assert client.get(prefix + '/saved').status_code == 401
    assert client.post(prefix + '/evaluate', json=payload).status_code == 401
    assert client.post(prefix + '/saved', json=body).status_code == 401
    login(0)
    assert client.get(prefix + '/saved').status_code == 403
    assert client.post(prefix + '/evaluate', json=payload).status_code == 403
    login(3)
    result = client.post(prefix + '/saved', json=body)
    assert result.status_code == 200
    saved = result.json()
    key = prefix + '/saved/' + saved['id']
    changed = {**body, 'revision': 1, 'name': '新版本'}
    assert client.put(key, json=changed).json()['revision'] == 2
    assert client.put(key, json=changed).status_code == 409
    assert client.get(prefix + '/saved').json()['saved'][0]['revision'] == 2
    login(2)
    assert client.get(prefix + '/saved').json() == {'saved': []}
    evaluated = client.post(prefix + '/evaluate', json=payload)
    assert evaluated.status_code == 200, evaluated.json()
    assert evaluated.json()['results'][0]['result']['price'] == '0.00'
    assert client.post(prefix + '/saved', json=body).status_code == 403
    assert client.put(key, json={**body, 'revision': 2}).status_code == 403
    assert client.delete(key).status_code == 403
    login(4)
    assert client.get(prefix + '/saved').json() == {'saved': []}
    assert client.put(key, json={**body, 'revision': 2}).status_code == 404
    assert client.delete(key).status_code == 404
    login(3)
    assert client.delete(key).status_code == 200
    identities.update_user(users[3]['id'], scope_levels={'sales': 2})
    assert client.post(prefix + '/saved', json=body).status_code == 401
    with transaction(settings.database_url) as db:
        after = {name: row for name, row in _table_evidence(db).items()
                 if name.startswith(('sales_', 'procurement_', 'research_')) and name != 'sales_calculator_saved'}
        assert after == before
