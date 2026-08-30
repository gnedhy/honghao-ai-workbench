from __future__ import annotations

import argparse
import ast
import re
import subprocess
from collections.abc import Sequence
from pathlib import Path


_SOURCE_SUFFIXES = {".cjs", ".js", ".mjs", ".py", ".ts", ".tsx"}
_COMMAND_FILES = {"package.json", "pyproject.toml"}
_EXCLUDED_PARTS = {".git", ".uv-cache", ".venv", "dist", "node_modules"}
_ALLOWED_PUBLIC_API_PATHS = {"/api/health", "/api/login", "/api/readiness"}
_SECRET_PATTERNS = (
    re.compile(r"\b(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*['\"][^'\"]{8,}['\"]", re.IGNORECASE),
    re.compile(r"\b(?:AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9_-]{20,})\b"),
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
)
_DANGEROUS_EXECUTION_PATTERNS = (
    re.compile(r"\b(?:eval|exec)\s*\("),
    re.compile(r"\bos\.system\s*\("),
    re.compile(r"\bshell\s*=\s*True\b"),
    re.compile(r"\bdangerouslySetInnerHTML\b"),
    re.compile(r"\.innerHTML\s*="),
)
_TEST_BYPASS_PATTERNS = (
    re.compile(r"pytest\.mark\.(?:skip|skipif|xfail)"),
    re.compile(r"\bpytest\.skip\s*\("),
    re.compile(r"\b(?:describe|it|test)\.(?:skip|todo)\s*\("),
    re.compile(r"\|\|\s*true\b"),
)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m api.security_gate")
    parser.add_argument("--root", type=Path, default=Path.cwd())
    root = parser.parse_args(argv).root.resolve()
    findings: list[str] = []
    for path in _candidate_files(root):
        relative = path.relative_to(root)
        if relative.parts and (
            relative.parts[0] == ".data"
            or relative.name.startswith(".env")
            or relative.suffix.lower() in {".db", ".key", ".pem", ".sqlite", ".sqlite3"}
        ):
            findings.append(f"SEC002 {relative}：数据或凭据文件不得进入代码仓库")
            continue
        is_source = path.suffix.lower() in _SOURCE_SUFFIXES
        if (not is_source and relative.name not in _COMMAND_FILES) or any(part in _EXCLUDED_PARTS for part in relative.parts):
            continue
        try:
            content = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        is_test = relative.parts and relative.parts[0] == "tests"
        if is_source and not is_test and any(pattern.search(content) for pattern in _SECRET_PATTERNS):
            findings.append(f"SEC001 {relative}：疑似硬编码凭据")
        if is_source and not is_test and any(pattern.search(content) for pattern in _DANGEROUS_EXECUTION_PATTERNS):
            findings.append(f"SEC003 {relative}：禁止动态执行或未经净化的 HTML")
        if not is_test and path.suffix.lower() == ".py" and _has_unapproved_public_api(content):
            findings.append(f"SEC004 {relative}：发现未批准的免登录 API")
        if any(pattern.search(content) for pattern in _TEST_BYPASS_PATTERNS):
            findings.append(f"SEC005 {relative}：禁止跳过测试或掩盖命令失败")
    if findings:
        print("\n".join(findings))
        return 1
    print("安全检查通过")
    return 0


def _candidate_files(root: Path) -> list[Path]:
    try:
        result = subprocess.run(
            ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
            cwd=root,
            capture_output=True,
            check=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return [path for path in root.rglob("*") if path.is_file()]
    return [root / item.decode("utf-8") for item in result.stdout.split(b"\0") if item]


def _has_unapproved_public_api(content: str) -> bool:
    try:
        tree = ast.parse(content)
    except SyntaxError:
        return False
    for node in tree.body:
        if not isinstance(node, ast.Assign) or not any(
            isinstance(target, ast.Name) and target.id == "PUBLIC_API_PATHS"
            for target in node.targets
        ):
            continue
        try:
            paths = set(ast.literal_eval(node.value))
        except (TypeError, ValueError):
            return True
        return not paths.issubset(_ALLOWED_PUBLIC_API_PATHS)
    return False


if __name__ == "__main__":
    raise SystemExit(main())
