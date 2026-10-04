"""Retain test identity/status/timing only; never upload tracebacks, DBs or credentials."""
from pathlib import Path
import json
import math
import re
import xml.etree.ElementTree as ET


def collect(root: Path) -> dict:
    destination = root / "ci-reports"
    destination.mkdir(exist_ok=True)
    original = root / ".scratch/verify/all/api-results.xml"
    receipt = {"scope": "all", "api_report_present": original.is_file(), "synthetic_data_only": True}
    if original.is_file():
        suites = ET.Element("testsuites")
        suite = ET.SubElement(suites, "testsuite", name="api", tests="0", failures="0", errors="0", skipped="0")
        counts = {key: 0 for key in ("tests", "failures", "errors", "skipped")}
        for item in ET.parse(original).getroot().iter("testcase"):
            counts["tests"] += 1
            # Parameter values may include a DSN even in synthetic tests; retain only identifiers.
            name = item.get("name", "").split("[", 1)[0]
            classname = item.get("classname", "")
            if not re.fullmatch(r"[A-Za-z_][A-Za-z_0-9]*", name):
                raise ValueError("Unexpected test identifier in CI report")
            if not re.fullmatch(r"[A-Za-z_][A-Za-z_0-9.]*", classname):
                raise ValueError("Unexpected test class identifier in CI report")
            testcase = ET.SubElement(suite, "testcase", name=name, classname=classname,
                                     time=str(float(item.get("time", "0"))))
            for status, count in (("failure", "failures"), ("error", "errors"), ("skipped", "skipped")):
                if item.find(status) is not None:
                    ET.SubElement(testcase, status, message="See masked workflow log for details")
                    counts[count] += 1
        suite.attrib.update({key: str(value) for key, value in counts.items()})
        ET.ElementTree(suites).write(destination / "api-results.xml", encoding="utf-8", xml_declaration=True)
        receipt["api"] = counts
    budget_file = root / 'scripts/performance-budgets.json'
    if budget_file.is_file():
        policy = json.loads(budget_file.read_text(encoding='utf-8'))
        fixture = policy['fixture']
        if any(not isinstance(value, int) or isinstance(value, bool) or value <= 0 for value in fixture.values()):
            raise ValueError('Invalid numeric performance workload')
        receipt['performance'] = {}
        for kind in ('bundle', 'browser', 'api'):
            source = root / f'.scratch/performance-budget/{kind}.json'
            receipt['performance'][kind] = {'present': source.is_file()}
            if not source.is_file():
                continue
            report = json.loads(source.read_text(encoding='utf-8'))
            if report.get('schema') != 1 or report.get('kind') != kind:
                raise ValueError('Invalid performance report identity')
            expected = {key: value for key, value in policy['limits'].items() if key.startswith(kind + '.')}
            metrics = report['metrics']
            if set(metrics) != set(expected) or any(not re.fullmatch(r'[A-Za-z0-9_.]+', key) for key in metrics):
                raise ValueError('Unexpected performance metric identifier')
            def numeric(value):
                return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0
            if not all(numeric(value) for value in metrics.values()):
                raise ValueError('Performance reports may retain only finite numeric measurements')
            safe = {'schema': 1, 'kind': kind, 'fixture': fixture, 'metrics': metrics,
                    'within_limits': all(value <= expected[key] for key, value in metrics.items())}
            if kind != 'bundle':
                if report.get('fixture') != fixture:
                    raise ValueError('Performance report workload mismatch')
                fields = ('milliseconds', 'sqlCalls') if kind == 'api' else ('ready', 'filtered', 'requestCounts')
                count = fixture['apiSamples' if kind == 'api' else 'browserSamples']
                ids = set(policy['apiProfiles']) if kind == 'api' else {key.split('.')[1] for key in expected}
                if set(report['samples']) != ids:
                    raise ValueError('Missing performance report samples')
                safe['samples'] = {}
                for name in sorted(ids):
                    safe['samples'][name] = {}
                    profile_fields = fields + ('paged',) if kind == 'browser' and name in policy.get('paginationModules', []) else fields
                    for field in profile_fields:
                        values = report['samples'][name][field]
                        if not isinstance(values, list) or len(values) != count or not all(numeric(value) for value in values):
                            raise ValueError('Invalid performance sample values')
                        safe['samples'][name][field] = values
            (destination / f'performance-{kind}.json').write_text(json.dumps(safe, indent=2) + '\n', encoding='utf-8')
            receipt['performance'][kind]['within_limits'] = safe['within_limits']
    (destination / "collection.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    return receipt


if __name__ == "__main__":
    print(json.dumps(collect(Path.cwd()), sort_keys=True))
