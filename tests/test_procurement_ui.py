"""Actual procurement and research consumers on the fixture-owned test API."""
import json
import os
import re
import socket
import subprocess
from threading import Thread
from time import monotonic, sleep

import uvicorn

from api.identity import IdentityStore
from api.operations import _table_evidence
from api.postgres import transaction
from tests.helpers import TEST_ADMIN_PASSWORD
from tests.test_procurement_rd5 import data, trial_data
from tests.test_research_workbench import ready
from tests.test_procurement_isolation import import_prices, publish


def test_browser_procurement_and_research(ready):
    settings, client, admin, store = ready
    current = import_prices(client, '2026-09-09', [(f'W6-{i:03}', 10) for i in range(32)])
    assert publish(client, current).status_code == 200
    store.process_events()
    overview = client.get('/api/workbenches/procurement/overview').json()
    frozen = {row['id']: client.get('/api/workbenches/procurement/batches/' + row['id']).json()['items'] for row in overview['batches']}
    with transaction(settings.database_url) as db:
        sales_before = {name: value for name, value in _table_evidence(db).items() if name.startswith('sales_')}
    IdentityStore(settings.database_url).create_user(username='w6-readonly', display_name='合成只读',
        department=None, password=TEST_ADMIN_PASSWORD, scope_levels={'research': 2})
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0)); listener.listen()
        server = uvicorn.Server(uvicorn.Config(client.app, lifespan='off', log_level='critical', access_log=False))
        thread = Thread(target=server.run, kwargs={'sockets': [listener]}, daemon=True)
        thread.start()
        deadline = monotonic() + 10
        try:
            while not server.started and thread.is_alive() and monotonic() < deadline: sleep(.02)
            assert server.started
            result = subprocess.run(['node', 'scripts/check-procurement.mjs'],
                env={**os.environ, 'W6_TEST_API': f'http://127.0.0.1:{listener.getsockname()[1]}', 'W6_TEST_PASSWORD': TEST_ADMIN_PASSWORD},
                capture_output=True, text=True, encoding='utf-8', timeout=300)
            stderr = re.sub(r'(?i)(honghao_session=)[^\s\x27\x22;]+', r'\1[redacted]', result.stderr)
            assert result.returncode == 0, stderr
            evidence = json.loads(result.stdout)
            print(result.stdout)
            assert len({row['name'] for row in evidence}) == len(evidence) == 11
            assert all(row['status'] == 'passed' for row in evidence)
            for key, items in frozen.items():
                assert client.get('/api/workbenches/procurement/batches/' + key).json()['items'] == items
            final = client.get('/api/workbenches/procurement/overview').json()
            prices = {row['code']: row['published_price'] for row in final['materials']}
            assert prices['A'] == '60' and prices['W6-000'] == '0' and prices['W6-001'] == '14'
            assert prices['W6-002'] == '12' and prices['W6-004'] == '11' and prices['W6-005'] == '11'
            assert final['current_update'] is None
            with transaction(settings.database_url) as db:
                assert {name: value for name, value in _table_evidence(db).items() if name.startswith('sales_')} == sales_before
        finally:
            server.should_exit = True; thread.join(timeout=10)
            assert not thread.is_alive()
