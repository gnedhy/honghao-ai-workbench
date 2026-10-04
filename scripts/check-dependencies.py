"""Audit immutable lockfiles; retain package/advisory metadata, never raw command errors."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


def lock_fingerprint(project):
    digest = hashlib.sha256()
    for name in ('package-lock.json', 'uv.lock'):
        digest.update(name.encode()); digest.update((project / name).read_bytes())
    return digest.hexdigest()


def audit(project, output, uv='uv', npm='npm'):
    output.parent.mkdir(parents=True, exist_ok=True)
    receipt = {'schema': 1, 'checkedAt': datetime.now(timezone.utc).isoformat(),
               'locks': lock_fingerprint(project), 'complete': False, 'vulnerabilities': [], 'auditedPackages': 0}
    environment = {key:value for key,value in os.environ.items() if key.upper() not in {'NODE_ENV', 'NPM_CONFIG_OMIT', 'NPM_CONFIG_PRODUCTION', 'UV_NO_DEV', 'UV_ONLY_DEV', 'UV_GROUP', 'UV_ONLY_GROUP', 'UV_NO_GROUP', 'UV_ALL_GROUPS'}}
    try:
        with tempfile.TemporaryDirectory(prefix='dependency-audit-') as directory:
            temporary = Path(directory)
            # npm.cmd cannot be executed directly by CreateProcess. Use the installed CLI with Node.
            npm_args = [npm, 'audit', '--json', '--package-lock-only', '--include=prod', '--include=dev', '--include=optional', '--include=peer']
            if os.name == 'nt' and npm.lower().endswith('.cmd'):
                node = shutil.which('node')
                cli = Path(npm).parent / 'node_modules/npm/bin/npm-cli.js'
                npm_args = [node, str(cli), *npm_args[1:]]
            result = subprocess.run(npm_args, cwd=project, env=environment, capture_output=True, timeout=120)
            data = json.loads(result.stdout)
            if result.returncode not in (0, 1) or data.get('error') or not isinstance(data.get('vulnerabilities'), dict) or not isinstance(data.get('metadata'), dict):
                raise ValueError('npm audit unavailable')
            npm_packages = data['metadata'].get('dependencies', {}).get('total')
            if type(npm_packages) is not int or npm_packages <= 0:
                raise ValueError('Unaudited npm dependencies')
            for name, row in data['vulnerabilities'].items():
                found = False
                for advisory in row.get('via', []):
                    if isinstance(advisory, dict):
                        receipt['vulnerabilities'].append({'ecosystem': 'npm', 'package': name, 'id': str(advisory.get('source')), 'severity': row['severity']})
                        found = True
                if not found:
                    receipt['vulnerabilities'].append({'ecosystem': 'npm', 'package': name, 'id': 'transitive', 'severity': row['severity']})
            if data['metadata'].get('vulnerabilities', {}).get('total', 0) and not receipt['vulnerabilities']:
                raise ValueError('Incomplete npm advisory results')
            if result.returncode and not receipt['vulnerabilities']:
                raise ValueError('Failed npm audit without advisory evidence')
            receipt['auditedPackages'] += npm_packages
            export = subprocess.run([uv, 'export', '--locked', '--all-groups', '--no-emit-project', '--no-hashes', '--output-file', str(temporary / 'requirements.txt')], cwd=project, env=environment, capture_output=True, timeout=60)
            if export.returncode: raise ValueError('Locked dependency export failed')
            result = subprocess.run([uv, 'tool', 'run', '--from', 'pip-audit==2.10.1', 'pip-audit', '--requirement', str(temporary / 'requirements.txt'),
                                     '--no-deps', '--disable-pip', '--strict', '--format', 'json', '--desc', 'off', '--aliases', 'off',
                                     '--output', str(temporary / 'python.json')], cwd=project, env=environment, capture_output=True, timeout=180)
            data = json.loads((temporary / 'python.json').read_text(encoding='utf-8'))
            if result.returncode not in (0, 1) or not isinstance(data.get('dependencies'), list) or not data['dependencies']: raise ValueError('Python audit unavailable')
            python_findings = 0
            for row in data['dependencies']:
                if row.get('skip_reason'): raise ValueError('Unaudited dependency')
                receipt['auditedPackages'] += 1
                for item in row['vulns']:
                    python_findings += 1
                    receipt['vulnerabilities'].append({'ecosystem': 'pypi', 'package': row['name'], 'version': row['version'], 'id': item['id'], 'fixVersions': item['fix_versions']})
            if result.returncode and not python_findings:
                raise ValueError('Failed Python audit without advisory evidence')
            receipt['complete'] = True
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        pass  # An incomplete receipt always fails. Raw stderr is deliberately excluded.
    receipt['count'] = len(receipt['vulnerabilities'])
    temporary = output.with_suffix('.tmp')
    temporary.write_text(json.dumps(receipt, indent=2) + '\n', encoding='utf-8'); temporary.replace(output)
    return receipt


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--project', type=Path, default=Path.cwd())
    parser.add_argument('--application-root', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--uv', default='uv')
    parser.add_argument('--npm', default=shutil.which('npm') or 'npm')
    args = parser.parse_args()
    project = args.project.resolve()
    if args.application_root:
        root = args.application_root.resolve()
        active = json.loads((root / 'active.json').read_text(encoding='utf-8-sig'))
        project = Path(active['release_dir']).resolve()
        if active.get('database_profile') != 'production' or not project.is_relative_to(root / 'releases'):
            parser.error('Invalid active production release')
    if args.application_root and args.output.resolve().is_relative_to(args.application_root.resolve()): parser.error('Production audit reports must stay outside application files')
    receipt = audit(project, args.output.resolve(), args.uv, args.npm)
    print(json.dumps({'complete': receipt['complete'], 'count': receipt['count'], 'auditedPackages': receipt['auditedPackages']}))
    return 0 if receipt['complete'] and receipt['count'] == 0 else 1


if __name__ == '__main__':
    raise SystemExit(main())
