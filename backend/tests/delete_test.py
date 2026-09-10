"""Deleting a record the user *named*, not one the model guessed.

A spoken request never contains a database id. Asked to "delete the verify sync
bridge task", the model invented `record_id=14`, got a rejection, listed the
tasks, and only then deleted the right one -- three model round trips where one
would do, and on a voice turn each round trip is a second or two of silence.

So `delete_record` takes a title. These tests pin the behaviour that makes that
safe: one clear match proceeds, several matches ask, none returns the real list,
and a bogus id answers with the catalogue instead of a bare refusal.

    .venv/Scripts/python.exe tests/delete_test.py
"""

from __future__ import annotations

import asyncio
import io
import os
import shutil
import sys
import tempfile
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

# A copy, so a failing assertion can never eat real data. Seeded from the live
# database rather than an empty one, because "does it cope with the rows that
# actually exist" is half of what is being tested.
SOURCE_DB = BACKEND / "storage" / "jarvis_memory.db"
SCRATCH_DB = Path(tempfile.gettempdir()) / "jarvis_delete_test.db"
if SCRATCH_DB.exists():
    SCRATCH_DB.unlink()
if SOURCE_DB.exists():
    shutil.copy(SOURCE_DB, SCRATCH_DB)
os.environ["JARVIS_DB_PATH"] = str(SCRATCH_DB)

from app.core.config import get_settings  # noqa: E402

get_settings.cache_clear()
import app.core.config as cfg  # noqa: E402

cfg.settings = get_settings()

import app.db.database as dbmod  # noqa: E402

dbmod.db = dbmod.Database(cfg.settings.db_file, 5)
import app.db.crud as crud  # noqa: E402

crud.db = dbmod.db
import app.llm.tools as tools  # noqa: E402

tools.crud = crud

from app.llm.tools import DeleteRecordInput, _handle_delete_record  # noqa: E402

#: Prefix chosen so no real row can collide with the fixtures. An earlier draft
#: used "verify sync bridge" verbatim and failed against a database that already
#: had one -- the test was measuring the fixture, not the code.
P = "zzq"

passed = 0
failed = 0


def check(label: str, ok: bool, detail: object = "") -> None:
    global passed, failed
    if ok:
        passed += 1
        print(f"  PASS  {label}")
    else:
        failed += 1
        print(f"  FAIL  {label}  {detail}")


async def main() -> None:
    await dbmod.db.connect()
    try:
        task = await crud.create_task(
            title=f"{P} sync bridge", category="work", priority="high"
        )
        await crud.create_task(title=f"{P} backup job", category="work", priority="low")

        # The exact turn that cost three round trips on the phone.
        out = await _handle_delete_record(
            DeleteRecordInput(record_type="task", title=f"{P} sync bridge")
        )
        check("title resolves in ONE call", "CONFIRMATION REQUIRED" in out.content, out.content[:90])
        check("  ...names the right task", f"{P} sync bridge" in out.content, out.content[:90])
        check("  ...deletes nothing yet", await crud.get_task(task["id"]) is not None)

        out = await _handle_delete_record(
            DeleteRecordInput(record_type="task", title=f"{P.upper()} SYNC BRIDGE")
        )
        check("case-insensitive, as spoken", "CONFIRMATION REQUIRED" in out.content, out.content[:90])

        # Ambiguity must ask. Picking one and deleting it is unrecoverable.
        out = await _handle_delete_record(DeleteRecordInput(record_type="task", title=P))
        check(
            "ambiguous title asks instead of guessing",
            out.is_error and "matches 2" in out.content,
            out.content[:90],
        )
        check(
            "  ...lists the candidates",
            f"{P} sync bridge" in out.content and f"{P} backup job" in out.content,
        )

        out = await _handle_delete_record(
            DeleteRecordInput(record_type="task", title=f"{P} buy a yacht")
        )
        check(
            "unknown title returns the real list",
            out.is_error and "Current task records" in out.content,
            out.content[:90],
        )

        # The old failure mode, now self-correcting inside one turn.
        out = await _handle_delete_record(
            DeleteRecordInput(record_type="task", record_id=999_999)
        )
        check("bogus id returns the catalogue", "Current task records" in out.content, out.content[:90])
        check("  ...and steers back to title", "Prefer passing title" in out.content)

        out = await _handle_delete_record(
            DeleteRecordInput(record_type="task", title=f"{P} sync bridge", confirmed=True)
        )
        check("confirmed delete by title works", "Deleted" in out.content, out.content[:90])
        check("  ...row is really gone", await crud.get_task(task["id"]) is None)

        try:
            DeleteRecordInput(record_type="task")
            check("neither identifier is rejected", False, "no error raised")
        except Exception as exc:  # pydantic ValidationError
            check("neither identifier is rejected", "title or record_id" in str(exc), str(exc)[:70])

        memory = await crud.upsert_memory(key_concept=f"{P} throwaway", content="test row")
        out = await _handle_delete_record(
            DeleteRecordInput(record_type="memory", title=f"{P} throwaway")
        )
        check("memory resolves via key_concept", "CONFIRMATION REQUIRED" in out.content, out.content[:90])
        await crud.delete_memory(memory["id"])

        events = await crud.list_schedules()
        if events:
            out = await _handle_delete_record(
                DeleteRecordInput(record_type="event", title=events[0]["event_name"])
            )
            check(
                "event resolves via event_name",
                "CONFIRMATION REQUIRED" in out.content or "matches" in out.content,
                out.content[:90],
            )

        # The id path is still the right call once a real id is in hand.
        other = await crud.create_task(title=f"{P} id path")
        out = await _handle_delete_record(
            DeleteRecordInput(record_type="task", record_id=other["id"], confirmed=True)
        )
        check("explicit id still deletes", "Deleted" in out.content, out.content[:90])

        leftover = [r for r in await crud.list_tasks() if r["title"].startswith(P)]
        check("no stray fixtures beyond the one kept", len(leftover) == 1, [r["title"] for r in leftover])
    finally:
        await dbmod.db.disconnect()


asyncio.run(main())
print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
