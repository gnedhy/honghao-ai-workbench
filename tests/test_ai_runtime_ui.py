"""Actual App/PostgreSQL consumer with explicit synthetic native protocol injection."""
import json
import os
import socket
import subprocess
from threading import Thread
from time import monotonic, sleep

import uvicorn
from tests.test_ai_runtime import controlled
from tests.helpers import TEST_ADMIN_PASSWORD


def test_browser_ai_runtime_actual_consumers(controlled):
    _, client, _, _ = controlled
    with socket.socket() as listener:
        listener.bind(('127.0.0.1',0));listener.listen()
        server=uvicorn.Server(uvicorn.Config(client.app,log_level='error',lifespan='off'))
        thread=Thread(target=lambda:server.run(sockets=[listener]),daemon=True);thread.start()
        try:
            deadline=monotonic()+10
            while not server.started and thread.is_alive() and monotonic()<deadline: sleep(.02)
            assert server.started
            result=subprocess.run(['node','scripts/check-ai-runtime.mjs'],capture_output=True,text=True,encoding='utf-8',timeout=120,
                env={**os.environ,'H04_TEST_API':f'http://127.0.0.1:{listener.getsockname()[1]}','H04_TEST_PASSWORD':TEST_ADMIN_PASSWORD})
            assert result.returncode==0,result.stderr
            evidence=json.loads(result.stdout)
            assert len(evidence)==2 and all(row['status']=='passed' for row in evidence)
            print(result.stdout)
        finally:
            server.should_exit=True;thread.join(timeout=10)
            assert not thread.is_alive()
