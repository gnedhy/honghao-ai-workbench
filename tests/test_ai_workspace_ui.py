"""Actual App and account editor against the owned PostgreSQL fixture."""
import json
import os
import socket
import subprocess
from threading import Thread
from time import monotonic, sleep

import uvicorn

from api.identity import IdentityStore
from tests.helpers import authenticated_client, TEST_ADMIN_PASSWORD
from tests.test_tasks import chat_and_task_settings


def test_browser_ai_workspace_actual_consumers(tmp_path):
    settings = chat_and_task_settings(tmp_path/'data')
    with authenticated_client(settings) as client, socket.socket() as listener:
        for username in ('h03-alice','h03-bob'):
            IdentityStore(settings.database_url).create_user(username=username,display_name=username,
                department=None,password=TEST_ADMIN_PASSWORD,ai_enabled=True)
        listener.bind(('127.0.0.1',0)); listener.listen()
        server = uvicorn.Server(uvicorn.Config(client.app,log_level='error',lifespan='off'))
        thread = Thread(target=lambda:server.run(sockets=[listener]),daemon=True); thread.start()
        try:
            deadline=monotonic()+10
            while not server.started and thread.is_alive() and monotonic()<deadline:
                sleep(.02)
            assert server.started
            result = subprocess.run(['node','scripts/check-ai-workspace.mjs'],capture_output=True,
                text=True,encoding='utf-8',timeout=180,env={**os.environ,
                    'H03_TEST_API':f'http://127.0.0.1:{listener.getsockname()[1]}',
                    'H03_TEST_PASSWORD':TEST_ADMIN_PASSWORD})
            assert result.returncode == 0, result.stderr
            evidence=json.loads(result.stdout)
            assert len(evidence)==3 and all(row['status']=='passed' for row in evidence)
            print(result.stdout)
        finally:
            server.should_exit=True; thread.join(timeout=10)
            assert not thread.is_alive()
