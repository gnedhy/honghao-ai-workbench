"""Private Codex controller. Product IDs and durable events never expose native RPC."""
from __future__ import annotations

from collections import deque
from contextlib import suppress
from datetime import UTC, datetime
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, HTTPServer
import http.client
import json
import os
from pathlib import Path
import queue
import re
import signal
import socket
import ssl
import subprocess
import sys
import threading
import time
from uuid import uuid4

from psycopg.types.json import Jsonb
from api.database import _actor, _one, _resource, _rows, WorkspaceAccessError, WorkspaceConflictError, WorkspaceNotFoundError
from api.postgres import transaction

VERSION = '0.160.0'
BINARY_HASH = '12eb3e81114588aca3b7998f4f19e8997b056aca08e57a7ca7c8a3ec8c652aad'
BWRAP_HASH = '01fb705f067bd5365b63d8ad2323a61c8d007733ca5e649437e086f3fb9935d8'
CATALOG_HASH = '58d5ee5823efdd60cbba574c2dad3c3663c9933966fd1d1f0497875fa2753391'
ACTIVE = ('running', 'waiting')
PUBLIC_COLUMNS = "id,task_id,conversation_id,input_message_id,status,phase,started_at,ended_at,stop_reason,stop_requested,output,runtime_version,event_seq,model_requests,model_tokens AS reported_model_tokens,model_network_ms,EXISTS(SELECT 1 FROM ai_run_events e WHERE e.run_id=task_runs.id AND e.kind='state' AND e.payload->>'model_stream_started'='true') AS model_stream_started"
LIMITS = {'seconds': (180, 10, 600), 'requests': (8, 1, 16), 'tokens': (24000, 1024, 100000),
          'output_tokens': (4096, 128, 8192), 'memory_mib': (768, 256, 1536), 'processes': (48, 16, 64)}


class RuntimeBlocked(Exception):
    """Only fixed safe codes; native errors/credentials are never part of messages."""


def _require(condition, reason):
    if not condition:
        raise RuntimeBlocked(reason)


def _protected(path, *, private=False):
    path = Path(path)
    _require(path.is_absolute() and not path.is_symlink(), 'runtime_configuration')
    resolved = path.resolve(strict=True)
    _require(resolved == path and resolved.stat().st_uid in (0, os.geteuid()), 'runtime_configuration')
    _require(resolved.stat().st_mode & (0o077 if private else 0o022) == 0, 'runtime_configuration')
    return resolved


def _event(db, run, kind, payload):
    seq = db.execute('UPDATE task_runs SET event_seq=event_seq+1 WHERE id=%s RETURNING event_seq', (run,)).fetchone()[0]
    db.execute('INSERT INTO ai_run_events(run_id,seq,kind,payload) VALUES(%s,%s,%s,%s)', (run, seq, kind, Jsonb(payload)))


def _finish(db, run, status, reason=None):
    row = _one(db, "UPDATE task_runs SET status=%s,phase='ended',ended_at=%s,stop_reason=%s WHERE id=%s AND status IN ('running','waiting') RETURNING *", (status, datetime.now(UTC).isoformat(), reason, run))
    if row is None:
        return
    if row['task_id']:
        db.execute('UPDATE tasks SET status=%s,revision=revision+1 WHERE id=%s', (status, row['task_id']))
    if status != 'completed' and row['context_id']:
        db.execute('UPDATE ai_contexts SET reusable=0 WHERE id=%s', (row['context_id'],))
    if row['output']:
        message = db.execute('SELECT mode FROM conversation_messages WHERE id=%s', (row['input_message_id'],)).fetchone()
        db.execute("INSERT INTO conversation_messages(id,conversation_id,owner_id,role,mode,content,created_at,task_id,run_id) VALUES(%s,%s,%s,'assistant',%s,%s,%s,%s,%s)", (str(uuid4()), row['conversation_id'], row['owner_id'], message[0], row['output'], row['ended_at'], row['task_id'], run))
    _event(db, run, 'state', {'status': status, 'phase': 'ended', 'reason': reason})


