"""Real research edit/refresh consumers against fixture-owned PostgreSQL."""
import json
import os
import re
import socket
import subprocess
from pathlib import Path
from threading import Thread
from time import monotonic, sleep

import uvicorn
from api.identity import IdentityStore
from api.operations import _table_evidence
from api.postgres import transaction
from tests.helpers import TEST_ADMIN_PASSWORD
from tests.test_procurement_rd5 import data, trial_data
from tests.test_research_workbench import ready, records, K, RH


def test_browser_dashboard_history_and_price_movements():
    result = subprocess.run(['node', 'scripts/check-workbench-loading.mjs'], capture_output=True, text=True,
                            encoding='utf-8', timeout=90)
    assert result.returncode == 0, result.stderr
    assert 'PASS sales-hot-product-existing-drawer' in result.stdout
    assert 'PASS research-history-periods-and-material-price-arrows' in result.stdout
    assert 'PASS research-material-drilldown-return-history-and-focus' in result.stdout
    assert 'PASS research-reference-back-in-drawer-header' in result.stdout


def test_browser_research_edit_and_read_lifecycle(ready):
    settings, client, _, store = ready
    settings.workbench_modes['sales'] = 'active'
    frozen = records(store.url)
    with transaction(settings.database_url) as db:
        sales_before = {k: v for k, v in _table_evidence(db).items() if k.startswith('sales_')}
    IdentityStore(settings.database_url).create_user(username='w7-readonly', display_name='合成只读', department=None,
        password=TEST_ADMIN_PASSWORD, scope_levels={'research': 2})
    sync = settings.data_dir / 'w7-sync'; sync.mkdir()
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0)); listener.listen()
        server = uvicorn.Server(uvicorn.Config(client.app, lifespan='off', log_level='critical', access_log=False))
        thread = Thread(target=server.run, kwargs={'sockets': [listener]}, daemon=True); thread.start()
        deadline = monotonic() + 10; process = None
        try:
            while not server.started and thread.is_alive() and monotonic() < deadline: sleep(.02)
            assert server.started
            with (sync/'stdout').open('w', encoding='utf-8') as out, (sync/'stderr').open('w', encoding='utf-8') as err:
                process = subprocess.Popen(['node', 'scripts/check-research.mjs'], stdout=out, stderr=err,
                    env={**os.environ, 'W7_TEST_API': f'http://127.0.0.1:{listener.getsockname()[1]}',
                         'W7_TEST_PASSWORD': TEST_ADMIN_PASSWORD, 'W7_SYNC_DIR': str(sync)})
                deadline = monotonic() + 420; handled = ''
                while process.poll() is None:
                    if monotonic() > deadline: process.kill(); process.wait(); raise AssertionError('Research browser timed out')
                    request = (sync/'request').read_text() if (sync/'request').exists() else ''
                    if request and request != handled:
                        store.process_events(); handled = request; (sync/'done').write_text(request)
                    sleep(.02)
            stderr = re.sub(r'(?i)(honghao_session=)[^\s\x27\x22;]+', r'\1[redacted]', (sync/'stderr').read_text(encoding='utf-8'))
            assert process.returncode == 0, stderr
            evidence = json.loads((sync/'stdout').read_text(encoding='utf-8')); print(json.dumps(evidence))
            assert len({r['name'] for r in evidence}) == len(evidence) == 18
            assert all(r['status'] == 'passed' for r in evidence)
            assert records(store.url)[:len(frozen)] == frozen
            assert store.detail(K)['draft'] is None and store.detail(K)['product']['revision'] == 2
            assert store.detail(K)['latest']['cost'] == '0' and store.detail(RH)['latest']['cost'] == '0'
            with transaction(settings.database_url) as db:
                assert {k: v for k, v in _table_evidence(db).items() if k.startswith('sales_')} == sales_before
        finally:
            if process is not None and process.poll() is None:
                process.terminate()
                try: process.wait(timeout=10)
                except subprocess.TimeoutExpired: process.kill(); process.wait()
            server.should_exit = True; thread.join(timeout=10); assert not thread.is_alive()
