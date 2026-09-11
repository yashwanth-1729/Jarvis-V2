"""Reminders default to notifying early, not just at the exact time.

Covers the behaviour `reminder_time_test.py` does not: `_handle_set_reminder`
now creates one row for an "instant reminder" and TWO for a default one (an
early notice plus the exact time), and `_reminder_announcement_text` composes
the right fire-time message for each. Runs against a throwaway database in the
system temp directory; never calls a live provider.

    .venv/Scripts/python.exe tests/reminder_lead_test.py
"""

from __future__ import annotations

import io
import os
import sys
import tempfile
from datetime import timedelta
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_ROOT))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

TMP_DB = Path(tempfile.gettempdir()) / "jarvis_reminder_lead_test.db"
for suffix in ("", "-wal", "-shm"):
    stale = Path(str(TMP_DB) + suffix)
    if stale.exists():
        stale.unlink()

os.environ["JARVIS_DB_PATH"] = str(TMP_DB)
os.environ["JARVIS_SCHEDULER_ENABLED"] = "false"
os.environ.setdefault("ANTHROPIC_API_KEY", "sk-ant-reminder-lead-test-not-real")

failures: list[str] = []
passed = 0


def check(label: str, condition: bool, detail: str = "") -> None:
    global passed
    print(f"  [{'PASS' if condition else 'FAIL'}] {label}" + (f" — {detail}" if detail else ""))
    if condition:
        passed += 1
    else:
        failures.append(label)


async def main() -> int:
    from app.core.timeutil import now, to_iso
    from app.db import crud
    from app.db.database import db
    from app.llm.tools import REMINDER_LEAD_MINUTES, execute_tool
    from app.services.scheduler import _reminder_announcement_text

    await db.connect()

    async def pending() -> list[dict]:
        return await crud.list_reminders(include_fired=False, limit=50)

    # ------------------------------------------------------------- default
    print("\n== a default reminder notifies 15 minutes early too ==")
    target = now() + timedelta(hours=2)
    result = await execute_tool(
        "set_reminder",
        {"text": "class starts", "remind_at": to_iso(target), "time_expression": "in 2 hours"},
    )
    check("tool did not error", not result.is_error, result.content)
    check("confirmation mentions the early notice", "early" in result.content.lower(), result.content)

    rows = await pending()
    check("two rows were created", len(rows) == 2, f"{len(rows)} rows")
    early = next((r for r in rows if r["target_at"] is not None), None)
    exact = next((r for r in rows if r["target_at"] is None), None)
    check("one early row and one exact row exist", early is not None and exact is not None)
    if early and exact:
        check("early row's target_at is the real target", early["target_at"] == to_iso(target))
        check("exact row's due_at is the real target", exact["due_at"] == to_iso(target))
        lead_delta = target - timedelta(minutes=REMINDER_LEAD_MINUTES)
        check(
            "early row fires REMINDER_LEAD_MINUTES before the target",
            early["due_at"] == to_iso(lead_delta),
            f"expected {to_iso(lead_delta)}, got {early['due_at']}",
        )
        check(
            "fire-time message frames the early row as a lead notice",
            _reminder_announcement_text(early).startswith(f"In {REMINDER_LEAD_MINUTES} minutes, at "),
            _reminder_announcement_text(early),
        )
        check(
            "fire-time message for the exact row is the plain text",
            _reminder_announcement_text(exact) == "class starts",
        )
    for row in rows:
        await crud.mark_reminder_fired(row["id"])

    # -------------------------------------------------------------- instant
    print("\n== instant=true creates only the exact-time row ==")
    target2 = now() + timedelta(hours=1)
    result = await execute_tool(
        "set_reminder",
        {
            "text": "call back",
            "remind_at": to_iso(target2),
            "time_expression": "in an hour",
            "instant": True,
        },
    )
    check("tool did not error", not result.is_error, result.content)
    check("confirmation has no early-notice note", "early" not in result.content.lower(), result.content)
    rows2 = await pending()
    check("exactly one row was created", len(rows2) == 1, f"{len(rows2)} rows")
    if rows2:
        check("its due_at is the exact target", rows2[0]["due_at"] == to_iso(target2))
        check("it carries no target_at", rows2[0]["target_at"] is None)
        check(
            "its fire-time message is the plain text",
            _reminder_announcement_text(rows2[0]) == "call back",
        )
    for row in rows2:
        await crud.mark_reminder_fired(row["id"])

    # --------------------------------------------------- clamped lead time
    print("\n== a target too soon for the full lead time is clamped, not refused ==")
    target3 = now() + timedelta(minutes=5)
    result = await execute_tool(
        "set_reminder",
        {"text": "leave now", "remind_at": to_iso(target3), "time_expression": "in 5 minutes"},
    )
    check("tool did not error", not result.is_error, result.content)
    rows3 = await pending()
    check("still two rows (some lead beats none)", len(rows3) == 2, f"{len(rows3)} rows")
    early3 = next((r for r in rows3 if r["target_at"] is not None), None)
    if early3:
        # Clamped to "now" rather than going negative or being refused.
        actual_lead = round((target3 - now()).total_seconds() / 60)
        check(
            "confirmation reports the true (clamped) lead, not a hardcoded 15",
            f"{actual_lead} minute" in result.content or f"{max(actual_lead - 1, 0)} minute" in result.content,
            result.content,
        )
    for row in rows3:
        await crud.mark_reminder_fired(row["id"])

    # --------------------------------------------- no lead time available
    print("\n== a target under a minute away skips the redundant early row ==")
    target4 = now() + timedelta(seconds=20)
    result = await execute_tool(
        "set_reminder",
        {"text": "right now", "remind_at": to_iso(target4), "time_expression": "in 20 seconds"},
    )
    check("tool did not error", not result.is_error, result.content)
    rows4 = await pending()
    check(
        "only one row -- a same-instant 'early' row would be a duplicate",
        len(rows4) == 1,
        f"{len(rows4)} rows",
    )
    for row in rows4:
        await crud.mark_reminder_fired(row["id"])

    # ------------------------------------------------------- past is still refused
    print("\n== a past time is still refused, instant or not ==")
    past = now() - timedelta(minutes=5)
    result = await execute_tool(
        "set_reminder",
        {"text": "too late", "remind_at": to_iso(past), "time_expression": "5 minutes ago", "instant": True},
    )
    check("past instant reminder is refused", result.is_error, result.content)
    check("nothing was created", not await pending())

    await db.disconnect()

    print("\n" + "=" * 60)
    if failures:
        print(f"FAILED ({len(failures)}):")
        for label in failures:
            print(f"  - {label}")
        return 1
    print(f"{passed} checks passed")
    return 0


if __name__ == "__main__":
    import asyncio

    sys.exit(asyncio.run(main()))
