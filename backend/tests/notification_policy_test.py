"""Focused notification-policy checks using an isolated SQLite database."""

from __future__ import annotations

import asyncio
import os
import sys
import tempfile
from datetime import timedelta
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

SCRATCH = Path(tempfile.gettempdir()) / "jarvis_notification_policy_test.db"
for suffix in ("", "-wal", "-shm"):
    Path(str(SCRATCH) + suffix).unlink(missing_ok=True)
os.environ["JARVIS_DB_PATH"] = str(SCRATCH)

from app.core.config import get_settings  # noqa: E402

get_settings.cache_clear()
import app.db.database as dbmod  # noqa: E402

dbmod.db = dbmod.Database(get_settings().db_file, 2)
import app.db.crud as crud  # noqa: E402

crud.db = dbmod.db
from app.core.timeutil import now, to_iso  # noqa: E402
from app.llm.tools import execute_tool  # noqa: E402
from app.services import notification_policy  # noqa: E402


async def main() -> None:
    await dbmod.db.connect()
    try:
        default = await notification_policy.load()
        assert default["enabled"] and default["deadline_tasks"]
        assert not any(default[key] for key in ("college", "routine", "blocks", "reminders"))

        result = await execute_tool("configure_notifications", {
            "enabled": True,
            "deadline_tasks": False,
            "college": False,
            "routine": False,
            "blocks": True,
            "reminders": False,
        })
        assert not result.is_error
        only_blocks = await notification_policy.load()
        assert only_blocks["blocks"] and not only_blocks["deadline_tasks"]

        task = await crud.create_task(
            title="Submit prototype", due_date=to_iso(now() + timedelta(hours=2))
        )
        result = await execute_tool("configure_notifications", {
            "specific_action": "notify",
            "record_type": "task",
            "matching": "Submit prototype",
        })
        assert not result.is_error
        selected = await notification_policy.load()
        task_ref = f"task:{task['uid']}"
        assert notification_policy.permits(selected, task_ref, "deadline_tasks")

        await execute_tool("configure_notifications", {
            "specific_action": "mute",
            "record_type": "task",
            "matching": "Submit prototype",
        })
        muted = await notification_policy.load()
        assert not notification_policy.permits(muted, task_ref, "deadline_tasks")

        await execute_tool("configure_notifications", {"enabled": False})
        off = await notification_policy.load()
        assert not notification_policy.permits(off, "schedule:any", "blocks")

        reminder = await execute_tool("set_reminder", {
            "text": "Check the build",
            "remind_at": to_iso(now() + timedelta(hours=1)),
            "time_expression": "in one hour",
        })
        assert not reminder.is_error
        explicit = await notification_policy.load()
        reminder_ref = f"reminder:{reminder.display['id']}"
        assert explicit["enabled"]
        assert notification_policy.permits(explicit, reminder_ref, "reminders")
    finally:
        await dbmod.db.disconnect()


asyncio.run(main())
print("notification policy: 7 checks passed")
