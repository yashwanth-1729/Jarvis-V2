"""Run every gateway test suite, each in its own process. Offline only.

    .venv/Scripts/python.exe tests/run_all.py        (Windows)
    .venv/bin/python tests/run_all.py                (Linux / container)

Exits non-zero if any suite fails.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def main() -> int:
    suites = sorted(HERE.glob("*_test.py"))
    failed: list[str] = []
    for suite in suites:
        print(f"\n=== {suite.name} ===", flush=True)
        if subprocess.run([sys.executable, str(suite)], cwd=HERE.parent).returncode != 0:
            failed.append(suite.name)
    print(f"\n{len(suites) - len(failed)}/{len(suites)} suites passed"
          + (f"; failed: {', '.join(failed)}" if failed else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
