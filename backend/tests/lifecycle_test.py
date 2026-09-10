"""Schedule/temporary-memory lifecycle checks against an isolated database."""
from __future__ import annotations

import asyncio
import os
import sys
import tempfile
from datetime import date, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
path = Path(tempfile.gettempdir()) / "jarvis_lifecycle_test.db"
for suffix in ("", "-wal", "-shm"):
    Path(str(path) + suffix).unlink(missing_ok=True)
os.environ["JARVIS_DB_PATH"] = str(path)

from app.db import crud  # noqa: E402
from app.db.database import db  # noqa: E402

passed = failed = 0
def check(label: str, okay: bool) -> None:
    global passed, failed
    print(("PASS " if okay else "FAIL ") + label)
    passed += int(okay); failed += int(not okay)

async def main() -> None:
    await db.connect()
    try:
        routine = await crud.create_schedule_event("Study", "ROUTINE", day_of_week=0, start_time="18:00", end_time="23:00")
        block = await crud.create_schedule_event("Summit", "SESSION", time_start="2099-09-14T20:00:00", time_end="2099-09-14T21:00:00")
        agenda = await crud.schedule_for_day(date(2099, 9, 14))
        check("Block cuts its hour from routine", [x["event_name"] for x in agenda] == ["Study", "Summit", "Study"])
        check("agenda is nearest first", [x["time_start"] for x in agenda] == sorted(x["time_start"] for x in agenda))
        conflicts = await crud.all_schedule_conflicts()
        check("routine override is not flagged as overlap", not any({a["id"], b["id"]} == {routine["id"], block["id"]} for a, b in conflicts))
        removed = await crud.expire_sessions(datetime(2099, 9, 14, 21, 0, 1))
        check("finished Block expires", removed == 1 and await crud.get_schedule_event(block["id"]) is None)
        tomb = await db.fetch_one("SELECT * FROM sync_tombstones WHERE table_name='schedules' AND uid=?", (block["uid"],))
        check("expired Block leaves deletion identity", tomb is not None)

        memory = await crud.upsert_memory("Monday rule", "Follow it", expires_at="2099-09-18T00:00:00")
        check("temporary rule exists before deadline", await crud.get_memory(memory["id"]) is not None)
        await crud.expire_memories(datetime(2099, 9, 18, 0, 0, 0))
        check("temporary rule content is erased at deadline", await crud.get_memory(memory["id"]) is None)
        page = await crud.save_note_page(None, "Startup ideas")
        renamed = await crud.save_note_page(page["uid"], "Product ideas")
        check("renaming page keeps identity", renamed["uid"] == page["uid"] and len(await crud.list_note_pages()) == 1)
        normalized = await crud.upsert_memory("Legacy category", "Kept", "PRIVATE")
        check("private category is no longer created", normalized["category"] == "LONG_TERM")
    finally:
        await db.disconnect()

asyncio.run(main())
print(f"{passed} passed, {failed} failed")
raise SystemExit(1 if failed else 0)
