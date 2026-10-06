from __future__ import annotations

from datetime import UTC, datetime
from uuid import uuid4

from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from api.postgres import transaction

SCHEMA_VERSION = 7
TASK_STATUSES = ('created', 'running', 'waiting', 'completed', 'stopped', 'failed', 'blocked')
RUN_STATUSES = TASK_STATUSES[1:]


class SubmissionConflictError(Exception):
    pass


class WorkspaceAccessError(Exception):
    pass


class WorkspaceNotFoundError(Exception):
    pass


class WorkspaceConflictError(Exception):
    pass


def _one(db, query, args=()):
    with db.cursor(row_factory=dict_row) as cursor:
        return cursor.execute(query, args).fetchone()


def _rows(db, query, args=()):
    with db.cursor(row_factory=dict_row) as cursor:
        return cursor.execute(query, args).fetchall()


def _actor(db, actor_id):
    row = db.execute('SELECT is_active,access_level,ai_enabled FROM identity_users WHERE id=%s', (actor_id,)).fetchone()
    if row is None or not row[0] or not (row[1] == 5 or row[2]):
        raise WorkspaceAccessError('AI access required')
    return row[1] == 5


def _resource(db, table, resource_id, actor_id, *, write=False):
    # table is an internal constant; requests cannot supply SQL identifiers.
    admin = _actor(db, actor_id)
    row = _one(db, f'SELECT * FROM {table} WHERE id=%s AND (owner_id=%s OR (%s AND owner_id IS NULL))', (resource_id, actor_id, admin))
    if row is None:
        raise WorkspaceNotFoundError({'projects': 'Project', 'conversations': 'Conversation', 'tasks': 'Task', 'conversation_messages': 'Message'}[table] + ' not found')
    if write and row['owner_id'] is None:
        raise WorkspaceAccessError('Unowned history is read-only')
    return row


def _revision(row, revision):
    if row['revision'] != revision:
        raise WorkspaceConflictError('Version changed; refresh before saving')


def _task(db, row):
    if row is not None:
        latest = db.execute('SELECT id FROM task_runs WHERE task_id=%s ORDER BY _order DESC LIMIT 1', (row['id'],)).fetchone()
        row = {**row, 'latest_run': latest[0] if latest else None}
    return row


