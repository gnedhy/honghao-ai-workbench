from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import uuid4

from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from api.postgres import transaction

SCHEMA_VERSION = 17
TASK_STATUSES = ('created', 'queued', 'running', 'waiting', 'review', 'completed', 'stopped', 'failed', 'blocked')
RUN_STATUSES = ('queued', 'running', 'waiting', 'completed', 'stopped', 'failed', 'blocked')
CONVERSATION_MODE_SQL = "CASE WHEN EXISTS (SELECT 1 FROM conversation_messages m WHERE m.conversation_id=c.id AND m.role='user' AND m.mode='work') THEN 'work' ELSE 'chat' END"
TASK_TITLE_SQL = "(SELECT COALESCE(e.payload->>'task_title',e.payload->'conversation'->>'title') FROM ai_run_events e JOIN task_runs r ON r.id=e.run_id WHERE r.task_id=t.id AND NOT e.payload ? 'title_requested' AND (e.payload ? 'task_title' OR (e.payload ? 'conversation' AND t.message_id=(SELECT id FROM conversation_messages WHERE conversation_id=t.conversation_id AND role='user' ORDER BY _order LIMIT 1))) ORDER BY r._order,e.seq LIMIT 1)"


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
        metadata = _one(db, f'SELECT (SELECT id FROM task_runs WHERE task_id=t.id ORDER BY _order DESC LIMIT 1) AS latest_run,{TASK_TITLE_SQL} AS title FROM tasks t WHERE t.id=%s', (row['id'],))
        row = {**row, **metadata}
    return row


