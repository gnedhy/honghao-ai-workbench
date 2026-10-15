"""Administrator settings and account-owned request accounting around native Codex."""
from contextlib import nullcontext
from datetime import datetime
from decimal import Decimal, InvalidOperation
import os
import re
from pathlib import Path
from uuid import UUID, uuid4
from zoneinfo import ZoneInfo

from psycopg.types.json import Jsonb
from api.database import _actor, _one, _rows, _revision, WorkspaceAccessError, WorkspaceConflictError
from api.postgres import transaction


MODELS = ('deepseek-flash', 'deepseek-v4-pro')
EFFORTS = ('low', 'high', 'max')
PURPOSES = ('foreground', 'compaction', 'title', 'memory', 'test')
CONTEXT_WINDOW = 1048576


class AIBudgetExceeded(WorkspaceConflictError):
    def __init__(self):
        super().__init__('budget_exhausted')


def _money(value, *, nullable=False):
    if value is None and nullable:
        return None
    if isinstance(value, bool) or not isinstance(value, (str, int, float, Decimal)):
        raise WorkspaceConflictError('金额必须是有效非负数')
    try:
        number = Decimal(str(value))
        if not number.is_finite() or number < 0 or number > Decimal('1000000000') or number.as_tuple().exponent < -12:
            raise InvalidOperation
    except (InvalidOperation, ValueError):
        raise WorkspaceConflictError('金额必须是有效非负数，最多十二位小数') from None
    return format(number, 'f')


def _integer(value, minimum, maximum):
    if type(value) is not int or not minimum <= value <= maximum:
        raise WorkspaceConflictError('无效的整数配置')
    return value


def _prices(value):
    if not isinstance(value, dict) or set(value) != {'input', 'cache', 'output'}:
        raise WorkspaceConflictError('必须分别设置输入、缓存及输出单价')
    result = {key: _money(number) for key, number in value.items()}
    if any(Decimal(number) > 10000 for number in result.values()):
        raise WorkspaceConflictError('单价超出支持范围')
    return result


def _cost(prices, input_tokens, cached_tokens, output_tokens):
    return ((Decimal(prices['input']) * (input_tokens - cached_tokens)
             + Decimal(prices['cache']) * cached_tokens
             + Decimal(prices['output']) * output_tokens) / 1000000).quantize(Decimal('0.000000000001'))


