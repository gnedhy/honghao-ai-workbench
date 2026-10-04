from __future__ import annotations

import argparse
import ast
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

CONTRACT = "scripts/regression-contract.json"
NODEID = r"tests/[^\s]+\.py::(?:Test\w+::)*test_\w+(?:\[[^\r\n]*\])?"
BOOTSTRAP_REVISION = "1c57482eb41f48f5acd6fcd36395d38e84086948"
BOOTSTRAP_API_SHA256 = "684ce4c85568d7876e37f1ed033fd68aade28d7befc2cd173668a5d7ff25d036"


def protected_ids(contract: dict) -> set[str]:
    if not isinstance(contract, dict) or contract.get("schema") != 1:
        raise ValueError("Unsupported regression contract schema")
    ids = contract.get("api_nodeids")
    if not isinstance(ids, list) or not ids:
        raise ValueError("API protection list must not be empty")
    if any(not isinstance(item, str) or not re.fullmatch(NODEID, item) or ".." in item.split("::", 1)[0].split("/") for item in ids):
        raise ValueError("Invalid API nodeid")
    if len(ids) != len(set(ids)):
        raise ValueError("Duplicate protected API nodeid")
    return set(ids)


def validate_collection(contract: dict, nodeids: list[str], baseline: int) -> None:
    protected = protected_ids(contract)
    if baseline < 1 or baseline < len(protected):
        raise ValueError("Count baseline cannot be lower than the protected API inventory")
    if not nodeids or len(nodeids) != len(set(nodeids)):
        raise ValueError("Collection is empty or contains duplicate nodeids")
    if len(nodeids) < baseline:
        raise ValueError(f"Test count decreased: {len(nodeids)} < {baseline}")
    missing = protected - set(nodeids)
    if missing:
        raise ValueError("Protected API tests not collected: " + ", ".join(sorted(missing)))


def validate_base(contract: dict, previous: dict, baseline: int, previous_baseline: int) -> None:
    current, old = protected_ids(contract), protected_ids(previous)
    if baseline < previous_baseline:
        raise ValueError("API count baseline decreased relative to base")
    retirements = contract.get("retirements", [])
    if not isinstance(retirements, list):
        raise ValueError("Invalid retirement records")
    seen = set()
    for row in retirements:
        if not isinstance(row, dict) or not isinstance(row.get("asset"), dict):
            raise ValueError("Invalid retirement asset")
        asset = row.get("asset", {})
        if asset.get("kind") != "api":
            continue
        retired = asset.get("id")
        if retired in seen:
            raise ValueError("Duplicate API retirement")
        seen.add(retired)
        replacements = row.get("replacements")
        if not isinstance(row.get("reason"), str) or len(row["reason"].strip()) < 10:
            raise ValueError("Retirement needs a concrete review reason (at least 10 characters)")
        if not isinstance(retired, str) or retired in current or not isinstance(replacements, list) or not replacements or any(not isinstance(item, dict) for item in replacements):
            raise ValueError("Retirement must remove its old ID and declare replacements")
        replacement_ids = [item.get("id") for item in replacements if item.get("kind") == "api"]
        if len(replacement_ids) != len(replacements) or len(set(replacement_ids)) != len(replacement_ids) or not set(replacement_ids) <= current:
            raise ValueError("API retirement replacement is invalid or unprotected")
        historical = {r.get("asset", {}).get("id") for r in previous.get("retirements", []) if r.get("asset", {}).get("kind") == "api"}
        if retired not in old and retired not in historical:
            raise ValueError("API retirement does not refer to a base asset")
    if (old - current) - seen:
        raise ValueError("API protection removed without retirement: " + ", ".join(sorted((old - current) - seen)))


def read_git(root: Path, ref: str, file: str) -> str:
    result = subprocess.run(["git", "show", f"{ref}:{file}"], cwd=root, capture_output=True, text=True, encoding="utf-8", check=False)
    if result.returncode:
        raise ValueError(f"Cannot read base asset {file} at {ref}")
    return result.stdout


