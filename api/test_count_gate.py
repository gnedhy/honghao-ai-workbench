from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Reject accidental test-count regressions")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent)
    args = parser.parse_args(argv)
    root = args.root.resolve()
    baseline = int((root / "test-count-baseline.txt").read_text(encoding="ascii").strip())
    result = subprocess.run(
        [sys.executable, "-m", "pytest", "--collect-only"],
        cwd=root,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    match = re.search(r"(\d+) tests? collected", f"{result.stdout}\n{result.stderr}")
    if result.returncode != 0 or match is None:
        print("Unable to collect tests", file=sys.stderr)
        return 1
    current = int(match.group(1))
    if current < baseline:
        print(f"Test count decreased: {current} < {baseline}", file=sys.stderr)
        return 1
    print(f"Test count gate passed: {current} >= {baseline}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
