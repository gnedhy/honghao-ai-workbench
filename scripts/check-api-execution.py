"""Validate executed API tests against the fresh scoped collection, without a database."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
import xml.etree.ElementTree as ET


def validate_execution(collection: dict, xml: str, files: list[str]) -> int:
    if not isinstance(collection, dict) or collection.get("schema") != 1:
        raise ValueError("Invalid current API collection")
    nodeids = collection.get("nodeids")
    if not isinstance(nodeids, list) or not nodeids or any(not isinstance(nodeid, str) or "::" not in nodeid for nodeid in nodeids):
        raise ValueError("Missing or invalid collected API nodeids")
    if len(set(nodeids)) != len(nodeids) or collection.get("count") != len(nodeids):
        raise ValueError("Collection count is inconsistent or duplicated")
    selected = set(files)
    if selected and not selected <= {nodeid.split("::", 1)[0] for nodeid in nodeids}:
        raise ValueError("Selected API scope contains uncollected files")
    expected = {}
    for nodeid in nodeids:
        file, tail = nodeid.split("::", 1)
        if selected and file not in selected:
            continue
        declaration, bracket, parameter = tail.partition("[")
        parts = declaration.split("::")
        classname = ".".join([file.removesuffix(".py").replace("/", "."), *parts[:-1]])
        key = (classname, parts[-1] + (bracket + parameter if bracket else ""))
        if key in expected:
            raise ValueError("Collected API IDs have ambiguous JUnit identity")
        expected[key] = nodeid
    if not expected:
        raise ValueError("Expected API execution scope is empty")
    root = ET.fromstring(xml)
    if root.tag not in {"testsuites", "testsuite"}:
        raise ValueError("Invalid JUnit root")
    suites = [root] if root.tag == "testsuite" else list(root.iter("testsuite"))
    if not suites:
        raise ValueError("Missing JUnit suite")
    for suite in suites:
        for field in ("errors", "failures", "skipped"):
            if int(suite.get(field, "-1")) != 0:
                raise ValueError(f"API execution contains {field}, including dynamic skips or expected failures")
    seen = set()
    cases = list(root.iter("testcase"))
    for case in cases:
        if any(child.tag in {"error", "failure", "skipped"} for child in case):
            raise ValueError("API testcase did not pass; dynamic skip/xfail cannot satisfy execution")
        key = (case.get("classname"), case.get("name"))
        if key not in expected:
            raise ValueError(f"JUnit contains an uncollected API identity: {key}")
        if key in seen:
            raise ValueError(f"JUnit duplicated API execution: {expected[key]}")
        seen.add(key)
    missing = set(expected) - seen
    if missing:
        raise ValueError("API execution omitted collected tests (selection filters cannot satisfy the gate): " + ", ".join(sorted(expected[key] for key in missing)))
    if sum(int(suite.get("tests", "-1")) for suite in suites) != len(cases):
        raise ValueError("JUnit suite count does not match the executed API cases")
    return len(cases)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--collection", type=Path, required=True)
    parser.add_argument("--junit", type=Path, required=True)
    parser.add_argument("--files", nargs="*", default=[])
    args = parser.parse_args(argv)
    try:
        count = validate_execution(json.loads(args.collection.read_text(encoding="utf-8")), args.junit.read_text(encoding="utf-8"), args.files)
        print(f"API execution receipt passed: {count} expected tests actually passed; no skips")
        return 0
    except (OSError, ValueError, TypeError, ET.ParseError) as error:
        print(f"API execution receipt failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