def _conversation(db, row):
    if row is not None:
        row = {**row, **_one(db, f'SELECT {CONVERSATION_MODE_SQL} AS mode FROM conversations c WHERE c.id=%s', (row['id'],))}
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

    def ai_usage(self, *, actor_id, days=30):
        # Usage is private account metadata, including archived conversations.
        owned = """WITH owned AS (
            SELECT r.*,CASE WHEN EXISTS(SELECT 1 FROM ai_request_usage u WHERE u.run_id=r.id AND u.status!='void') THEN 0 ELSE r.model_tokens END AS billing_tokens,m.mode,(r.started_at::timestamptz AT TIME ZONE 'Asia/Shanghai')::date AS day,
                (r.accepted_at::timestamptz AT TIME ZONE 'Asia/Shanghai')::date AS accepted_day
            FROM task_runs r JOIN conversation_messages m ON m.id=r.input_message_id
            WHERE r.owner_id=%s AND m.owner_id=%s) """
        with transaction(self.url) as db:
            today = db.execute("SELECT (now() AT TIME ZONE 'Asia/Shanghai')::date").fetchone()[0]
            since = today-timedelta(days=days-1) if days else None
            summary = _one(db, owned+"""SELECT count(*) AS executions,
                count(*) FILTER (WHERE mode='chat') AS chats,
                count(*) FILTER (WHERE mode='work') AS work,
                COALESCE(sum(billing_tokens),0) AS tokens,count(DISTINCT day) AS active_days,
                count(*) FILTER (WHERE status='completed') AS successful,
                count(*) FILTER (WHERE status IN ('failed','blocked')) AS failed,
                count(*) FILTER (WHERE status='stopped') AS stopped
                FROM owned WHERE (%s::date IS NULL OR day>=%s) AND day<=%s""",
                (actor_id,actor_id,since,since,today))
            summary['tokens'] += db.execute('''SELECT COALESCE(sum(model_tokens),0) FROM memory_extractions
                WHERE owner_id=%s AND (%s::date IS NULL OR (created_at::timestamptz AT TIME ZONE 'Asia/Shanghai')::date>=%s)
                AND NOT EXISTS(SELECT 1 FROM ai_request_usage u WHERE u.run_id=memory_extractions.run_id AND u.status!='void')
                AND (created_at::timestamptz AT TIME ZONE 'Asia/Shanghai')::date<=%s''',(actor_id,since,since,today)).fetchone()[0]
            charges = _one(db, '''SELECT COALESCE(sum(COALESCE(input_tokens+output_tokens,reported_total_tokens)),0)::bigint AS tokens,
                COALESCE(sum(cost_cny) FILTER(WHERE status='completed'),0)::text AS cost_cny,
                COALESCE(sum(cost_cny) FILTER(WHERE status='pending'),0)::text AS pending_cny,
                min(created_at)::text AS accounting_since FROM ai_request_usage WHERE owner_id=%s
                AND status!='void' AND (%s::date IS NULL OR (created_at AT TIME ZONE 'Asia/Shanghai')::date>=%s)
                AND (created_at AT TIME ZONE 'Asia/Shanghai')::date<=%s''', (actor_id,since,since,today))
            summary['tokens'] += charges.pop('tokens')
            summary.update(charges)
            summary['accepted_tasks'] = db.execute("""SELECT count(DISTINCT task_id) FROM task_runs
                WHERE owner_id=%s AND accepted_at IS NOT NULL
                AND (%s::date IS NULL OR (accepted_at::timestamptz AT TIME ZONE 'Asia/Shanghai')::date>=%s)
                AND (accepted_at::timestamptz AT TIME ZONE 'Asia/Shanghai')::date<=%s""",
                (actor_id,since,since,today)).fetchone()[0]
            activity = _rows(db, owned+"""SELECT day::text AS date,count(*) AS runs,
                COALESCE(sum(billing_tokens),0) AS tokens FROM owned
                WHERE day BETWEEN %s AND %s GROUP BY day ORDER BY day""",
                (actor_id,actor_id,today-timedelta(days=364),today))
            memory_activity = _rows(db, '''SELECT (created_at::timestamptz AT TIME ZONE 'Asia/Shanghai')::date::text AS date,
                sum(model_tokens) AS tokens FROM memory_extractions WHERE owner_id=%s
                AND NOT EXISTS(SELECT 1 FROM ai_request_usage u WHERE u.run_id=memory_extractions.run_id AND u.status!='void')
                AND (created_at::timestamptz AT TIME ZONE 'Asia/Shanghai')::date BETWEEN %s AND %s GROUP BY 1''',
                (actor_id,today-timedelta(days=364),today))
            by_date = {item['date']:item for item in activity}
            for item in memory_activity:
                by_date.setdefault(item['date'], {'date':item['date'],'runs':0,'tokens':0})['tokens'] += item['tokens']
            ledger_activity = _rows(db, '''SELECT (created_at AT TIME ZONE 'Asia/Shanghai')::date::text AS date,
                COALESCE(sum(COALESCE(input_tokens+output_tokens,reported_total_tokens)),0)::bigint AS tokens FROM ai_request_usage WHERE owner_id=%s AND status!='void'
                AND (created_at AT TIME ZONE 'Asia/Shanghai')::date BETWEEN %s AND %s GROUP BY 1''', (actor_id,today-timedelta(days=364),today))
            for item in ledger_activity:
                by_date.setdefault(item['date'], {'date':item['date'],'runs':0,'tokens':0})['tokens'] += item['tokens']
            activity = sorted(by_date.values(),key=lambda item:item['date'])
        return {**summary,'today':today.isoformat(),'activity':activity}

    def create_project(self, title, *, actor_id, submission_key=None, icon='folder', color='blue'):
        with transaction(self.url, write=True) as db:
            _actor(db, actor_id)
            if submission_key:
                existing = _one(db, 'SELECT * FROM projects WHERE owner_id=%s AND creation_key=%s', (actor_id, submission_key))
                if existing:
                    if (existing['creation_title'], existing['creation_icon'], existing['creation_color']) != (title, icon, color):
                        raise WorkspaceConflictError('Creation request differs from accepted request')
                    return existing
            return _one(db, 'INSERT INTO projects(id,title,owner_id,creation_key,creation_title,icon,color,creation_icon,creation_color) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *', (str(uuid4()), title, actor_id, submission_key, title if submission_key else None, icon, color, icon if submission_key else None, color if submission_key else None))

    def list_projects(self, *, actor_id):
        with transaction(self.url) as db:
            admin = _actor(db, actor_id)
            return _rows(db, 'SELECT * FROM projects WHERE owner_id=%s OR (%s AND owner_id IS NULL) ORDER BY _order', (actor_id, admin))

    def rename_project(self, project_id, title, revision, *, actor_id, icon=None, color=None, removed=None):
        with transaction(self.url, write=True) as db:
            project = _resource(db, 'projects', project_id, actor_id, write=True)
            _revision(project, revision)
            if project['removed']:
                raise WorkspaceConflictError('Project already removed')
            if removed:
                if title != project['title'] or icon is not None or color is not None:
                    raise WorkspaceConflictError('Removal must preserve saved settings')
                return _one(db, 'UPDATE projects SET removed=true,revision=revision+1 WHERE id=%s RETURNING *', (project_id,))
            return _one(db, 'UPDATE projects SET title=%s,icon=COALESCE(%s,icon),color=COALESCE(%s,color),revision=revision+1 WHERE id=%s RETURNING *', (title, icon, color, project_id))

    def create_conversation(self, title, project_id=None, *, actor_id):
        with transaction(self.url, write=True) as db:
            _actor(db, actor_id)
            if project_id is not None:
                if _resource(db, 'projects', project_id, actor_id, write=True)['removed']:
                    raise WorkspaceConflictError('Project removed; choose an active project')
            return _conversation(db, _one(db, 'INSERT INTO conversations(id,title,project_id,owner_id) VALUES(%s,%s,%s,%s) RETURNING *', (str(uuid4()), title, project_id, actor_id)))

    def list_conversations(self, project_id=None, *, actor_id):
        with transaction(self.url) as db:
            admin = _actor(db, actor_id)
            if project_id is not None:
                _resource(db, 'projects', project_id, actor_id)
            return _rows(db, f"SELECT c.*,{CONVERSATION_MODE_SQL} AS mode FROM conversations c WHERE (c.owner_id=%s OR (%s AND c.owner_id IS NULL)) AND (%s::text IS NULL OR c.project_id=%s) ORDER BY c._order", (actor_id, admin, project_id, project_id))

    def get_conversation(self, conversation_id, *, actor_id):
        with transaction(self.url) as db:
            return _conversation(db, _resource(db, 'conversations', conversation_id, actor_id))

    def set_conversation_project(self, conversation_id, project_id, revision, *, actor_id):
        return self.update_conversation(conversation_id, {'project_id': project_id}, revision, actor_id=actor_id)

    def update_conversation(self, conversation_id, changes, revision, *, actor_id):
        assert changes and changes.keys() <= {'title', 'project_id', 'pinned', 'archived'}
        with transaction(self.url, write=True) as db:
            row = _resource(db, 'conversations', conversation_id, actor_id, write=True)
            _revision(row, revision)
            if changes.get('project_id') is not None:
                project = _resource(db, 'projects', changes['project_id'], actor_id, write=True)
                if project['removed'] and changes['project_id'] != row['project_id']:
                    raise WorkspaceConflictError('Project removed; choose an active project')
            assignments = ','.join(name+'=%s' for name in changes)
            return _conversation(db, _one(db, 'UPDATE conversations SET '+assignments+',revision=revision+1 WHERE id=%s RETURNING *', (*changes.values(), conversation_id)))

    def delete_conversation(self, conversation_id, revision, *, actor_id, before_delete=None):
        with transaction(self.url, write=True) as db:
            row = _resource(db, 'conversations', conversation_id, actor_id, write=True)
            _revision(row, revision)
            if not row['archived']:
                raise WorkspaceConflictError('Archive the conversation before deleting it')
            if db.execute("SELECT 1 FROM task_runs WHERE conversation_id=%s AND status IN ('queued','running','waiting')", (conversation_id,)).fetchone():
                raise WorkspaceConflictError('Stop the active run before deleting the conversation')
            if before_delete:
                before_delete(db.execute('SELECT id,thread_id FROM ai_contexts WHERE conversation_id=%s AND thread_id IS NOT NULL',(conversation_id,)).fetchall())
            db.execute('UPDATE conversation_messages SET run_id=NULL WHERE conversation_id=%s', (conversation_id,))
            db.execute('DELETE FROM ai_run_events WHERE run_id IN (SELECT id FROM task_runs WHERE conversation_id=%s)', (conversation_id,))
            # The message -> task reference is already deferred; delete the graph in one transaction.
            for table in ('task_runs', 'ai_contexts', 'tasks', 'conversation_messages'):
                db.execute(f'DELETE FROM {table} WHERE conversation_id=%s', (conversation_id,))
            db.execute('DELETE FROM conversations WHERE id=%s', (conversation_id,))

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
            if db.execute("SELECT 1 FROM task_runs WHERE conversation_id=%s AND status IN ('queued','running','waiting')", (conversation_id,)).fetchone():
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
            if task and db.execute("SELECT 1 FROM task_runs WHERE task_id=%s AND status IN ('queued','running','waiting')", (task['id'],)).fetchone():
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
            conversation = _conversation(db, conversation)
            result['conversation'] = {k: v for k, v in conversation.items() if k != '_order'}
        db.execute('UPDATE conversation_messages SET submission_request=%s,submission_receipt=%s WHERE id=%s', (Jsonb(intent), Jsonb(result), message['id']))
        return result

    def list_messages(self, conversation_id, *, actor_id):
        with transaction(self.url) as db:
            _resource(db, 'conversations', conversation_id, actor_id)
            return _rows(db, 'SELECT m.id,m.conversation_id,m.owner_id,m.role,m.mode,m.content,m.created_at,m.task_id,m.run_id,t.status AS task_status,r.status AS execution_status,r.started_at AS execution_started_at,r.ended_at AS execution_ended_at FROM conversation_messages m LEFT JOIN tasks t ON t.id=m.task_id LEFT JOIN task_runs r ON r.input_message_id=m.id AND r.context_id IS NOT NULL WHERE m.conversation_id=%s ORDER BY m._order', (conversation_id,))

    def list_tasks(self, *, actor_id):
        with transaction(self.url) as db:
            admin = _actor(db, actor_id)
            return _rows(db, f'SELECT t.*, (SELECT id FROM task_runs r WHERE r.task_id=t.id ORDER BY r._order DESC LIMIT 1) AS latest_run,{TASK_TITLE_SQL} AS title FROM tasks t JOIN conversations c ON c.id=t.conversation_id WHERE NOT c.archived AND (t.owner_id=%s OR (%s AND t.owner_id IS NULL)) ORDER BY t._order', (actor_id, admin))

    def get_task(self, task_id, *, actor_id):
        with transaction(self.url) as db:
            return _task(db, _resource(db, 'tasks', task_id, actor_id))

    def list_runs(self, task_id, *, actor_id):
        with transaction(self.url) as db:
            _resource(db, 'tasks', task_id, actor_id)
            return _rows(db, "SELECT *,model_config_snapshot->>'model' AS model,model_config_snapshot->>'effort' AS effort,(model_config_snapshot->>'revision')::int AS model_config_revision FROM task_runs WHERE task_id=%s ORDER BY _order", (task_id,))

    def accept_task(self, task_id, revision, run_id, *, actor_id):
        with transaction(self.url, write=True) as db:
            task = _resource(db, 'tasks', task_id, actor_id, write=True)
            _revision(task, revision)
            conversation = _resource(db, 'conversations', task['conversation_id'], actor_id, write=True)
            latest = _one(db, 'SELECT * FROM task_runs WHERE task_id=%s ORDER BY _order DESC LIMIT 1', (task_id,))
            if conversation['archived'] or task['status'] != 'review' or latest is None or latest['id'] != run_id or latest['status'] != 'completed' or latest['phase'] != 'ended':
                raise WorkspaceConflictError('Only the latest successful result awaiting review can be accepted')
            if db.execute("SELECT 1 FROM task_runs WHERE conversation_id=%s AND status IN ('queued','running','waiting')", (task['conversation_id'],)).fetchone():
                raise WorkspaceConflictError('Conversation already has an active run')
            if db.execute("SELECT 1 FROM conversation_messages m WHERE m.task_id=%s AND m.role='user' AND m.submission_receipt IS NOT NULL AND NOT EXISTS (SELECT 1 FROM task_runs r WHERE r.input_message_id=m.id AND r.context_id IS NOT NULL)", (task_id,)).fetchone():
                raise WorkspaceConflictError('Execute pending accepted input before accepting a result')
            db.execute('UPDATE task_runs SET accepted_at=%s,accepted_by=%s WHERE id=%s', (datetime.now(UTC).isoformat(), actor_id, run_id))
            saved = _one(db, "UPDATE tasks SET status='completed',revision=revision+1 WHERE id=%s RETURNING *", (task_id,))
            return _task(db, saved)

    def create_run(self, task_id, input_message_id, runtime_version, *, actor_id):
        """Trusted runtime controller entry; intentionally has no HTTP write route."""
        with transaction(self.url, write=True) as db:
            _resource(db, 'tasks', task_id, actor_id, write=True)
            message = _resource(db, 'conversation_messages', input_message_id, actor_id, write=True)
            if message['task_id'] != task_id or message['mode'] != 'work':
                raise WorkspaceNotFoundError('Input does not belong to this task')
            if db.execute("SELECT 1 FROM task_runs WHERE task_id=%s AND status IN ('queued','running','waiting')", (task_id,)).fetchone():
                raise WorkspaceConflictError('Task already has an active run')
            run = _one(db, "INSERT INTO task_runs(id,task_id,owner_id,input_message_id,conversation_id,status,started_at,runtime_version) VALUES(%s,%s,%s,%s,%s,'running',%s,%s) RETURNING *", (str(uuid4()), task_id, actor_id, input_message_id, message['conversation_id'], datetime.now(UTC).isoformat(), runtime_version))
            db.execute("UPDATE tasks SET status='running',revision=revision+1 WHERE id=%s", (task_id,))
            return run
