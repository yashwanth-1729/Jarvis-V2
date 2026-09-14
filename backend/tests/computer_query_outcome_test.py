"""Targeted computer queries must make failure visible to the agent.

No browser is launched: the fixture deliberately asks for a non-existent tab,
which used to return a successful ``ToolOutcome`` carrying an error-shaped
string. It now must return ``is_error=True``.

    .venv/Scripts/python.exe tests/computer_query_outcome_test.py
"""

from __future__ import annotations

import asyncio
import io
import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_ROOT))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")


async def main() -> int:
    from app.llm import tools
    from app.llm.tools_browser import BrowserFindInput

    outcome = await tools._handle_browser_find(  # noqa: SLF001 - boundary regression
        BrowserFindInput(tab_id="missing-fixture-tab", role="button")
    )
    checks = [
        ("missing browser tab is an error outcome", outcome.is_error),
        ("error explains that the target is missing", "tab" in outcome.content.lower()),
    ]
    for label, passed in checks:
        print(f"  [{'PASS' if passed else 'FAIL'}] {label}")
    print("\n" + "=" * 60)
    print(f"{sum(passed for _, passed in checks)}/{len(checks)} checks passed")
    return 0 if all(passed for _, passed in checks) else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
