"""Cancelling an agent-owned command must cancel its process tree too.

Runs one harmless child Python process in a temporary directory, waits until it
has recorded its own PID, then cancels ``run_command``. The public coroutine
must propagate ``CancelledError`` only after the child has been reaped. No live
provider, user database or user file is involved.

    .venv/Scripts/python.exe tests/command_cancellation_test.py
"""

from __future__ import annotations

import asyncio
import io
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_ROOT))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")


def pid_is_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


async def main() -> int:
    from app.llm.tools_system import run_command

    work = Path(tempfile.mkdtemp(prefix="jarvis_command_cancellation_test_"))
    pid_file = work / "child.pid"
    child_script = work / "child.py"
    child_script.write_text(
        "import os, pathlib, time; "
        f"pathlib.Path({str(pid_file)!r}).write_text(str(os.getpid()), encoding='utf-8'); "
        "time.sleep(30)",
        encoding="utf-8",
    )
    command = f'"{sys.executable}" "{child_script}"'
    task = asyncio.create_task(run_command(command, timeout=60))

    deadline = time.monotonic() + 8
    while not pid_file.exists() and time.monotonic() < deadline:
        await asyncio.sleep(0.05)

    checks: list[tuple[str, bool, str]] = []
    checks.append(("child started and recorded a PID", pid_file.exists(), str(pid_file)))
    child_pid = int(pid_file.read_text(encoding="utf-8")) if pid_file.exists() else None

    task.cancel()
    cancelled = False
    try:
        await task
    except asyncio.CancelledError:
        cancelled = True
    checks.append(("parent cancellation propagates to caller", cancelled, ""))

    if child_pid is not None:
        deadline = time.monotonic() + 5
        while pid_is_alive(child_pid) and time.monotonic() < deadline:
            await asyncio.sleep(0.05)
        checks.append(("owned child is gone after cancellation", not pid_is_alive(child_pid), str(child_pid)))

    shutil.rmtree(work, ignore_errors=True)
    for label, passed, detail in checks:
        print(f"  [{'PASS' if passed else 'FAIL'}] {label}" + (f" — {detail}" if detail else ""))
    print("\n" + "=" * 60)
    print(f"{sum(passed for _, passed, _ in checks)}/{len(checks)} checks passed")
    return 0 if all(passed for _, passed, _ in checks) else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
