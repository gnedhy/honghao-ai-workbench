"""Actual H05 App/API/PostgreSQL; native/model/OS injection is synthetic."""
import json
import os
import socket
import subprocess
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
            reply = subprocess.run(['node', 'scripts/check-ai-project-ui.mjs'], capture_output=True,
                text=True, encoding='utf-8', timeout=150, env={**os.environ,
                    'H05_TEST_API': f'http://127.0.0.1:{listener.getsockname()[1]}',
                    'H05_TEST_PASSWORD': TEST_ADMIN_PASSWORD})
            assert reply.returncode == 0, reply.stderr
            evidence = json.loads(reply.stdout)
            assert len(evidence) == 5 and all(row['status'] == 'passed' for row in evidence)
            print(reply.stdout)
        finally:
            server.should_exit = True; thread.join(timeout=10)
            assert not thread.is_alive()
