"""Read-only local service probes. Output contains fixed check IDs and numeric metadata only."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
from html import escape
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import time
import urllib.error
import urllib.request
from importlib.util import module_from_spec, spec_from_file_location

UTC = timezone.utc
LEVELS = {'ok': 0, 'warning': 1, 'critical': 2}
READINESS = {'database', 'database_environment', 'schema_versions', 'application_role',
             'data_directory', 'module_configuration', 'runtime_startup'}
SOURCES = ('商务部', '生意社', '隆众资讯')
SUPPORTED_CHECKS = {'health', 'readiness', 'api_errors', 'research_backlog', 'procurement_backlog',
                    'news_task', 'news_source_1', 'news_source_2', 'news_source_3',
                    'runtime.procurement_scheduler', 'runtime.research_startup', 'runtime.research_scheduler'}


def validate_contract(policy, workbenches):
    if policy.get('schema') != 1 or set(policy.get('moduleChecks', {})) != {row['id'] for row in workbenches if row['entry'] is not None}:
        raise ValueError('Every implemented workbench requires an operations profile')
    for names in policy['moduleChecks'].values():
        if not isinstance(names, list) or not names or len(set(names)) != len(names) or not set(names) <= SUPPORTED_CHECKS:
            raise ValueError('Unknown or missing executable monitoring checks')
    numeric = {key:value for key,value in policy.items() if key not in ('schema','moduleChecks')}
    if any(type(value) not in (int,float) or not math.isfinite(value) or value <= 0 for value in numeric.values()):
        raise ValueError('Invalid operations threshold')
    if not (policy['diskCriticalGiB'] < policy['diskWarningGiB'] and policy['backupWarningHours'] < policy['backupCriticalHours'] and policy['intervalSeconds'] < policy['staleAfterSeconds'] and 0 < policy['errorRateCritical'] < 1):
        raise ValueError('Invalid operations threshold ordering')


def read_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def sha256(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def age_seconds(value, now):
    stamp = datetime.fromisoformat(value)
    if stamp.tzinfo is None:
        raise ValueError('Missing timestamp timezone')
    return (now - stamp).total_seconds()


def contained(root, value):
    path = Path(value).resolve()
    if not path.is_relative_to(root.resolve()) or path == root.resolve():
        raise ValueError('Path outside expected root')
    return path


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError('Redirect rejected')


def get_http(url, timeout):
    # No proxies, redirects, cookies, authentication or business write requests.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    began = time.monotonic()
    try:
        response = opener.open(urllib.request.Request(url, headers={'Accept-Encoding': 'identity'}), timeout=timeout)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        content = response.read(4_000_001)
        if len(content) > 4_000_000:
            raise ValueError('Probe response too large')
        return response.status, content, (time.monotonic() - began) * 1000


def process_check(root):
    result = subprocess.run(['powershell.exe', '-NoProfile', '-File', str(Path(__file__).with_name('monitor-process.ps1')),
                             '-ApplicationRoot', str(root)], capture_output=True, timeout=20)
    return result.returncode == 0


def verify_backup(release, snapshot):
    # Existing full verifier checks hashes, references, schema, TOC and decompressed archive.
    environment = dict(os.environ, HONGHAO_PG_BIN='C:/Program Files/PostgreSQL/18/bin', PYTHONUTF8='1')
    environment.pop('HONGHAO_DATABASE_URL', None)
    code = "from api.operations import verify_snapshot; from pathlib import Path; import sys; verify_snapshot(Path(sys.argv[1]), expected_environment='production', expected_database_environment='production')"
    result = subprocess.run([str(release / '.venv/Scripts/python.exe'), '-X', 'utf8', '-c', code, str(snapshot)],
                            cwd=release, env=environment, capture_output=True, timeout=180)
    return result.returncode == 0


def queue_checks(root, now):
    import psycopg
    try:
        profile = read_json(root.parent / 'postgresql-credentials/databases.json')['production']
        with psycopg.connect(profile['app']['url'], autocommit=True, connect_timeout=3,
                             options='-c default_transaction_read_only=on -c statement_timeout=3000 -c lock_timeout=1000') as connection:
            research = connection.execute("SELECT count(*), count(*) FILTER (WHERE status='failed'), coalesce(max(EXTRACT(EPOCH FROM (%s::timestamptz-recorded_at::timestamptz))),0) FROM research_events WHERE status!='done'", (now.isoformat(),)).fetchone()
            procurement = connection.execute("SELECT count(*), coalesce(max(EXTRACT(EPOCH FROM (%s::timestamptz-scheduled_activate_at::timestamptz))),0) FROM procurement_updates WHERE status='scheduled' AND scheduled_activate_at::timestamptz < %s::timestamptz", (now.isoformat(), now.isoformat())).fetchone()
        return {'research': {'pending': int(research[0]), 'failed': int(research[1]), 'oldestSeconds': float(research[2])},
                'procurement': {'overdue': int(procurement[0]), 'oldestSeconds': float(procurement[1])}}
    except (OSError, ValueError, KeyError, psycopg.Error):
        return None


def log_sample(path, previous, limit):
    size = path.stat().st_size
    initial = previous.get('name') != path.name or size < previous.get('offset', 0)
    offset = max(0, size - limit) if initial else previous.get('offset', 0)
    truncated = size - offset > limit
    offset = max(offset, size - limit)
    with path.open('rb') as stream:
        leading_partial = offset > 0
        if leading_partial:
            stream.seek(offset - 1)
            leading_partial = stream.read(1) != b'\n'
        stream.seek(offset)
        raw = stream.read(limit)
    complete = raw.rfind(b'\n') + 1
    lines = raw[:complete].decode('utf-8', errors='replace').splitlines()
    if leading_partial:
        lines = lines[1:]  # Never persist raw log text; re-read the unfinished tail next time.
    counts = {'requests': 0, 'serverErrors': 0, 'clientErrors': 0}
    for line in lines:
        match = re.search(r'"[A-Z]+ (/api/[^ ]*) HTTP/[0-9.]+" (\d{3})\b', line)
        if not match or match[1].split('?', 1)[0] in {'/api/health', '/api/readiness'}:
            continue
        status = int(match[2]); counts['requests'] += 1
        counts['serverErrors'] += status >= 500
        counts['clientErrors'] += 400 <= status < 500
    return counts, {'name': path.name, 'offset': offset + complete}, initial or truncated


def probe(root, policy, previous, now, http=get_http, owner=process_check, backup=verify_backup, dependencies=None, queues=queue_checks):
    checks, state = {}, {}
    def check(name, level='ok', **numbers):
        if level not in LEVELS or not all(type(value) in (int, float) and math.isfinite(value) for value in numbers.values()):
            raise ValueError('Invalid monitor result')
        checks[name] = {'level': level, **numbers}
    check('monitor_probe')
    active_path = root / 'active.json'
    active_hash = sha256(active_path)
    config = read_json(active_path)
    if config.get('database_profile') != 'production' or config.get('host') != '127.0.0.1' or type(config.get('port')) is not int or not 1 <= config['port'] <= 65535:
        raise ValueError('Unexpected production identity')
    release = contained(root / 'releases', config['release_dir'])
    data = contained(root, config['data_dir'])
    if not release.is_dir() or not data.is_dir() or data.is_relative_to(root / 'releases'):
        raise ValueError('Invalid deployment directories')
    origin = f"http://127.0.0.1:{config['port']}"
    check('process_identity', 'ok' if owner(root) else 'critical')
    modes = read_json(data / 'workbench-runtime-config.json')['workbench_modes']
    expected = READINESS.copy()
    if modes.get('procurement') == 'active': expected.add('procurement_scheduler')
    if modes.get('research') == 'active': expected.update(('research_startup', 'research_scheduler'))
    jobs = queues(root, now)
    if jobs is None:
        check('task_queues', 'critical')
        for name in ('research', 'procurement'):
            if modes.get(name) == 'active': check(name + '_backlog', 'critical')
    else:
        check('task_queues')
        for name in ('research', 'procurement'):
            if modes.get(name) != 'active': continue
            row = jobs[name]
            failed = row.get('failed', 0) > 0 or row['oldestSeconds'] >= policy['taskBacklogSeconds']
            check(name + '_backlog', 'critical' if failed else 'warning' if row.get('pending', row.get('overdue', 0)) > 0 else 'ok', **row)
    for name in ('health', 'readiness'):
        try:
            status, raw, elapsed = http(origin + '/api/' + name, policy['requestTimeoutSeconds'])
            payload = json.loads(raw)
            good = status == 200 and (payload.get('status') == 'ok' and payload.get('environment') == 'production' and payload.get('service') == 'honghao-ai-api' if name == 'health' else payload.get('status') == 'ready' and expected <= payload.get('checks', {}).keys() and all(value == 'ok' for value in payload['checks'].values()))
            check(name, 'ok' if good else 'critical', milliseconds=round(elapsed, 3), httpStatus=status)
            if name == 'readiness':
                for key in expected:
                    check('runtime.' + key, 'ok' if payload.get('checks', {}).get(key) == 'ok' else 'critical')
            check(name + '_latency', 'warning' if elapsed > policy['slowRequestMilliseconds'] else 'ok', milliseconds=round(elapsed, 3))
        except (OSError, ValueError, KeyError, TypeError):
            check(name, 'critical')
            if name == 'readiness':
                for key in expected: check('runtime.' + key, 'critical')
    manifest = read_json(release / 'release-manifest.json')
    records = manifest.get('files', {})
    if not isinstance(records, dict) or not {'dist/index.html', 'api/main.py'} <= records.keys():
        raise ValueError('Missing protected release files')
    mismatches = 0; online_mismatches = 0
    for relative, expected_hash in records.items():
        if not re.fullmatch(r'[a-zA-Z0-9_./-]+', relative) or '..' in Path(relative).parts or not re.fullmatch(r'[a-f0-9]{64}', expected_hash):
            raise ValueError('Invalid release manifest')
        file = contained(release, release / relative)
        mismatches += not file.is_file() or sha256(file) != expected_hash
        if relative.startswith('dist/'):
            try:
                status, content, _ = http(origin + ('/' if relative == 'dist/index.html' else '/' + relative[5:]), policy['requestTimeoutSeconds'])
                online_mismatches += status != 200 or hashlib.sha256(content).hexdigest() != expected_hash
            except (OSError, ValueError): online_mismatches += 1
    check('release_files', 'critical' if mismatches else 'ok', checked=len(records), mismatches=mismatches)
    check('served_assets', 'critical' if online_mismatches else 'ok', mismatches=online_mismatches)
    if modes.get('procurement') == 'active':
        try:
            news = read_json(data / 'procurement-news/cache.json')
            checked_age = age_seconds(news['checked_at'], now)
            check('news_task', 'warning' if not -policy['futureSkewSeconds'] <= checked_age <= policy['newsStaleSeconds'] else 'ok', ageSeconds=round(checked_age))
            for index, name in enumerate(SOURCES):
                row = news['sources'].get(name, {})
                if not isinstance(row, dict): row = {}
                try: age = age_seconds(row.get('last_success'), now)
                except (ValueError, TypeError): age = policy['newsStaleSeconds'] + 1
                stale = not -policy['futureSkewSeconds'] <= age <= policy['newsStaleSeconds']
                check('news_source_' + str(index + 1), 'warning' if row.get('error') or stale or not isinstance(row.get('items'), list) or not row['items'] else 'ok', ageSeconds=round(age))
        except (OSError, ValueError, KeyError, TypeError):
            check('news_task', 'warning')
            for index in range(1, 4): check('news_source_' + str(index), 'warning')
    free = min(shutil.disk_usage(release).free, shutil.disk_usage(data).free) / 1024**3
    check('disk', 'critical' if free < policy['diskCriticalGiB'] else 'warning' if free < policy['diskWarningGiB'] else 'ok', freeGiB=round(free, 2))
    candidates = []
    for location in (root / 'backups', data / 'backups'):
        if not location.exists(): continue
        for directory in location.rglob('snapshot-*'):
            if not directory.is_dir(): continue
            contained(location, directory)
            try:
                metadata = read_json(directory / 'manifest.json')
                age = age_seconds(metadata['created_at'], now)
                if metadata.get('version') == 2 and metadata.get('engine') == 'postgresql' and metadata.get('environment') == metadata.get('database_environment') == 'production' and age >= -policy['futureSkewSeconds']:
                    candidates.append((age, directory))
            except (OSError, ValueError, KeyError, TypeError): pass
    if not candidates:
        check('backup_age', 'critical'); check('backup_integrity', 'critical')
    else:
        age, snapshot = min(candidates, key=lambda row: row[0]); hours = age / 3600
        check('backup_age', 'critical' if hours > policy['backupCriticalHours'] else 'warning' if hours > policy['backupWarningHours'] else 'ok', ageHours=round(hours, 2))
        fingerprint = sha256(snapshot / 'manifest.json')
        old = previous.get('backup', {})
        verification_age = age_seconds(old.get('verifiedAt', '1970-01-01T00:00:00+00:00'), now)
        recent = old.get('manifest') == fingerprint and old.get('passed') is True and -policy['futureSkewSeconds'] <= verification_age < policy['backupVerifyHours'] * 3600
        passed = recent or backup(release, snapshot)
        state['backup'] = {'manifest': fingerprint, 'verifiedAt': old['verifiedAt'] if recent else now.isoformat(), 'passed': bool(passed)}
        check('backup_integrity', 'ok' if passed else 'critical', verificationAgeHours=round(age_seconds(state['backup']['verifiedAt'], now) / 3600, 2))
    logs = sorted(root.glob('service-*.out.log'), key=lambda path: path.stat().st_ctime, reverse=True)
    if logs:
        counts, state['log'], baseline = log_sample(logs[0], previous.get('log', {}), policy['maximumLogBytes'])
        ratio = counts['serverErrors'] / max(1, counts['requests'])
        level = 'critical' if counts['requests'] >= policy['minimumErrorRateRequests'] and ratio >= policy['errorRateCritical'] else 'warning' if counts['serverErrors'] else 'ok'
        check('api_errors', level, **counts, ratio=round(ratio, 6), baseline=int(baseline))
    else: check('api_errors', 'warning')
    check('deployment_stable', 'ok' if sha256(active_path) == active_hash else 'critical')
    for module, mode in modes.items():
        if mode == 'active' and (module not in policy['moduleChecks'] or not set(policy['moduleChecks'][module]) <= checks.keys()):
            raise ValueError('Active module has no executable monitoring profile')
    if dependencies:
        spec = spec_from_file_location('dependency_audit', Path(__file__).with_name('check-dependencies.py'))
        auditor = module_from_spec(spec); spec.loader.exec_module(auditor)
        valid = dependencies.get('schema') == 1 and dependencies.get('complete') is True and dependencies.get('locks') == auditor.lock_fingerprint(release)
        age = age_seconds(dependencies['checkedAt'], now) / 3600
        check('dependency_audit', 'critical' if not valid or dependencies.get('count', -1) != 0 else 'warning' if age > policy['dependencyStaleHours'] or age < -policy['futureSkewSeconds']/3600 else 'ok', vulnerabilities=dependencies.get('count', 0), ageHours=round(age, 2))
    else: check('dependency_audit', 'warning')
    report = {'schema': 1, 'checkedAt': now.isoformat(), 'level': max(checks.values(), key=lambda row: LEVELS[row['level']])['level'], 'checks': checks}
    return report, state


def advance_alerts(report, previous, policy):
    pending, transitions = dict(previous), []
    for name, row in report['checks'].items():
        old = previous.get(name, {})
        count = old.get('count', 0) + 1 if row['level'] != 'ok' else 0
        active = row['level'] != 'ok' and (old.get('active', False) or count >= (policy['criticalConfirmSamples'] if row['level'] == 'critical' else policy['confirmSamples']))
        pending[name] = {'count': count, 'active': active, 'level': row['level']}
        if active != old.get('active', False):
            transitions.append({'at': report['checkedAt'], 'check': name, 'state': 'opened' if active else 'recovered', 'level': row['level']})
        elif active and LEVELS[row['level']] > LEVELS[old.get('level', 'ok')]:
            transitions.append({'at': report['checkedAt'], 'check': name, 'state': 'escalated', 'level': row['level']})
    return pending, transitions


def save_reports(directory, report, state, policy):
    directory.mkdir(parents=True, exist_ok=True)
    def atomic(name, value):
        temporary = directory / (name + '.tmp')
        temporary.write_text(value, encoding='utf-8'); temporary.replace(directory / name)
    atomic('latest.json', json.dumps(report, indent=2) + '\n')
    atomic('state.json', json.dumps(state, indent=2) + '\n')
    day = report['checkedAt'][:10]
    with (directory / f'history-{day}.jsonl').open('a', encoding='utf-8') as stream: stream.write(json.dumps(report) + '\n')
    with (directory / f'alerts-{day}.jsonl').open('a', encoding='utf-8') as stream:
        for item in report['transitions']: stream.write(json.dumps(item) + '\n')
    for path in directory.glob('*.jsonl'):
        if re.fullmatch(r'(history|alerts)-\d{4}-\d{2}-\d{2}\.jsonl', path.name) and (datetime.now(UTC) - datetime.strptime(path.stem[-10:], '%Y-%m-%d').replace(tzinfo=UTC)).days > policy['retentionDays']:
            path.unlink()
    rows = ''.join('<tr><td>' + escape(name) + '</td><td>' + row['level'] + '</td><td>' + escape(json.dumps({k:v for k,v in row.items() if k != 'level'})) + '</td></tr>' for name, row in report['checks'].items())
    html = f'''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta http-equiv="refresh" content="30"><title>宏昊工作台运行巡检</title><style>body{{font:16px system-ui;max-width:1100px;margin:40px auto}}td,th{{padding:10px;text-align:left;border-bottom:1px solid #ddd}}.critical{{color:#b42318}}.warning{{color:#9a6700}}</style><h1>宏昊工作台运行巡检</h1><p id="fresh">检查时间：{escape(report['checkedAt'])}　状态：{report['level']}</p><p>严重异常立即形成告警，一般异常连续 {policy['confirmSamples']} 次形成告警；恢复记录见 alerts 文件。显示为 ok 的一次探针不替代业务验收。此页每 30 秒刷新。</p><table><tr><th>检查</th><th>状态</th><th>数值</th></tr>{rows}</table><script>if(Date.now()-Date.parse({json.dumps(report['checkedAt'])})>{policy['staleAfterSeconds']}000){{document.getElementById('fresh').textContent='巡检已过期，请核对计划任务与监测进程';document.getElementById('fresh').className='critical';}}</script></html>'''
    atomic('index.html', html)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--application-root', type=Path, default=Path('C:/ProgramData/HonghaoAI/application'))
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    root, output = args.application_root.resolve(), args.output.resolve()
    if output.is_relative_to(root):
        parser.error('Monitor reports must stay outside application data and releases')
    now = datetime.now(UTC)
    previous = {}
    def failure():
        return {'schema': 1, 'checkedAt': now.isoformat(), 'level': 'critical', 'checks': {'monitor_probe': {'level': 'critical'}}}
    policy = {'confirmSamples': 3, 'criticalConfirmSamples': 1, 'retentionDays': 30, 'staleAfterSeconds': 900}
    try:
        policy = read_json(Path(__file__).with_name('operations-policy.json'))
        validate_contract(policy, [{'id':name, 'entry':name} for name in policy['moduleChecks']])
        previous = read_json(output / 'state.json') if (output / 'state.json').exists() else {}
        if not isinstance(previous, dict) or not isinstance(previous.get('alerts', {}), dict):
            previous = {}
            raise ValueError('Invalid monitor state')
        dependency_file = output / 'dependencies.json'
        report, state = probe(root, policy, previous, now, dependencies=read_json(dependency_file) if dependency_file.exists() else None)
    except (OSError, ValueError, KeyError, TypeError, AttributeError, subprocess.SubprocessError):
        report = failure()
        state = {}
    try:
        state['alerts'], transitions = advance_alerts(report, previous.get('alerts', {}), policy)
        report['transitions'] = transitions
        report['confirmedAlerts'] = sum(row['active'] for row in state['alerts'].values())
        save_reports(output, report, state, policy)
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        report = failure()
        report.update(transitions=[], confirmedAlerts=1)
        try:
            save_reports(output, report, {'alerts': {}}, {'confirmSamples':3, 'criticalConfirmSamples':1, 'retentionDays':30, 'staleAfterSeconds':900})
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            pass  # Task result 2 and the stale dashboard expose an unwritable output directory.
    print(json.dumps({'level': report['level'], 'checkedAt': report['checkedAt'], 'confirmedAlerts': report['confirmedAlerts']}))
    return LEVELS[report['level']]


if __name__ == '__main__':
    raise SystemExit(main())