class Database:
    def __init__(self, url: str) -> None:
        self.url = url

    def schema_version(self) -> int:
        with transaction(self.url) as db:
            row = db.execute("SELECT value FROM schema_metadata WHERE key='schema_version'").fetchone()
        if row is None:
            raise RuntimeError('Database schema is not initialized')
        return int(row[0])

    def create_project(self, title, *, actor_id):
        with transaction(self.url, write=True) as db:
            _actor(db, actor_id)
            return _one(db, 'INSERT INTO projects(id,title,owner_id) VALUES(%s,%s,%s) RETURNING *', (str(uuid4()), title, actor_id))

    def list_projects(self, *, actor_id):
        with transaction(self.url) as db:
            admin = _actor(db, actor_id)
            return _rows(db, 'SELECT * FROM projects WHERE owner_id=%s OR (%s AND owner_id IS NULL) ORDER BY _order', (actor_id, admin))

    def rename_project(self, project_id, title, revision, *, actor_id):
        with transaction(self.url, write=True) as db:
            _revision(_resource(db, 'projects', project_id, actor_id, write=True), revision)
            return _one(db, 'UPDATE projects SET title=%s,revision=revision+1 WHERE id=%s RETURNING *', (title, project_id))

    def create_conversation(self, title, project_id=None, *, actor_id):
        with transaction(self.url, write=True) as db:
            _actor(db, actor_id)
            if project_id is not None:
                _resource(db, 'projects', project_id, actor_id, write=True)
            return _one(db, 'INSERT INTO conversations(id,title,project_id,owner_id) VALUES(%s,%s,%s,%s) RETURNING *', (str(uuid4()), title, project_id, actor_id))

    def list_conversations(self, project_id=None, *, actor_id):
        with transaction(self.url) as db:
            admin = _actor(db, actor_id)
            if project_id is not None:
                _resource(db, 'projects', project_id, actor_id)
            return _rows(db, 'SELECT * FROM conversations WHERE (owner_id=%s OR (%s AND owner_id IS NULL)) AND (%s::text IS NULL OR project_id=%s) ORDER BY _order', (actor_id, admin, project_id, project_id))

    def get_conversation(self, conversation_id, *, actor_id):
        with transaction(self.url) as db:
            return _resource(db, 'conversations', conversation_id, actor_id)

    def set_conversation_project(self, conversation_id, project_id, revision, *, actor_id):
        with transaction(self.url, write=True) as db:
            _revision(_resource(db, 'conversations', conversation_id, actor_id, write=True), revision)
            if project_id is not None:
                _resource(db, 'projects', project_id, actor_id, write=True)
            return _one(db, 'UPDATE conversations SET project_id=%s,revision=revision+1 WHERE id=%s RETURNING *', (project_id, conversation_id))

    def _replay(self, db, actor_id, submission_key, intent):
        row = _one(db, 'SELECT conversation_id,task_id,submission_request,submission_receipt FROM conversation_messages WHERE owner_id=%s AND submission_key=%s', (actor_id, submission_key))
        if row is None:
            return None
        _resource(db, 'conversations', row['conversation_id'], actor_id, write=True)
        if row['task_id'] is not None:
            _resource(db, 'tasks', row['task_id'], actor_id, write=True)
        if row['submission_request'] != intent:
            raise SubmissionConflictError
        return row['submission_receipt']

    def create_conversation_submission(self, title, project_id, mode, content, submission_key, *, actor_id):
        intent = dict(title=title, project_id=project_id, mode=mode, content=content)
        with transaction(self.url, write=True) as db:
            _actor(db, actor_id)
            result = self._replay(db, actor_id, submission_key, intent)
            if result is not None:
                return result
            conversation = self.create_conversation(title, project_id, actor_id=actor_id)
            return self._insert_submission(db, conversation, mode, content, submission_key, intent, None, initial=True)

    def submit_conversation(self, conversation_id, mode, content, submission_key, task_id=None, *, actor_id):
        intent = dict(conversation_id=conversation_id, mode=mode, content=content, task_id=task_id)
        with transaction(self.url, write=True) as db:
            conversation = _resource(db, 'conversations', conversation_id, actor_id, write=True)
            result = self._replay(db, actor_id, submission_key, intent)
            if result is not None:
                return result
            if db.execute("SELECT 1 FROM task_runs WHERE conversation_id=%s AND status IN ('running','waiting')", (conversation_id,)).fetchone():
                raise WorkspaceConflictError('Conversation already has an active run')
            task = None
            if task_id is not None:
                task = _resource(db, 'tasks', task_id, actor_id, write=True)
                if mode != 'work' or task['conversation_id'] != conversation_id:
                    raise WorkspaceNotFoundError('Task does not belong to this work conversation')
            elif mode == 'work':
                tasks = _rows(db, 'SELECT * FROM tasks WHERE conversation_id=%s ORDER BY _order', (conversation_id,))
                if len(tasks) > 1:
                    raise WorkspaceConflictError('Select a task to continue')
                task = tasks[0] if tasks else None
            if task and db.execute("SELECT 1 FROM task_runs WHERE task_id=%s AND status IN ('running','waiting')", (task['id'],)).fetchone():
                raise WorkspaceConflictError('Task already has an active run')
            return self._insert_submission(db, conversation, mode, content, submission_key, intent, task)

    def _insert_submission(self, db, conversation, mode, content, key, intent, task, *, initial=False):
        owner = conversation['owner_id']
        now = datetime.now(UTC).isoformat()
        message = _one(db, 'INSERT INTO conversation_messages(id,conversation_id,mode,content,created_at,submission_key,owner_id) VALUES(%s,%s,%s,%s,%s,%s,%s) RETURNING *', (str(uuid4()), conversation['id'], mode, content, now, key, owner))
        if mode == 'work' and task is None:
            task = _one(db, "INSERT INTO tasks(id,conversation_id,objective,project_id,status,created_at,message_id,owner_id) VALUES(%s,%s,%s,%s,'created',%s,%s,%s) RETURNING *", (str(uuid4()), conversation['id'], content, conversation['project_id'], now, message['id'], owner))
        if task:
            message['task_id'] = task['id']
            db.execute('UPDATE conversation_messages SET task_id=%s WHERE id=%s', (task['id'], message['id']))
        message['task_status'] = task['status'] if task else None
        # Persist public acceptance fields only, without recursive request/receipt columns.
        message = {k: v for k, v in message.items() if k not in ('_order', 'submission_key', 'submission_request', 'submission_receipt')}
        task = _task(db, task)
        if task:
            task = {k: v for k, v in task.items() if k not in ('_order', 'message_id')}
        result = {'message': message, 'task': task}
        if initial:
            result['conversation'] = {k: v for k, v in conversation.items() if k != '_order'}
        db.execute('UPDATE conversation_messages SET submission_request=%s,submission_receipt=%s WHERE id=%s', (Jsonb(intent), Jsonb(result), message['id']))
        return result

    def list_messages(self, conversation_id, *, actor_id):
        with transaction(self.url) as db:
            _resource(db, 'conversations', conversation_id, actor_id)
            return _rows(db, 'SELECT m.id,m.conversation_id,m.owner_id,m.role,m.mode,m.content,m.created_at,m.task_id,m.run_id,t.status AS task_status FROM conversation_messages m LEFT JOIN tasks t ON t.id=m.task_id WHERE m.conversation_id=%s ORDER BY m._order', (conversation_id,))

    def list_tasks(self, *, actor_id):
        with transaction(self.url) as db:
            admin = _actor(db, actor_id)
            return _rows(db, 'SELECT t.*, (SELECT id FROM task_runs r WHERE r.task_id=t.id ORDER BY r._order DESC LIMIT 1) AS latest_run FROM tasks t WHERE owner_id=%s OR (%s AND owner_id IS NULL) ORDER BY t._order', (actor_id, admin))

    def get_task(self, task_id, *, actor_id):
        with transaction(self.url) as db:
            return _task(db, _resource(db, 'tasks', task_id, actor_id))

    def list_runs(self, task_id, *, actor_id):
        with transaction(self.url) as db:
            _resource(db, 'tasks', task_id, actor_id)
            return _rows(db, 'SELECT * FROM task_runs WHERE task_id=%s ORDER BY _order', (task_id,))

    def create_run(self, task_id, input_message_id, runtime_version, *, actor_id):
        """Trusted runtime controller entry; intentionally has no HTTP write route."""
        with transaction(self.url, write=True) as db:
            _resource(db, 'tasks', task_id, actor_id, write=True)
            message = _resource(db, 'conversation_messages', input_message_id, actor_id, write=True)
            if message['task_id'] != task_id or message['mode'] != 'work':
                raise WorkspaceNotFoundError('Input does not belong to this task')
            if db.execute("SELECT 1 FROM task_runs WHERE task_id=%s AND status IN ('running','waiting')", (task_id,)).fetchone():
                raise WorkspaceConflictError('Task already has an active run')
            run = _one(db, "INSERT INTO task_runs(id,task_id,owner_id,input_message_id,conversation_id,status,started_at,runtime_version) VALUES(%s,%s,%s,%s,%s,'running',%s,%s) RETURNING *", (str(uuid4()), task_id, actor_id, input_message_id, message['conversation_id'], datetime.now(UTC).isoformat(), runtime_version))
            db.execute("UPDATE tasks SET status='running',revision=revision+1 WHERE id=%s", (task_id,))
            return run
