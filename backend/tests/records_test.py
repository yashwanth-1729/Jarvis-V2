"""Editing the boards by hand, not by asking.

Everything on screen used to be read-only unless you talked to JARVIS about it,
which is fine for "add a task to call the dentist" and absurd for fixing a typo.
These endpoints close that gap.

The thing worth testing is not that a PATCH writes a field — it is that a hand
edit and an agent edit mean the *same thing*. Both go through `crud`, so
completing a task must clear it from either direction, a delete must leave a
tombstone from either direction, and a partial update must not blank the fields
it did not mention. The last one is the easy bug: `exclude_unset` is the only
thing standing between "rename this task" and "rename this task and silently
erase its deadline, priority and category".

    .venv/Scripts/python.exe tests/records_test.py
"""

from __future__ import annotations

import io
import os
import sys
import tempfile
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

SCRATCH = Path(tempfile.gettempdir()) / "jarvis_records_test.db"
for suffix in ("", "-wal", "-shm"):
    Path(str(SCRATCH) + suffix).unlink(missing_ok=True)
os.environ["JARVIS_DB_PATH"] = str(SCRATCH)
# The scheduler would otherwise tick underneath these assertions.
os.environ["JARVIS_SCHEDULER_ENABLED"] = "false"

from fastapi.testclient import TestClient  # noqa: E402

import main  # noqa: E402

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