class CodexRuntime:
    def __init__(self, settings):
        self.settings = settings
        self.url = settings.database_url
        self.config_path = os.environ.get('HONGHAO_CODEX_CONFIG')
        self.workers: dict[str, threading.Thread] = {}
        self.lock = threading.Lock()
        self.closing = False
        self.failure = None

    def recover(self):
        # Called only after the application's existing exclusive database lease.
        with transaction(self.url) as db:
            active = _rows(db, "SELECT id,context_id FROM task_runs WHERE status IN ('running','waiting')")
        for row in active:
            if row['context_id'] and not self._stop_scope(row['id']):
                self.failure = 'runtime_recovery'
        if self.failure:
            return  # Do not claim stopped while an old OS scope remains uncertain.
        with transaction(self.url, write=True) as db:
            for row in db.execute("SELECT id FROM task_runs WHERE status IN ('running','waiting')").fetchall():
                _finish(db, row[0], 'stopped', 'controller_restart')

    def _stop_scope(self, run_id):
        # Cleanup is independent of model configuration, including after config loss.
        if sys.platform != 'linux' or os.geteuid() == 0:
            return False
        env = {'PATH': '/usr/bin:/bin', 'XDG_RUNTIME_DIR': f'/run/user/{os.geteuid()}',
               'DBUS_SESSION_BUS_ADDRESS': f'unix:path=/run/user/{os.geteuid()}/bus'}
        unit = 'honghao-ai-' + run_id + '.scope'
        try:
            stopped = subprocess.run(['systemctl', '--user', 'stop', unit], env=env,
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=8)
            if stopped.returncode not in (0, 5):
                return False
            state = subprocess.run(['systemctl', '--user', 'show', unit, '--property=ActiveState', '--value'],
                env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=8)
            return state.returncode == 0 and state.stdout.strip() == b'inactive'
        except (OSError, subprocess.TimeoutExpired):
            return False

    def _config(self):
        _require(self.config_path, 'runtime_not_configured')
        _require(sys.platform == 'linux' and os.geteuid() != 0 and os.uname().machine == 'x86_64', 'linux_service_identity')
        import grp
        groups = {grp.getgrgid(group).gr_name for group in os.getgroups()}
        _require(not groups & {'sudo', 'docker', 'lxd', 'incus-admin', 'root', 'adm', 'disk', 'shadow', 'systemd-journal', 'libvirt', 'backup'}, 'linux_service_identity')
        status = Path('/proc/self/status').read_text()
        _require(re.search(r'^CapEff:\s*0+$', status, re.M), 'linux_service_identity')
        path = _protected(self.config_path, private=True)
        _require(path.stat().st_size <= 16384, 'runtime_configuration')
        config = json.loads(path.read_text(encoding='utf-8'))
        _require(isinstance(config, dict) and set(config) <= {'binary', 'catalog', 'key_file', 'runtime_root', *LIMITS}, 'runtime_configuration')
        for name in ('binary', 'catalog', 'key_file', 'runtime_root'):
            _require(isinstance(config.get(name), str), 'runtime_configuration')
            config[name] = _protected(config[name], private=name in ('key_file', 'runtime_root'))
        _require(config['runtime_root'].is_dir() and config['runtime_root'].stat().st_uid == os.geteuid(), 'runtime_configuration')
        _require(os.access(config['runtime_root'], os.R_OK | os.W_OK | os.X_OK), 'runtime_configuration')
        _require(all(config[name].is_file() and os.access(config[name], os.R_OK) for name in ('binary','catalog','key_file')), 'runtime_configuration')
        _require(os.access(config['binary'], os.X_OK), 'runtime_configuration')
        _require(all(not config[name].is_relative_to(config['runtime_root']) for name in ('key_file', 'binary', 'catalog')), 'runtime_configuration')
        _require(not path.is_relative_to(config['runtime_root']), 'runtime_configuration')
        for name, (default, low, high) in LIMITS.items():
            value = config.get(name, default)
            _require(type(value) is int and low <= value <= high, 'runtime_configuration')
            config[name] = value
        _require(hashlib.sha256(config['binary'].read_bytes()).hexdigest() == BINARY_HASH, 'runtime_version')
        bwrap = _protected(config['binary'].parent / 'codex-resources' / 'bwrap')
        _require(os.access(bwrap, os.X_OK), 'runtime_configuration')
        _require(hashlib.sha256(bwrap.read_bytes()).hexdigest() == BWRAP_HASH, 'runtime_version')
        catalog = json.loads(config['catalog'].read_text(encoding='utf-8'))
        _require(hashlib.sha256(json.dumps(catalog, sort_keys=True, separators=(',', ':')).encode()).hexdigest() == CATALOG_HASH, 'runtime_version')
        config['fingerprint'] = hashlib.sha256(json.dumps({k: str(v) for k, v in config.items()}, sort_keys=True).encode()).hexdigest()
        return config

    def status(self):
        try:
            _require(not self.failure, 'runtime_recovery')
            self._config()
            return {'status': 'configured', 'version': VERSION, 'reason': None}
        except RuntimeBlocked as error:
            return {'status': 'blocked', 'version': VERSION, 'reason': str(error)}
        except (OSError, ValueError, TypeError, KeyError):
            return {'status': 'blocked', 'version': VERSION, 'reason': 'runtime_configuration'}

    def _owned(self, db, conversation, run, actor):
        _resource(db, 'conversations', conversation, actor, write=True)
        row = _one(db, f'SELECT {PUBLIC_COLUMNS} FROM task_runs WHERE id=%s AND conversation_id=%s AND owner_id=%s', (run, conversation, actor))
        if row is None:
            raise WorkspaceNotFoundError('Run not found')
        return row

    def get(self, conversation, message, actor):
        with transaction(self.url) as db:
            _resource(db, 'conversations', conversation, actor, write=True)
            row = _resource(db, 'conversation_messages', message, actor, write=True)
            if row['conversation_id'] != conversation:
                raise WorkspaceNotFoundError('Message not found')
            return _one(db, f'SELECT {PUBLIC_COLUMNS} FROM task_runs WHERE input_message_id=%s AND context_id IS NOT NULL', (message,))

    def start(self, conversation, message, actor):
        with self.lock:
            existing = self.get(conversation, message, actor)
            if existing:
                return existing
            _require(not self.closing and not self.failure, 'runtime_unavailable')
            self.workers = {key: value for key, value in self.workers.items() if value.is_alive()}
            _require(not self.workers, 'runtime_busy')  # ponytail: one model worker; add concurrency after host capacity testing.
            try:
                config = self._config()
            except (OSError, ValueError, TypeError, KeyError):
                raise RuntimeBlocked('runtime_configuration') from None
            with transaction(self.url, write=True) as db:
                convo = _resource(db, 'conversations', conversation, actor, write=True)
                source = _resource(db, 'conversation_messages', message, actor, write=True)
                if source['conversation_id'] != conversation or source['role'] != 'user' or not source['submission_receipt']:
                    raise WorkspaceNotFoundError('Accepted input not found')
                self._modules(source['mode'])
                if db.execute("SELECT 1 FROM task_runs WHERE conversation_id=%s AND status IN ('running','waiting')", (conversation,)).fetchone():
                    raise WorkspaceConflictError('Conversation already running')
                pending = db.execute("SELECT 1 FROM conversation_messages m WHERE conversation_id=%s AND role='user' AND submission_receipt IS NOT NULL AND _order < %s AND NOT EXISTS (SELECT 1 FROM task_runs r WHERE r.input_message_id=m.id AND r.context_id IS NOT NULL)", (conversation, source['_order'])).fetchone()
                if pending:
                    raise WorkspaceConflictError('Execute earlier accepted input first')
                task = _resource(db, 'tasks', source['task_id'], actor, write=True) if source['task_id'] else None
                project_id = task['project_id'] if task else convo['project_id']
                project = _resource(db, 'projects', project_id, actor, write=True) if project_id else None
                fingerprint = hashlib.sha256(json.dumps([config['fingerprint'], source['mode'], source['task_id'], project_id, project['revision'] if project else None]).encode()).hexdigest()
                context = _one(db, 'SELECT * FROM ai_contexts WHERE owner_id=%s AND conversation_id=%s AND task_id IS NOT DISTINCT FROM %s ORDER BY _order DESC LIMIT 1', (actor, conversation, source['task_id']))
                if context and (not context['reusable'] or context['fingerprint'] != fingerprint):
                    context = None
                if not context:
                    context = _one(db, 'INSERT INTO ai_contexts(id,owner_id,conversation_id,task_id,fingerprint) VALUES(%s,%s,%s,%s,%s) RETURNING *', (str(uuid4()), actor, conversation, source['task_id'], fingerprint))
                run = _one(db, "INSERT INTO task_runs(id,task_id,owner_id,input_message_id,conversation_id,context_id,status,started_at,runtime_version) VALUES(%s,%s,%s,%s,%s,%s,'running',%s,%s) RETURNING *", (str(uuid4()), source['task_id'], actor, message, conversation, context['id'], datetime.now(UTC).isoformat(), VERSION))
                if task:
                    db.execute("UPDATE tasks SET status='running',revision=revision+1 WHERE id=%s", (task['id'],))
                _event(db, run['id'], 'state', {'status': 'running', 'phase': 'starting', 'reason': None})
            worker = threading.Thread(target=self._execute, args=(run, context, source['content'], config), daemon=True)
            self.workers[run['id']] = worker
            worker.start()
            return self.get(conversation, message, actor)

    def _modules(self, mode):
        _require(self.settings.module_modes['chat'] != 'off' and (mode == 'chat' or self.settings.module_modes['tasks'] != 'off'), 'module_unavailable')

    def active(self, conversation, actor):
        with transaction(self.url) as db:
            _resource(db, 'conversations', conversation, actor, write=True)
            return _one(db, f"SELECT {PUBLIC_COLUMNS} FROM task_runs WHERE conversation_id=%s AND context_id IS NOT NULL AND status IN ('running','waiting')", (conversation,))

    def stop(self, conversation, run, actor):
        with transaction(self.url, write=True) as db:
            row = self._owned(db, conversation, run, actor)
            if row['status'] in ACTIVE:
                db.execute('UPDATE task_runs SET stop_requested=1 WHERE id=%s', (run,))
                row['stop_requested'] = 1
            return row

    def events(self, conversation, run, actor, after):
        with transaction(self.url) as db:
            row = self._owned(db, conversation, run, actor)
            if after > row['event_seq']:
                raise WorkspaceConflictError('Event position changed; reconcile execution')
            events = _rows(db, 'SELECT seq,kind,payload FROM ai_run_events WHERE run_id=%s AND seq>%s ORDER BY seq LIMIT 64', (run, after))
            return row, events

    def _current(self, run):
        with transaction(self.url) as db:
            _actor(db, run['owner_id'])
            row = _one(db, 'SELECT r.*,m.mode FROM task_runs r JOIN conversation_messages m ON m.id=r.input_message_id WHERE r.id=%s', (run['id'],))
            self._modules(row['mode'])
            _require(row['status'] in ACTIVE, 'run_ended')
            return row

    def close(self):
        self.closing = True
        with transaction(self.url, write=True) as db:
            db.execute("UPDATE task_runs SET stop_requested=1 WHERE status IN ('running','waiting')")
        for worker in tuple(self.workers.values()):
            # Keep the database lease until bounded native/HTTP cleanup actually completes.
            while worker.is_alive():
                worker.join(timeout=1)

    def _execute(self, run, context, prompt, config):
        rpc = None
        server = None
        scope_attempted = False
        status, reason = 'failed', 'runtime_failed'
        run['proxy_failure'] = None
        deadline = time.monotonic() + config['seconds']
        try:
            root = config['runtime_root'] / context['id']
            root.mkdir(mode=0o700, exist_ok=True)
            home, cwd = root / 'home', root / 'cwd'
            for path in (root, home, cwd):
                path.mkdir(mode=0o700, exist_ok=True)
                _protected(path, private=True)
            _require(sum(path.stat().st_size for path in root.rglob('*') if not path.is_symlink() and path.is_file()) <= 67108864, 'context_storage_budget')
            token = uuid4().hex + uuid4().hex
            key_text = config['key_file'].read_text(encoding='utf-8-sig')
            keys = set(re.findall(r'(?<![\w-])sk-[A-Za-z0-9_-]{16,}(?![\w-])', key_text))
            _require(len(keys) == 1, 'model_configuration')
            key = keys.pop()
            server = self._proxy(run, config, token, key)
            env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': str(home), 'CODEX_HOME': str(home),
                   'LANG': 'C.UTF-8', 'HONGHAO_MODEL_TOKEN': token,
                   'XDG_RUNTIME_DIR': f'/run/user/{os.geteuid()}', 'DBUS_SESSION_BUS_ADDRESS': f'unix:path=/run/user/{os.geteuid()}/bus'}
            (home / 'config.toml').write_text(_configuration(config, home, cwd, server.server_port, self.config_path), encoding='utf-8')
            (home / 'config.toml').chmod(0o600)
            self._sandbox(config, home, cwd, env, server.server_port)
            command = ['systemd-run', '--user', '--scope', '--quiet', '--unit=honghao-ai-' + run['id'],
                       f'--property=MemoryMax={config["memory_mib"]}M', '--property=MemorySwapMax=0',
                       f'--property=TasksMax={config["processes"]}', '--property=CPUQuota=100%',
                       '/usr/bin/prlimit', '--nofile=256:256', '--fsize=67108864:67108864', '--',
                       str(config['binary']), 'app-server', '--listen', 'stdio://']
            def check():
                _require(not run['proxy_failure'], run['proxy_failure'] or 'model_failed')
                current = self._current(run)
                _require(not current['stop_requested'], current['stop_reason'] or 'stop_before_start')
            scope_attempted = True
            rpc = _Rpc(command, cwd, env, check=check)
            rpc.call('initialize', {'clientInfo': {'name': 'honghao_workbench', 'version': '1'}, 'capabilities': {'experimentalApi': False}}, deadline)
            rpc.send({'method': 'initialized', 'params': {}})
            # Disable all automatically discovered skills, including packaged/system skills.
            listing = rpc.call('skills/list', {'cwds': [str(cwd)], 'forceReload': True}, deadline)
            for entry in listing['data']:
                for skill in entry['skills']:
                    if skill['enabled']:
                        rpc.call('skills/config/write', {'path': skill['path'], 'enabled': False}, deadline)
            params = {'cwd': str(cwd), 'model': 'deepseek-flash', 'modelProvider': 'deepseek'}
            if context['thread_id']:
                started = rpc.call('thread/resume', {**params, 'threadId': context['thread_id'], 'excludeTurns': True}, deadline)
            else:
                started = rpc.call('thread/start', {**params, 'baseInstructions': 'Use only the submitted text. Tools, file access, web search and side effects are unavailable. Respond in the language of the user.'}, deadline)
            thread = started['thread']['id']
            with transaction(self.url, write=True) as db:
                _actor(db, run['owner_id'])
                db.execute('UPDATE ai_contexts SET thread_id=%s WHERE id=%s', (thread, context['id']))
            _require(not self._current(run)['stop_requested'], 'stop_before_start')
            result = rpc.call('turn/start', {'threadId': thread, 'input': [{'type': 'text', 'text': prompt}], 'effort': 'low'}, deadline)
            turn = result['turn']['id']
            with transaction(self.url, write=True) as db:
                db.execute("UPDATE task_runs SET turn_id=%s,phase='generating' WHERE id=%s", (turn, run['id']))
                _event(db, run['id'], 'state', {'status': 'running', 'phase': 'generating', 'reason': None})
            interrupted_at = None
            while time.monotonic() < deadline:
                _require(not run['proxy_failure'], run['proxy_failure'] or 'model_failed')
                current = self._current(run)
                _require(current['stop_reason'] != 'permission_changed', 'permission_changed')
                if current['stop_requested'] and interrupted_at is None:
                    rpc.send_request('turn/interrupt', {'threadId': thread, 'turnId': turn})
                    interrupted_at = time.monotonic()
                if interrupted_at is not None and time.monotonic() - interrupted_at > 5:
                    status, reason = 'stopped', 'stop_timeout'
                    break
                event = rpc.next(timeout=0.25)
                if event is None:
                    continue
                params = event.get('params', {})
                method = event.get('method')
                if not method:
                    _require('error' not in event, 'protocol_error')
                    continue
                if params.get('threadId') != thread or params.get('turnId') not in (None, turn):
                    continue
                if method == 'item/agentMessage/delta':
                    delta = params['delta']
                    _require(isinstance(delta, str) and len(current['output']) + len(delta) <= 65536, 'output_budget')
                    with transaction(self.url, write=True) as db:
                        _actor(db, run['owner_id'])
                        db.execute('UPDATE task_runs SET output=output || %s WHERE id=%s', (delta, run['id']))
                        _event(db, run['id'], 'delta', {'delta': delta})
                elif method in ('item/started', 'item/completed'):
                    _require(params.get('item', {}).get('type') not in ('commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch'), 'tool_unavailable')
                elif method == 'error':
                    raise RuntimeBlocked('model_failed')
                elif method == 'turn/completed' and params.get('turn', {}).get('id') == turn:
                    native = params['turn']['status']
                    _require(native in ('completed', 'interrupted', 'failed'), 'protocol_error')
                    status = {'completed': 'completed', 'interrupted': 'stopped', 'failed': 'failed'}[native]
                    if current['stop_requested']:
                        status = 'stopped'
                    reason = None if status == 'completed' else 'user_stop' if status == 'stopped' else 'model_failed'
                    break
            else:
                status, reason = 'blocked', 'time_budget'
        except RuntimeBlocked as error:
            status, reason = ('stopped', 'user_stop') if str(error) == 'stop_before_start' else ('blocked', str(error))
            if str(error) in ('protocol_eof', 'protocol_error', 'model_failed', 'model_network', 'model_usage'):
                status = 'failed'
            if str(error) in ('protocol_eof', 'protocol_error', 'model_failed'):
                with transaction(self.url) as db:
                    requested = db.execute('SELECT stop_requested,stop_reason FROM task_runs WHERE id=%s', (run['id'],)).fetchone()
                if requested and requested[0] and requested[1] != 'permission_changed':
                    status, reason = 'stopped', 'user_stop'
        except WorkspaceAccessError:
            status, reason = 'blocked', 'permission_changed'
        except Exception:
            # Native exceptions may include provider text, paths or credentials. Keep a safe code.
            status, reason = 'failed', 'runtime_failed'
        finally:
            cleaned = True
            if rpc:
                try:
                    rpc.close()
                except Exception:
                    cleaned = False
            if scope_attempted:
                cleaned = self._stop_scope(run['id']) and cleaned
            if server:
                server.stopping.set()
                with suppress(OSError, AttributeError):
                    server.active_socket.shutdown(socket.SHUT_RDWR)
                server.shutdown()
                server.server_close()
            with self.lock:
                try:
                    if cleaned:
                        with transaction(self.url, write=True) as db:
                            _finish(db, run['id'], status, reason)
                    else:
                        self.failure = 'runtime_recovery'
                except Exception:
                    self.failure = 'runtime_state_unavailable'
                finally:
                    self.workers.pop(run['id'], None)

    def _sandbox(self, config, home, cwd, env, port):
        with socket.create_connection(('127.0.0.1', port), timeout=2):
            pass  # The negative probe must target a reachable listener, not a closed port.
        probe = '''import os,socket,sys
from pathlib import Path
for operation in (lambda: Path(sys.argv[1]).read_text(), lambda: Path(sys.argv[3]).read_text(), lambda: Path("forbidden").write_text("x"), lambda: socket.create_connection(("127.0.0.1",int(sys.argv[2])),timeout=2)):
    try: operation()
    except OSError: pass
    else: raise SystemExit(1)
assert not os.environ.get("HONGHAO_MODEL_TOKEN")
assert sys.stdin.read()==""
'''
        result = subprocess.run([str(config['binary']), 'sandbox', '--permission-profile', 'honghao', '--cd', str(cwd), '--',
                                 '/usr/bin/python3', '-c', probe, str(home / 'config.toml'), str(port), str(config['key_file'])],
                                cwd=cwd, env={name: value for name, value in env.items() if name != 'HONGHAO_MODEL_TOKEN'},
                                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=8)
        _require(result.returncode == 0, 'sandbox_unavailable')

    def _proxy(self, run, config, token, key):
        controller = self
        expiry = time.monotonic() + config['seconds']

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def setup(self):
                super().setup()
                self.connection.settimeout(5)

            def do_POST(self):
                if self.path != '/responses' or not hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + token):
                    self.send_error(404, 'Unavailable')
                    return
                connection = None
                headers_sent = False
                started = time.monotonic()
                try:
                    size = int(self.headers.get('Content-Length', '0'))
                    _require(0 < size <= 1048576 and not self.headers.get('Transfer-Encoding'), 'model_request')
                    body = json.loads(self.rfile.read(size))
                    _require(type(body) is dict and body.get('model') == 'deepseek-flash', 'model_request')
                    current = controller._current(run)
                    if current['stop_requested']:
                        self.send_error(409, 'Run stopping')
                        return
                    _require(time.monotonic() < expiry, 'time_budget')
                    _require(current['model_requests'] < config['requests'] and current['model_tokens'] + config['output_tokens'] <= config['tokens'], 'model_budget')
                    body.update(tools=[], tool_choice='none', max_output_tokens=config['output_tokens'], stream=True)
                    body.pop('previous_response_id', None)
                    # Conservative request-size reservation; completed usage remains authoritative.
                    _require(len(json.dumps(body, ensure_ascii=False).encode()) + config['output_tokens'] <= config['tokens'] - current['model_tokens'], 'model_budget')
                    with transaction(controller.url, write=True) as db:
                        _actor(db, run['owner_id'])
                        db.execute('UPDATE task_runs SET model_requests=model_requests+1 WHERE id=%s', (run['id'],))
                    connection = http.client.HTTPSConnection('api.deepseek.com', timeout=min(45, max(1, expiry-time.monotonic())), context=ssl.create_default_context())
                    connection.request('POST', '/responses', json.dumps(body), {'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'})
                    self.server.active_socket = connection.sock
                    response = connection.getresponse()
                    _require(response.status == 200, 'model_network')
                    self.send_response(200)
                    self.send_header('Content-Type', 'text/event-stream')
                    self.end_headers()
                    headers_sent = True
                    stream_started = False
                    while True:
                        line = response.readline(1048577)
                        if not line:
                            break
                        _require(len(line) <= 1048576 and time.monotonic() < expiry, 'model_budget')
                        current = controller._current(run)
                        if current['stop_requested'] or self.server.stopping.is_set():
                            return
                        if line.startswith(b'data:') and line[5:].strip() != b'[DONE]':
                            event = json.loads(line[5:])
                            items = ([event['item']] if event.get('item') else []) + event.get('response', {}).get('output', [])
                            _require(all(isinstance(item, dict) and item.get('type') in ('message','reasoning','compaction') for item in items), 'tool_unavailable')
                            _require('function_call' not in event.get('type', ''), 'tool_unavailable')
                            if not stream_started:
                                with transaction(controller.url, write=True) as db:
                                    _actor(db, run['owner_id'])
                                    _event(db, run['id'], 'state', {'status': 'running', 'phase': 'generating', 'reason': None, 'model_stream_started': True})
                                stream_started = True
                            if event.get('type') == 'response.completed':
                                usage = event.get('response', {}).get('usage', {})
                                count = usage.get('total_tokens')
                                _require(type(count) is int and 0 <= count <= 9223372036854775807 - current['model_tokens'], 'model_usage')
                                with transaction(controller.url, write=True) as db:
                                    db.execute('UPDATE task_runs SET model_tokens=model_tokens+%s WHERE id=%s', (count, run['id']))
                                _require(current['model_tokens'] + count <= config['tokens'], 'model_budget')
                        self.wfile.write(line)
                        self.wfile.flush()
                except RuntimeBlocked as error:
                    run['proxy_failure'] = str(error)
                    with suppress(Exception):
                        if not headers_sent: self.send_error(502, 'Model request unavailable')
                        else: self.close_connection = True
                except Exception:
                    # Do not expose provider failure bodies through either HTTP or product events.
                    with suppress(Exception):
                        if not headers_sent: self.send_error(502, 'Model request unavailable')
                        else: self.close_connection = True
                finally:
                    if connection:
                        connection.close()
                    self.server.active_socket = None
                    with suppress(Exception), transaction(controller.url, write=True) as db:
                        db.execute('UPDATE task_runs SET model_network_ms=model_network_ms+%s WHERE id=%s', (round((time.monotonic()-started)*1000), run['id']))

        server = HTTPServer(('127.0.0.1', 0), Handler)
        server.active_socket = None
        server.stopping = threading.Event()
        threading.Thread(target=server.serve_forever, daemon=True).start()
        return server


