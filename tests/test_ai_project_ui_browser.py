"""Actual H05 App/API/PostgreSQL; native/model/OS injection is synthetic."""
import json
import os
import re
import socket
import subprocess
from pathlib import Path
from threading import Thread
from time import monotonic, sleep

import uvicorn
from api.postgres import transaction
from tests.test_ai_runtime import controlled
from tests.helpers import TEST_ADMIN_PASSWORD


def test_browser_ai_project_ui_actual_consumers(controlled):
    settings, client, _, _ = controlled
    with transaction(settings.database_url,write=True) as db:
        db.execute("INSERT INTO projects(id,title) VALUES('h05-legacy-project','历史合成项目')")
        db.execute("INSERT INTO conversations(id,title,project_id) VALUES('h05-legacy-conversation','历史合成会话','h05-legacy-project')")
        db.execute("INSERT INTO conversation_messages(id,conversation_id,mode,content,created_at,task_id) VALUES('h05-legacy-message','h05-legacy-conversation','work','历史合成目标','2026-01-01T00:00:00Z',NULL)")
        db.execute("INSERT INTO tasks(id,conversation_id,objective,project_id,status,created_at,message_id) VALUES('h05-legacy-task','h05-legacy-conversation','历史合成目标','h05-legacy-project','created','2026-01-01T00:00:00Z','h05-legacy-message')")
        db.execute("UPDATE conversation_messages SET task_id='h05-legacy-task' WHERE id='h05-legacy-message'")
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0)); listener.listen()
        server = uvicorn.Server(uvicorn.Config(client.app, log_level='error', lifespan='off'))
        thread = Thread(target=lambda: server.run(sockets=[listener]), daemon=True); thread.start()
        try:
            deadline = monotonic() + 10
            while not server.started and thread.is_alive() and monotonic() < deadline: sleep(.02)
            assert server.started
            output = Path(os.environ.get('H05_UI_OUTPUT', '.scratch/h05-ui'))
            output.mkdir(parents=True, exist_ok=True)
            try:
                with (output / 'driver-stdout.log').open('w', encoding='utf-8') as stdout, (output / 'driver-stderr.log').open('w', encoding='utf-8') as stderr:
                    reply = subprocess.run(['node', 'scripts/check-ai-project-ui.mjs'], stdout=stdout, stderr=stderr,
                        timeout=150, env={**os.environ,
                            'H05_TEST_API': f'http://127.0.0.1:{listener.getsockname()[1]}',
                            'H05_TEST_PASSWORD': TEST_ADMIN_PASSWORD})
            except subprocess.TimeoutExpired:
                # Only fixed stage names and numeric timings may enter CI diagnostics.
                progress = [line for line in (output / 'driver-stderr.log').read_text(encoding='utf-8').splitlines()
                    if re.fullmatch(r'H05 runtime v[0-9.]+|H05 modules (?:status [0-9]{3}|request failed)|H05 (?:server ready|title animation) [0-9]+ ms|(?:START|PASS) (?:h05|h07|ai-config)-[a-z-]+(?: [0-9]+ ms)?', line)]
                raise AssertionError('H05 driver exceeded 150s; stages: ' + '; '.join(progress)) from None
            assert reply.returncode == 0, (output / 'driver-stderr.log').read_text(encoding='utf-8')
            result = (output / 'driver-stdout.log').read_text(encoding='utf-8')
            evidence = json.loads(result)
            assert len(evidence) == 8 and all(row['status'] == 'passed' for row in evidence)
            print(result)
        finally:
            server.should_exit = True; thread.join(timeout=10)
            assert not thread.is_alive()