with TestClient(main.app) as client:
    print("== tasks ==")
    made = client.post(
        "/api/tasks",
        json={"title": "Renew the domain", "priority": "HIGH", "category": "finance",
              "due_date": "2026-09-01T10:00:00"},
    )
    check("create -> 201", made.status_code == 201, made.text[:120])
    task = made.json()
    check("  ...stores the title", task["title"] == "Renew the domain")
    check("  ...coerces the category", task["category"] == "FINANCE", task["category"])

    renamed = client.patch(f"/api/tasks/{task['id']}", json={"title": "Renew the domain name"})
    check("partial update -> 200", renamed.status_code == 200, renamed.text[:120])
    body = renamed.json()
    check("  ...renames", body["title"] == "Renew the domain name")
    # The bug this exists to catch: a rename must not blank everything else.
    check("  ...KEEPS the priority", body["priority"] == "HIGH", body["priority"])
    check("  ...KEEPS the due date", body["due_date"] is not None, body["due_date"])
    check("  ...KEEPS the category", body["category"] == "FINANCE", body["category"])

    cleared = client.patch(f"/api/tasks/{task['id']}", json={"clear_due_date": True})
    check("clear_due_date removes the deadline", cleared.json()["due_date"] is None)
    check("  ...and changes nothing else", cleared.json()["title"] == "Renew the domain name")

    moved = client.patch(f"/api/tasks/{task['id']}", json={"status": "IN_PROGRESS"})
    check("status can be set directly", moved.json()["status"] == "IN_PROGRESS")

    # Completing clears the board, exactly as the tool does. The endpoint must
    # say so rather than return a row that no longer exists.
    done = client.patch(f"/api/tasks/{task['id']}", json={"status": "COMPLETED"})
    check("completing reports the row is gone", done.status_code == 409, done.status_code)
    check("  ...and says why", "cleared off the board" in done.text, done.text[:120])
    check("  ...and it really is gone",
          client.patch(f"/api/tasks/{task['id']}", json={"title": "x"}).status_code == 404)

    doomed = client.post("/api/tasks", json={"title": "delete me"}).json()
    check("delete -> 204", client.delete(f"/api/tasks/{doomed['id']}").status_code == 204)
    check("  ...twice is 404", client.delete(f"/api/tasks/{doomed['id']}").status_code == 404)
    check("blank title rejected", client.post("/api/tasks", json={"title": ""}).status_code == 422)

    print("\n== schedule ==")
    weekly = client.post(
        "/api/schedule",
        json={"event_name": "Java class", "kind": "COLLEGE", "day_of_week": 0,
              "start_time": "19:30", "end_time": "21:00", "location": "C410"},
    )
    check("create weekly -> 201", weekly.status_code == 201, weekly.text[:140])
    event = weekly.json()
    check("  ...keeps the day", event["day_of_week"] == 0, event.get("day_of_week"))
    check("  ...keeps the time", event["start_time"] == "19:30", event.get("start_time"))

    edited = client.patch(f"/api/schedule/{event['id']}", json={"location": "C411"})
    check("partial update -> 200", edited.status_code == 200, edited.text[:120])
    check("  ...moves the room", edited.json()["location"] == "C411")
    check("  ...KEEPS the time", edited.json()["start_time"] == "19:30")
    check("  ...KEEPS the name", edited.json()["event_name"] == "Java class")

    one_off = client.post(
        "/api/schedule",
        json={"event_name": "Dentist", "kind": "SESSION", "time_start": "2026-09-02T09:00:00"},
    )
    check("create one-off -> 201", one_off.status_code == 201, one_off.text[:140])

    check("delete -> 204", client.delete(f"/api/schedule/{event['id']}").status_code == 204)
    check("  ...twice is 404", client.delete(f"/api/schedule/{event['id']}").status_code == 404)
    check("bad weekday rejected",
          client.post("/api/schedule", json={"event_name": "x", "day_of_week": 9}).status_code == 422)

    print("\n== ideas ==")
    idea = client.post(
        "/api/ideas", json={"title": "CLI reading tracker", "description": "tiny TUI", "tags": "side"}
    )
    check("create -> 201", idea.status_code == 201, idea.text[:120])
    made_idea = idea.json()
    bumped = client.patch(f"/api/ideas/{made_idea['id']}", json={"status": "ACTIVE"})
    check("status change -> 200", bumped.status_code == 200, bumped.text[:120])
    check("  ...applies", bumped.json()["status"] == "ACTIVE")
    check("  ...KEEPS the description", bumped.json()["description"] == "tiny TUI")
    check("delete -> 204", client.delete(f"/api/ideas/{made_idea['id']}").status_code == 204)
    check("  ...twice is 404", client.delete(f"/api/ideas/{made_idea['id']}").status_code == 404)

    print("\n== memories ==")
    mem = client.post(
        "/api/memories",
        json={"key_concept": "Meeting preference", "content": "Prefers mornings.",
              "category": "PREFERENCE"},
    )
    check("create -> 201", mem.status_code == 201, mem.text[:120])
    made_mem = mem.json()
    check("  ...category kept", made_mem["category"] == "PREFERENCE")

    # Saving the same concept corrects it rather than leaving two rows for the
    # model to choose between.
    again = client.post(
        "/api/memories",
        json={"key_concept": "Meeting preference", "content": "Prefers afternoons.",
              "category": "PREFERENCE"},
    )
    check("same concept upserts", again.json()["id"] == made_mem["id"], again.json())
    check("  ...with the new content", again.json()["content"] == "Prefers afternoons.")

    # Renaming a memory must edit the row, not create a second one — which is
    # exactly what upsert-by-concept would have done.
    renamed_mem = client.patch(
        f"/api/memories/{made_mem['id']}", json={"key_concept": "Meeting times"}
    )
    check("rename -> 200", renamed_mem.status_code == 200, renamed_mem.text[:120])
    check("  ...same row", renamed_mem.json()["id"] == made_mem["id"])
    check("  ...KEEPS the content", renamed_mem.json()["content"] == "Prefers afternoons.")
    listed = client.get("/api/dashboard").json()["memories"]
    check("  ...and did not leave a duplicate behind",
          sum(1 for m in listed if m["key_concept"] in ("Meeting preference", "Meeting times")) == 1,
          [m["key_concept"] for m in listed])

    check("delete -> 204", client.delete(f"/api/memories/{made_mem['id']}").status_code == 204)
    check("  ...twice is 404", client.delete(f"/api/memories/{made_mem['id']}").status_code == 404)

    print("\n== hand edits and agent edits agree ==")
    # A deletion by hand must leave a tombstone, or the next sync pull restores
    # what the user just removed.
    victim = client.post("/api/tasks", json={"title": "tombstone probe"}).json()
    client.delete(f"/api/tasks/{victim['id']}")
    stones = client.get("/api/dashboard")  # forces a round trip; read the table directly below
    check("dashboard still serves", stones.status_code == 200)

import asyncio  # noqa: E402

import app.db.database as dbmod  # noqa: E402


async def _tombstones() -> int:
    await dbmod.db.connect()
    try:
        row = await dbmod.db.fetch_one(
            "SELECT COUNT(*) AS n FROM sync_tombstones WHERE table_name = 'tasks'"
        )
        return int(row["n"]) if row else 0
    finally:
        await dbmod.db.disconnect()


count = asyncio.run(_tombstones())
check("deleting by hand leaves a tombstone", count > 0, count)

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