def validate_bootstrap(revision: str, previous_baseline: int, contract: dict) -> None:
    # Only the one introduction base predates the inventory. Keep this anchor fixed.
    inventory = json.dumps(sorted(protected_ids(contract)), ensure_ascii=False, separators=(",", ":")).encode()
    if revision != BOOTSTRAP_REVISION or previous_baseline != 140 or hashlib.sha256(inventory).hexdigest() != BOOTSTRAP_API_SHA256:
        raise ValueError("Missing base inventory is permitted only for the pinned initial 500-test bootstrap")


def validate_test_source(file: str, text: str) -> None:
    tree = ast.parse(text, filename=file)
    aliases = {"pytest": "pytest", "unittest": "unittest"}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for item in node.names:
                if item.name in {"pytest", "unittest"}:
                    aliases[item.asname or item.name] = item.name
        elif isinstance(node, ast.ImportFrom) and node.module in {"pytest", "unittest"}:
            for item in node.names:
                aliases[item.asname or item.name] = f"{node.module}.{item.name}"

    def symbol(node: ast.AST) -> str:
        if isinstance(node, ast.Name):
            return aliases.get(node.id, node.id)
        if isinstance(node, ast.Attribute):
            return f"{symbol(node.value)}.{node.attr}"
        return ""

    forbidden = {"pytest.skip", "pytest.xfail", "unittest.skip", "unittest.skipIf", "unittest.skipUnless", "unittest.expectedFailure"}
    forbidden.update(f"pytest.mark.{name}" for name in ("skip", "skipif", "xfail"))
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and symbol(node.func) in forbidden:
            raise ValueError(f"{file}:{node.lineno}: disabled tests cannot protect regressions ({symbol(node.func)})")
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            for decorator in node.decorator_list:
                if symbol(decorator) in forbidden:
                    raise ValueError(f"{file}:{decorator.lineno}: disabled test decorator cannot protect regressions")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Protect collected API regression assets and count floor")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--base-ref", help="Trusted merge base; reject weakened protection")
    parser.add_argument("--output", type=Path, help="Write current collected nodeids for other gates")
    args = parser.parse_args(argv)
    root = args.root.resolve()
    try:
        baseline = int((root / "test-count-baseline.txt").read_text(encoding="ascii").strip())
        contract = json.loads((root / CONTRACT).read_text(encoding="utf-8"))
        protected_ids(contract)
        if args.base_ref:
            previous_baseline = int(read_git(root, args.base_ref, "test-count-baseline.txt").strip())
            try:
                previous_text = read_git(root, args.base_ref, CONTRACT)
            except ValueError:
                resolved = subprocess.run(["git", "rev-parse", "--verify", f"{args.base_ref}^{{commit}}"], cwd=root, capture_output=True, text=True, encoding="utf-8", check=False)
                validate_bootstrap(resolved.stdout.strip() if resolved.returncode == 0 else "", previous_baseline, contract)
                print(f"API regression inventory bootstrap: pinned base {BOOTSTRAP_REVISION}; 500 reviewed IDs frozen")
                previous = contract
            else:
                previous = json.loads(previous_text)
            validate_base(contract, previous, baseline, previous_baseline)
        else:
            validate_base(contract, contract, baseline, baseline)
        for file in sorted((root / "tests").rglob("*.py")):
            validate_test_source(file.relative_to(root).as_posix(), file.read_text(encoding="utf-8-sig"))
        result = subprocess.run(
            [sys.executable, "-m", "pytest", "-o", "addopts=", "--collect-only", "-q"],
            cwd=root, capture_output=True, text=True, encoding="utf-8", errors="replace", check=False,
        )
        if result.returncode:
            raise ValueError(f"Unable to collect tests (pytest exit {result.returncode}):\n{result.stdout}\n{result.stderr}")
        nodeids = [line.strip() for line in result.stdout.splitlines() if re.fullmatch(NODEID, line.strip())]
        count = re.search(r"(?:^|\n)(\d+) tests? collected", result.stdout)
        if count is None or int(count.group(1)) != len(nodeids):
            raise ValueError("Collection summary and nodeid inventory disagree")
        validate_collection(contract, nodeids, baseline)
        if args.output:
            output = args.output.resolve()
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps({"schema": 1, "count": len(nodeids), "nodeids": nodeids}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"API regression gate passed: {len(nodeids)} collected >= {baseline}; {len(protected_ids(contract))} protected IDs present")
        return 0
    except (OSError, ValueError, TypeError, KeyError, SyntaxError) as error:
        print(f"API regression gate failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
