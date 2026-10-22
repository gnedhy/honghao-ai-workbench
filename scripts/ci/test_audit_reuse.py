import copy
from datetime import datetime, timezone
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('reuse', Path(__file__).with_name('reuse-dependency-audit.py'))
reuse = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reuse)


class AuditReuse(unittest.TestCase):
    def test_only_recent_successful_unchanged_audit_can_pass(self):
        now = datetime(2026, 10, 22, 3, tzinfo=timezone.utc)
        run = {'conclusion': 'success', 'status': 'completed', 'head_repository': {'full_name': 'owner/repo'},
               'path': '.github/workflows/frontend-checks.yml', 'created_at': '2026-10-22T00:00:00Z'}
        report = {'schema': 1, 'complete': True, 'count': 0, 'auditedPackages': 184}
        files = dict.fromkeys(reuse.FILES, b'locked')
        reuse.validate(run, report, files, files, 'owner/repo', now)
        for field, value in [('conclusion', 'failure'), ('created_at', '2026-10-20T00:00:00Z'),
                             ('created_at', '2026-10-23T00:00:00Z'), ('path', 'other.yml'),
                             ('head_repository', {'full_name': 'fork/repo'})]:
            bad = copy.deepcopy(run); bad[field] = value
            with self.assertRaises(AssertionError): reuse.validate(bad, report, files, files, 'owner/repo', now)
        for field, value in [('complete', False), ('count', 1), ('auditedPackages', 0)]:
            bad = {**report, field: value}
            with self.assertRaises(AssertionError): reuse.validate(run, bad, files, files, 'owner/repo', now)
        for name in reuse.FILES:
            with self.assertRaises(AssertionError):
                reuse.validate(run, report, files, {**files, name: b'changed'}, 'owner/repo', now)
