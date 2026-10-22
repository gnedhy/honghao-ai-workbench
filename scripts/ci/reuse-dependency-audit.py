"""Reuse a recent successful same-repository audit only for identical dependencies."""
import argparse
import base64
from datetime import datetime, timezone, timedelta
import json
from pathlib import Path
import subprocess
import tempfile


FILES = ('package.json', 'package-lock.json', 'pyproject.toml', 'uv.lock')


def validate(run, report, previous, current, repository, now):
    assert run['conclusion'] == 'success' and run['status'] == 'completed'
    assert run['head_repository']['full_name'] == repository
    assert run['path'] == '.github/workflows/frontend-checks.yml'
    # Creation time bounds the audit age more conservatively than completion time.
    age = now - datetime.fromisoformat(run['created_at'].replace('Z', '+00:00'))
    assert timedelta(0) <= age <= timedelta(hours=24), 'Previous audit is older than 24 hours'
    assert report['schema'] == 1 and report['complete'] is True and report['count'] == 0
    assert type(report['auditedPackages']) is int and report['auditedPackages'] > 0
    assert all(previous[name].replace(b'\r\n', b'\n') == current[name].replace(b'\r\n', b'\n') for name in FILES), 'Dependencies changed'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--run-id', required=True, type=int)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    def gh(*arguments):
        return subprocess.check_output(['gh', *arguments], text=True, encoding='utf-8')
    repository = json.loads(gh('repo', 'view', '--json', 'nameWithOwner'))['nameWithOwner']
    run = json.loads(gh('api', f'repos/{repository}/actions/runs/{args.run_id}'))
    previous = {}
    for name in FILES:
        item = json.loads(gh('api', f'repos/{repository}/contents/{name}?ref={run["head_sha"]}'))
        previous[name] = base64.b64decode(item['content'])
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=args.output.parent) as directory:
        gh('run', 'download', str(args.run_id), '-n', 'full-quality-results', '-D', directory)
        report = json.loads((Path(directory) / 'dependency-audit.json').read_text())
    validate(run, report, previous, {name: Path(name).read_bytes() for name in FILES}, repository, datetime.now(timezone.utc))
    report['reusedFrom'] = {'runId': args.run_id, 'headSha': run['head_sha'], 'createdAt': run['created_at']}
    args.output.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(f'PASS audit reuse: run {args.run_id}; unchanged dependencies; age <= 24h; zero findings')


if __name__ == '__main__':
    main()
