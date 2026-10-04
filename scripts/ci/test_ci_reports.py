"""CI report collection must preserve failures without copying failure payloads."""
import importlib.util
from pathlib import Path
import tempfile
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


if __name__ == "__main__":
    unittest.main()