class AIControlStore:
    def __init__(self, url, data_dir):
        self.url = url
        self.data_dir = Path(data_dir)

    def _db(self, db=None, *, write=False):
        return nullcontext(db) if db is not None else transaction(self.url, write=write)

    def _admin(self, db, actor):
        if not _actor(db, actor):
            raise WorkspaceAccessError('System administrator required')

    def config(self, db=None):
        with self._db(db) as connection:
            result = {row['section']: {key: row[key] for key in ('revision', 'value', 'updated_at')}
                      for row in _rows(connection, 'SELECT section,revision,value,updated_at::text FROM ai_control_settings ORDER BY section')}
            result['models']['pricing_source'] = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/'
            return result

    def _validate(self, db, section, value, previous):
        if not isinstance(value, dict):
            raise WorkspaceConflictError('配置必须是对象')
        readonly = {'models': 'validated_models', 'concurrency': 'verified_capacity'}.get(section)
        value = value.copy()
        if readonly:
            if readonly in value and value[readonly] != previous[readonly]:
                raise WorkspaceConflictError('验证状态只允许部署侧修改')
            value[readonly] = previous[readonly]
        if set(value) != set(previous):
            raise WorkspaceConflictError('配置字段不完整或包含未知字段')
        if section == 'models':
            for key, supported in (('enabled_models', MODELS), ('allowed_efforts', EFFORTS)):
                items = value[key]
                if not isinstance(items, list) or not items or any(not isinstance(item, str) or item not in supported for item in items) or len(items) != len(set(items)):
                    raise WorkspaceConflictError('模型或推理档位无效')
            if not set(value['enabled_models']) <= set(value['validated_models']):
                raise WorkspaceConflictError('模型尚未完成兼容验证')
            if value['default_model'] not in value['enabled_models'] or value['default_effort'] not in value['allowed_efforts']:
                raise WorkspaceConflictError('默认模型和推理档位必须已开放')
            if not isinstance(value['prices'], dict) or set(value['prices']) != set(MODELS):
                raise WorkspaceConflictError('模型价格不完整')
            value['prices'] = {model: _prices(prices) for model, prices in value['prices'].items()}
        elif section == 'budget':
            for key in ('company_monthly_cny', 'user_monthly_cny'):
                value[key] = _money(value[key], nullable=True)
            if not isinstance(value['user_overrides'], dict):
                raise WorkspaceConflictError('个人例外额度必须是对象')
            value['user_overrides'] = {owner: _money(amount, nullable=True) for owner, amount in value['user_overrides'].items()}
            for owner in value['user_overrides']:
                if not isinstance(owner, str) or db.execute('SELECT 1 FROM identity_users WHERE id=%s', (owner,)).fetchone() is None:
                    raise WorkspaceConflictError('例外额度账号不存在')
        elif section == 'concurrency':
            _integer(value['max_running'], 1, value['verified_capacity'])
            _integer(value['queue_limit'], 1, 100)
            _integer(value['user_queue_limit'], 1, 2)
            _integer(value['queue_timeout_seconds'], 60, 1800)
        return value

    def save(self, section, revision, value, actor):
        if section not in ('models', 'budget', 'concurrency'):
            raise WorkspaceConflictError('未知的AI配置页面')
        with transaction(self.url, write=True) as db:
            self._admin(db, actor)
            row = _one(db, 'SELECT * FROM ai_control_settings WHERE section=%s FOR UPDATE', (section,))
            _integer(revision, 1, 2147483647)
            _revision(row, revision)
            normalized = self._validate(db, section, value, row['value'])
            db.execute('UPDATE ai_control_settings SET value=%s,revision=revision+1,updated_by=%s,updated_at=now() WHERE section=%s', (Jsonb(normalized), actor, section))
            return self.config(db)[section]

    def mark_model_validated(self, model):
        if model not in MODELS:
            raise WorkspaceConflictError('Unsupported model')
        with transaction(self.url, write=True) as db:
            row = self.config(db)['models']
            value = row['value']
            if model not in value['validated_models']:
                value['validated_models'].append(model)
                db.execute("UPDATE ai_control_settings SET value=%s,revision=revision+1,updated_at=now() WHERE section='models'", (Jsonb(value),))

    def set_verified_capacity(self, capacity):
        _integer(capacity, 1, 4)
        with transaction(self.url, write=True) as db:
            value = self.config(db)['concurrency']['value']
            value['verified_capacity'] = capacity
            value['max_running'] = min(value['max_running'], capacity)
            db.execute("UPDATE ai_control_settings SET value=%s,revision=revision+1,updated_at=now() WHERE section='concurrency'", (Jsonb(value),))

    def selection(self, actor, model=None, effort=None, db=None):
        with self._db(db) as connection:
            _actor(connection, actor)
            row = self.config(connection)['models']
            value = row['value']
            model = value['default_model'] if model is None else model
            effort = value['default_effort'] if effort is None else effort
            if model not in value['enabled_models'] or effort not in value['allowed_efforts']:
                raise WorkspaceConflictError('模型或推理档位未获准使用')
            key = connection.execute('SELECT version FROM ai_credentials ORDER BY _order DESC LIMIT 1').fetchone()
            return {'model': model, 'effort': effort, 'revision': row['revision'], 'price_revision': row['revision'],
                    'prices': value['prices'][model].copy(), 'key_version': key[0] if key else None,
                    'context_window': CONTEXT_WINDOW, 'auto_compact_tokens': CONTEXT_WINDOW * 9 // 10, 'output_tokens': 4096,
                    'supports_images': model == MODELS[0]}

    def _month(self):
        date = datetime.now(ZoneInfo('Asia/Shanghai'))
        since = date.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        until = since.replace(year=since.year + (since.month == 12), month=1 if since.month == 12 else since.month + 1)
        return date.strftime('%Y-%m'), since, until

    def _totals(self, db, actor=None):
        month, since, until = self._month()
        where, args = ('AND owner_id=%s', (actor,)) if actor is not None else ('', ())
        row = _one(db, f'''SELECT count(*) AS requests,
            COALESCE(sum(cost_cny) FILTER(WHERE status='completed'),0)::text AS cost_cny,
            COALESCE(sum(cost_cny) FILTER(WHERE status='pending'),0)::text AS pending_cny,
            COALESCE(sum(input_tokens),0)::bigint AS input_tokens,
            COALESCE(sum(cached_tokens),0)::bigint AS cached_tokens,
            COALESCE(sum(output_tokens),0)::bigint AS output_tokens,
            COALESCE(sum(COALESCE(input_tokens+output_tokens,reported_total_tokens)),0)::bigint AS total_tokens
            FROM ai_request_usage WHERE created_at>=%s AND created_at<%s AND status!='void' {where}''', (since, until, *args))
        return row

    def _quota(self, db, actor):
        budget = self.config(db)['budget']['value']
        totals = self._totals(db, actor)
        company = self._totals(db)
        personal_limit = budget['user_overrides'].get(actor, budget['user_monthly_cny'])
        company_limit = budget['company_monthly_cny']
        own_used = Decimal(totals['cost_cny']) + Decimal(totals['pending_cny'])
        company_used = Decimal(company['cost_cny']) + Decimal(company['pending_cny'])
        company_exhausted = company_limit is not None and company_used >= Decimal(company_limit)
        blocked = company_exhausted or (personal_limit is not None and own_used >= Decimal(personal_limit))
        warning = any(limit is not None and used >= Decimal(limit) * Decimal('0.8')
                      for used, limit in ((own_used, personal_limit), (company_used, company_limit)))
        return {'month': self._month()[0], 'monthly_cny': personal_limit,
                'cost_cny': totals['cost_cny'], 'pending_cny': totals['pending_cny'],
                'company_exhausted': company_exhausted, 'warning': warning, 'blocked': blocked}

    def catalog(self, actor):
        with transaction(self.url) as db:
            _actor(db, actor)
            value = self.config(db)['models']['value']
            return {'models': [{'id': model, 'name': 'DeepSeek Flash' if model == MODELS[0] else 'DeepSeek Pro',
                                'supports_images': model == MODELS[0]} for model in value['enabled_models']],
                    'allowed_efforts': value['allowed_efforts'], 'default_model': value['default_model'],
                    'default_effort': value['default_effort'], 'quota': self._quota(db, actor)}

    def admit(self, db, actor):
        _actor(db, actor)
        budget = self.config(db)['budget']['value']
        for owner, amount in ((None, budget['company_monthly_cny']), (actor, budget['user_overrides'].get(actor, budget['user_monthly_cny']))):
            if amount is not None:
                total = self._totals(db, owner)
                if Decimal(total['cost_cny']) + Decimal(total['pending_cny']) >= Decimal(amount):
                    raise AIBudgetExceeded()

    def begin_request(self, actor, run_id, model, purpose, price_snapshot, input_upper, output_upper, price_revision=None):
        if model not in MODELS or purpose not in PURPOSES:
            raise WorkspaceConflictError('Invalid model request')
        prices = _prices(price_snapshot)
        _integer(input_upper, 0, 16777216)
        _integer(output_upper, 0, 393216)
        with transaction(self.url, write=True) as db:
            self.admit(db, actor)
            models = self.config(db)['models']
            if purpose == 'test':
                self._admin(db, actor)
            elif model not in models['value']['enabled_models']:
                raise WorkspaceConflictError('模型已停止开放')
            price_revision = models['revision'] if price_revision is None else _integer(price_revision, 1, 2147483647)
            user = _one(db, '''SELECT u.display_name,COALESCE((SELECT d.name FROM organization_memberships m JOIN organization_departments d ON d.id=m.department_id WHERE m.user_id=u.id AND m.is_primary=1),u.department,'未分配部门') AS department FROM identity_users u WHERE u.id=%s''', (actor,))
            request_id = str(uuid4())
            db.execute('''INSERT INTO ai_request_usage(id,owner_id,display_name,department,run_id,model,purpose,price_revision,prices,input_upper,output_upper,cost_cny)
                VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''', (request_id, actor, user['display_name'], user['department'], run_id, model, purpose, price_revision, Jsonb(prices), input_upper, output_upper, _cost(prices, input_upper, 0, output_upper)))
            return request_id

    def settle_request(self, request_id, usage):
        with transaction(self.url, write=True) as db:
            row = _one(db, 'SELECT * FROM ai_request_usage WHERE id=%s FOR UPDATE', (request_id,))
            if row is None or row['status'] in ('completed', 'void'):
                return
            if isinstance(usage,dict) and usage.get('total_tokens') is not None:
                reported = _integer(usage['total_tokens'],0,17170432)
                db.execute('UPDATE ai_request_usage SET reported_total_tokens=%s WHERE id=%s',(reported,request_id))
            if not isinstance(usage, dict) or 'input_tokens' not in usage or 'output_tokens' not in usage:
                if isinstance(usage,dict) and usage.get('total_tokens') is not None:
                    upper=(Decimal(reported)*max(Decimal(value) for value in row['prices'].values())/1000000).quantize(Decimal('0.000000000001'))
                    db.execute('UPDATE ai_request_usage SET cost_cny=%s WHERE id=%s',(upper,request_id))
                db.execute("UPDATE ai_request_usage SET status='pending',settled_at=now() WHERE id=%s", (request_id,))
                return
            input_tokens = _integer(usage['input_tokens'], 0, 16777216)
            output_tokens = _integer(usage['output_tokens'], 0, 393216)
            details = usage.get('input_tokens_details') or {}
            if not isinstance(details, dict):
                raise WorkspaceConflictError('Invalid cached token usage')
            cached_tokens = _integer(details.get('cached_tokens', usage.get('cached_tokens', 0)), 0, input_tokens)
            cost = _cost(row['prices'], input_tokens, cached_tokens, output_tokens)
            db.execute("UPDATE ai_request_usage SET status='completed',input_tokens=%s,cached_tokens=%s,output_tokens=%s,cost_cny=%s,settled_at=now() WHERE id=%s", (input_tokens, cached_tokens, output_tokens, cost, request_id))

    def mark_unknown(self, request_id):
        with transaction(self.url, write=True) as db:
            db.execute("UPDATE ai_request_usage SET status='pending',settled_at=now() WHERE id=%s AND status='inflight'", (request_id,))

    def void_request(self, request_id):
        """Call only when the proxy knows no provider request was sent."""
        with transaction(self.url, write=True) as db:
            db.execute("UPDATE ai_request_usage SET status='void',cost_cny=0,settled_at=now() WHERE id=%s AND status='inflight'", (request_id,))

    def recover_inflight(self):
        with transaction(self.url, write=True) as db:
            db.execute("UPDATE ai_request_usage SET status='pending',settled_at=now() WHERE status='inflight'")

    def usage(self, actor=None):
        with transaction(self.url) as db:
            if actor is not None:
                _actor(db, actor)
            owners = [actor] if actor is not None else [row[0] for row in db.execute('SELECT DISTINCT owner_id FROM ai_request_usage ORDER BY owner_id').fetchall()]
            budget = self.config(db)['budget']['value']
            users = []
            for owner in owners:
                identity = _one(db, 'SELECT display_name,department FROM ai_request_usage WHERE owner_id=%s ORDER BY created_at DESC,id DESC LIMIT 1', (owner,))
                if identity is not None:
                    users.append({'owner_id': owner, **identity, **self._totals(db, owner), 'monthly_cny': budget['user_overrides'].get(owner, budget['user_monthly_cny'])})
            departments = {}
            if actor is None:
                _, since, until = self._month()
                departments = _rows(db, '''SELECT department,count(*) AS requests,
                    COALESCE(sum(cost_cny) FILTER(WHERE status='completed'),0)::text AS cost_cny,
                    COALESCE(sum(cost_cny) FILTER(WHERE status='pending'),0)::text AS pending_cny,
                    COALESCE(sum(input_tokens),0)::bigint AS input_tokens,COALESCE(sum(cached_tokens),0)::bigint AS cached_tokens,
                    COALESCE(sum(output_tokens),0)::bigint AS output_tokens,COALESCE(sum(COALESCE(input_tokens+output_tokens,reported_total_tokens)),0)::bigint AS total_tokens
                    FROM ai_request_usage WHERE created_at>=%s AND created_at<%s AND status!='void' GROUP BY department ORDER BY department''', (since, until))
            return {'month': self._month()[0], 'totals': self._totals(db, actor), 'users': users, 'departments': departments or [], 'quota': self._quota(db, actor) if actor else None}

    def _key_path(self, version, *, create=False):
        version = str(UUID(version))
        root = self.data_dir.resolve()
        directory = root / 'private-ai-credentials'
        if directory.is_symlink() or directory.is_junction():
            raise WorkspaceConflictError('Credential directory links are forbidden')
        if create:
            directory.mkdir(mode=0o700, parents=True, exist_ok=True)
            if os.name != 'nt':
                os.chmod(directory, 0o700)
        path = directory / (version + '.key')
        if path.is_symlink() or path.is_junction():
            raise WorkspaceConflictError('Credential links are forbidden')
        return path

    def replace_key(self, key, actor):
        if not isinstance(key, str) or not 8 <= len(key) <= 512 or any(not 33 <= ord(char) <= 126 for char in key):
            raise WorkspaceConflictError('API密钥格式无效')
        with transaction(self.url, write=True) as db:
            self._admin(db, actor)
            version = str(uuid4())
            path = self._key_path(version, create=True)
            descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
                stream.write(key)
                stream.flush()
                os.fsync(stream.fileno())
            db.execute('INSERT INTO ai_credentials(version,created_by) VALUES(%s,%s)', (version, actor))
            return {'configured': True, 'version': version}

    def key_status(self, fallback=None):
        with transaction(self.url) as db:
            row = _one(db, 'SELECT version,created_at::text AS updated_at FROM ai_credentials ORDER BY _order DESC LIMIT 1')
            return {'configured': row is not None or bool(fallback and Path(fallback).is_file()), 'version': row['version'] if row else None, 'updated_at': row['updated_at'] if row else None}

    def key_path(self, version=None):
        if version is None:
            with transaction(self.url) as db:
                row = db.execute('SELECT version FROM ai_credentials ORDER BY _order DESC LIMIT 1').fetchone()
                version = row[0] if row else None
        return self._key_path(version) if version is not None else None

    def read_key(self, version=None, fallback=None):
        if version is None and fallback is None:
            with transaction(self.url) as db:
                row = db.execute('SELECT version FROM ai_credentials ORDER BY _order DESC LIMIT 1').fetchone()
                version = row[0] if row else None
        path = self._key_path(version) if version is not None else Path(fallback) if fallback else None
        if path is None:
            raise WorkspaceConflictError('API密钥未配置')
        try:
            if path.is_symlink() or path.is_junction():
                raise ValueError
            raw = path.read_bytes()
            if len(raw) > 65536:
                raise ValueError
            text = raw.decode('utf-8-sig').strip()
            if version is not None:
                if not 8 <= len(text) <= 512 or any(not 33 <= ord(char) <= 126 for char in text):
                    raise ValueError
                return text
            keys = set(re.findall(r'(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,}', text))
            if len(keys) != 1:
                raise ValueError
            return keys.pop()
        except (OSError, UnicodeError, ValueError):
            raise WorkspaceConflictError('API密钥文件不可用') from None