def _configuration(config, home, cwd, port, config_path):
    quote = lambda value: json.dumps(str(value))
    filesystem = {':minimal': 'read', str(cwd): 'read', str(config['binary'].parent): 'read',
                  str(Path(sys.executable).parent): 'read', str(config['key_file']): 'deny',
                  str(config_path or home / 'admin-config-unavailable'): 'deny', str(home): 'deny'}
    filesystem_toml = '\n'.join(f'{quote(path)} = {quote(access)}' for path, access in filesystem.items())
    return f'''model = "deepseek-flash"
model_provider = "deepseek"
model_catalog_json = {quote(config['catalog'])}
web_search = "disabled"
approval_policy = "on-request"
default_permissions = "honghao"
[permissions.honghao.filesystem]
{filesystem_toml}
[permissions.honghao.network]
enabled = false
[model_providers.deepseek]
name = "deepseek"
base_url = "http://127.0.0.1:{port}"
env_key = "HONGHAO_MODEL_TOKEN"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
stream_idle_timeout_ms = 45000
[shell_environment_policy]
inherit = "none"
set = {{ PATH = "/usr/local/bin:/usr/bin:/bin", HOME = {quote(cwd)}, LANG = "C.UTF-8" }}
[features]
shell_tool = false
unified_exec = false
apps = false
plugins = false
multi_agent = false
memories = false
skip_host_skill_discovery = true
use_linux_sandbox_bwrap = true
use_legacy_landlock = false
[analytics]
enabled = false
[skills]
include_instructions = false
'''


