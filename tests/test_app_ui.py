"""Actual App, feedback and static entry consumers on fixture-owned PostgreSQL."""
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


def test_browser_app_static_entry_and_feedback(ready, request):
    assert not (os.environ.get('W8_RED') and request.config.option.xmlpath), 'Original reproduction is not a gate'
    settings, client, _, store = ready
    settings.workbench_modes.update(sales='active', management='off')
    settings.module_modes.update(tasks='active', chat='active', workbench='active', knowledge='off', automation='off')
    identities = IdentityStore(settings.database_url)
    identities.create_user(username='w8-viewer', display_name='W8 合成查看者', department=None,
                           password=TEST_ADMIN_PASSWORD, scope_levels={'research': 2})
    identities.create_user(username='w8-none', display_name='W8 合成无权限', department=None,
                           password=TEST_ADMIN_PASSWORD)
    with transaction(settings.database_url) as db:
        before = _table_evidence(db)
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0)); listener.listen()
        server = uvicorn.Server(uvicorn.Config(client.app, lifespan='off', log_level='critical', access_log=False))
        thread = Thread(target=server.run, kwargs={'sockets': [listener]}, daemon=True); thread.start()
        try:
            deadline = monotonic() + 10
            while not server.started and thread.is_alive() and monotonic() < deadline: sleep(.02)
            assert server.started
            result = subprocess.run(['node', 'scripts/check-app.mjs'], capture_output=True, text=True,
                encoding='utf-8', timeout=420, env={**os.environ,
                    'W8_TEST_API': f'http://127.0.0.1:{listener.getsockname()[1]}',
                    'W8_TEST_PASSWORD': TEST_ADMIN_PASSWORD})
            stderr = re.sub(r'(?i)(honghao_session=)[^\s\x27\x22;]+', r'\1[redacted]', result.stderr)
            assert result.returncode == 0, stderr
            evidence = json.loads(result.stdout); print(result.stdout)
            assert len({row['name'] for row in evidence}) == len(evidence) == 40
            assert all(row['status'] == 'passed' for row in evidence)
            with transaction(settings.database_url) as db:
                after = _table_evidence(db)
            # One deliberate synthetic calculator save; exits/example must not write elsewhere.
            protected = lambda k: k.startswith(('sales_', 'research_', 'procurement_')) and k != 'sales_calculator_saved'
            assert {k: v for k, v in after.items() if protected(k)} == {k: v for k, v in before.items() if protected(k)}
            saved = client.get('/api/workbenches/sales/calculator/saved').json()['saved']
            assert len(saved) == 1 and saved[0]['payload']['source']['cost'] == '4'
        finally:
            server.should_exit = True; thread.join(timeout=10)
            assert not thread.is_alive()
