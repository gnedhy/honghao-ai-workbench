"""Retain test identity/status/timing only; never upload tracebacks, DBs or credentials."""
from pathlib import Path
import json
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
    (destination / "collection.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    return receipt


if __name__ == "__main__":
    print(json.dumps(collect(Path.cwd()), sort_keys=True))