class _Rpc:
    def __init__(self, command, cwd, env, *, check=lambda: None):
        self.env = env
        self.check = check
        self.process = subprocess.Popen(command, cwd=cwd, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.DEVNULL, start_new_session=True)
        self.queue = queue.Queue(maxsize=64)
        self.pending = deque()
        self.sequence = 0
        self.closed = threading.Event()
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        try:
            while not self.closed.is_set():
                line = self.process.stdout.readline(1048577)
                if not line:
                    break
                _require(len(line) <= 1048576, 'protocol_size')
                item = json.loads(line)
                _require(isinstance(item, dict), 'protocol_error')
                self.queue.put(item, timeout=5)
        except Exception:
            pass
        finally:
            with suppress(queue.Full):
                self.queue.put({'eof': True}, timeout=1)

    def send(self, value):
        self.process.stdin.write((json.dumps(value) + '\n').encode())
        self.process.stdin.flush()

    def send_request(self, method, params):
        self.sequence += 1
        self.send({'id': self.sequence, 'method': method, 'params': params})
        return self.sequence

    def next(self, timeout):
        try:
            event = self.pending.popleft() if self.pending else self.queue.get(timeout=timeout)
        except queue.Empty:
            return None
        _require(not event.get('eof'), 'protocol_eof')
        if 'method' in event and 'id' in event:
            self.send({'id': event['id'], 'error': {'code': -32601, 'message': 'Capability unavailable'}})
            raise RuntimeBlocked('tool_unavailable')
        return event

    def call(self, method, params, deadline):
        request = self.send_request(method, params)
        buffered = []
        try:
            while time.monotonic() < deadline:
                self.check()
                event = self.next(min(0.25, max(0, deadline-time.monotonic())))
                if event is None:
                    continue
                if event.get('id') == request:
                    _require('error' not in event and isinstance(event.get('result'), dict), 'protocol_error')
                    return event['result']
                buffered.append(event)
                _require(len(buffered) <= 64, 'protocol_size')
            raise RuntimeBlocked('time_budget')
        finally:
            self.pending.extend(buffered)

    def close(self):
        self.closed.set()
        if self.process.poll() is None:
            with suppress(OSError):
                if os.name == 'nt':
                    self.process.terminate()
                else:
                    os.killpg(self.process.pid, signal.SIGTERM)
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                if os.name == 'nt':
                    self.process.kill()
                else:
                    os.killpg(self.process.pid, signal.SIGKILL)
                self.process.wait(timeout=3)
        self.process.stdin.close()
        self.process.stdout.close()
