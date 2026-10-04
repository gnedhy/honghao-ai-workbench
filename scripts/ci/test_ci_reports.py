"""CI report collection must preserve failures without copying failure payloads."""
import importlib.util
from pathlib import Path
import tempfile
import json
import unittest
import xml.etree.ElementTree as ET

spec = importlib.util.spec_from_file_location("ci_reports", Path(__file__).with_name("collect-reports.py"))
reports = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reports)


class ReportBoundaries(unittest.TestCase):
    def test_no_junit_does_not_claim_api_passed(self):
        with tempfile.TemporaryDirectory() as directory:
            receipt = reports.collect(Path(directory))
            self.assertFalse(receipt["api_report_present"])
            self.assertNotIn("api", receipt)

    def test_failure_error_and_parameters_do_not_export_payloads(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            original = root / ".scratch/verify/all/api-results.xml"
            original.parent.mkdir(parents=True)
            fixture_dsn = "postgresql://synthetic:private-fixture-value@127.0.0.1:55432/honghao_test"
            original.write_text('<testsuites><testsuite>'
                f'<testcase name="test_restore[{fixture_dsn}]" classname="tests.test_operations" time="1.25">'
                f'<failure message="{fixture_dsn}">{fixture_dsn}</failure><system-out>{fixture_dsn}</system-out></testcase>'
                '<testcase name="test_boot" classname="tests.test_operations" time="0.5"><error>private</error></testcase>'
                '</testsuite></testsuites>', encoding="utf-8")
            receipt = reports.collect(root)
            self.assertEqual(receipt["api"], {"tests": 2, "failures": 1, "errors": 1, "skipped": 0})
            output = (root / "ci-reports/api-results.xml").read_text(encoding="utf-8")
            self.assertNotIn(fixture_dsn, output)
            self.assertNotIn("private", output)
            self.assertEqual(len(list(ET.fromstring(output).iter("testcase"))), 2)

    def test_malformed_junit_fails_collection(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            original = root / ".scratch/verify/all/api-results.xml"
            original.parent.mkdir(parents=True)
            original.write_text("<not-closed>", encoding="utf-8")
            with self.assertRaises(ET.ParseError):
                reports.collect(root)

    def test_performance_reports_keep_only_numeric_samples_and_do_not_copy_payloads(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); (root / 'scripts').mkdir()
            fixture = {'apiSamples': 3, 'browserSamples': 5, 'apiProducts': 200}
            policy = {'fixture': fixture, 'limits': {'api.catalog.medianMs': 10, 'api.catalog.maxMs': 20, 'api.catalog.sqlCalls': 4}, 'apiProfiles': {'catalog': {'module': 'sales'}}}
            (root / 'scripts/performance-budgets.json').write_text(json.dumps(policy), encoding='utf-8')
            source = root / '.scratch/performance-budget/api.json'; source.parent.mkdir(parents=True)
            source.write_text(json.dumps({'schema': 1, 'kind': 'api', 'fixture': fixture, 'metrics': {'api.catalog.medianMs': 2, 'api.catalog.maxMs': 3, 'api.catalog.sqlCalls': 4}, 'samples': {'catalog': {'milliseconds': [1,2,3], 'sqlCalls': [4,4,4], 'payload': 'private fixture content'}}, 'error': 'private fixture content'}), encoding='utf-8')
            receipt = reports.collect(root)
            safe = (root / 'ci-reports/performance-api.json').read_text(encoding='utf-8')
            self.assertNotIn('private', safe); self.assertNotIn('payload', safe)
            self.assertTrue(receipt['performance']['api']['within_limits'])
            self.assertFalse(receipt['performance']['browser']['present'])
            policy['paginationModules'] = ['catalog']
            policy['limits'].update({f'browser.catalog.{key}': 20 for key in ('readyMedianMs','readyMaxMs','filterMedianMs','filterMaxMs','requests','pageMedianMs','pageMaxMs')})
            (root / 'scripts/performance-budgets.json').write_text(json.dumps(policy), encoding='utf-8')
            (source.parent / 'browser.json').write_text(json.dumps({'schema':1,'kind':'browser','fixture':fixture,'metrics':{key:2 for key in policy['limits'] if key.startswith('browser.')},'samples':{'catalog':{'ready':[1,2,3,4,5],'filtered':[1,2,3,4,5],'requestCounts':[0,0,0,0,0],'paged':[1,2,3,4,5],'query':'private'}}}), encoding='utf-8')
            reports.collect(root)
            browser = json.loads((root / 'ci-reports/performance-browser.json').read_text(encoding='utf-8'))
            self.assertEqual(browser['samples']['catalog']['paged'], [1,2,3,4,5])
            self.assertNotIn('private', json.dumps(browser))

    def test_performance_metric_strings_are_rejected_before_export(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); (root / 'scripts').mkdir()
            (root / 'scripts/performance-budgets.json').write_text(json.dumps({'fixture': {'apiSamples': 3}, 'limits': {'bundle.bytes': 10}}), encoding='utf-8')
            source = root / '.scratch/performance-budget/bundle.json'; source.parent.mkdir(parents=True)
            source.write_text(json.dumps({'schema': 1, 'kind': 'bundle', 'metrics': {'bundle.bytes': 'private'}}), encoding='utf-8')
            with self.assertRaises(ValueError): reports.collect(root)


if __name__ == "__main__":
    unittest.main()
