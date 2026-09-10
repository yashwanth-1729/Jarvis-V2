"""Sync correctness, exercised end to end without touching the network.

The engine talks to a `FakeRemote` here rather than Supabase. That is not just
frugality about API credits — an in-memory remote lets a test *reorder* events
(edit after delete, stale row arriving late) which is exactly where sync goes
wrong and exactly what is impossible to stage reliably against a live server.

The live probe is a separate opt-in run:

    .venv/Scripts/python.exe tests/sync_test.py           # offline, always safe
    .venv/Scripts/python.exe tests/sync_test.py --live    # one real round trip
"""

from __future__ import annotations

import asyncio
import io
import os
import sys
import tempfile
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Sequence

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

TMP_DB = Path(tempfile.gettempdir()) / "jarvis_sync_test.db"
for suffix in ("", "-wal", "-shm"):
    target = Path(str(TMP_DB) + suffix)
    if target.exists():
        target.unlink()
os.environ["JARVIS_DB_PATH"] = str(TMP_DB)

from app.db import crud                      # noqa: E402
from app.db.database import db               # noqa: E402
from app.services import sync                # noqa: E402

#: Fixed base for the fake server clock, so runs are reproducible.
_FAKE_EPOCH = datetime(2026, 1, 1, 0, 0, 0)

PASSED = 0
FAILED = 0


def check(label: str, condition: bool, detail: str = "") -> None:
    global PASSED, FAILED
    if condition:
        PASSED += 1
        print(f"  PASS  {label}")
    else:
        FAILED += 1
        print(f"  FAIL  {label}{('  -> ' + detail) if detail else ''}")


class FakeRemote:
    """An in-memory stand-in for the Supabase mirror.

    Mimics the two behaviours the engine actually depends on: upsert-on-primary
    key, and a server-assigned `synced_at` that advances on every write. The
    counter is zero-padded so lexicographic comparison orders it correctly,
    matching how a real timestamp cursor behaves.
    """

    def __init__(self) -> None:
        self.rows: dict[str, dict[str, dict[str, Any]]] = defaultdict(dict)
        self.tombstones: dict[tuple[str, str], dict[str, Any]] = {}
        self._clock = 0
        self.closed = False

    def _stamp(self) -> str:
        """A server stamp shaped like the real one.

        ISO timestamps rather than a bare counter, because the pull cursor is
        rewound by a real time delta before each fetch. A counter would silently
        skip that code path and leave the overlap window untested. The counter
        is kept as a microsecond offset purely to guarantee monotonicity.
        """
        self._clock += 1
        return (_FAKE_EPOCH + timedelta(microseconds=self._clock)).isoformat()

    def commit_late(self, table: str, uid: str, seconds_earlier: float) -> None:
        """Backdate a row's `synced_at`, as a slow transaction does.

        Postgres stamps `now()` at transaction *start*, and transactions do not
        commit in start order. A write that began earlier can become visible
        after one that began later -- so a cursor already past it would step
        over the row and never return. This stages exactly that.
        """
        row = self.rows[table][uid]
        moment = datetime.fromisoformat(row["synced_at"]) - timedelta(seconds=seconds_earlier)
        row["synced_at"] = moment.isoformat()

    @staticmethod
    def _after(items: list[dict[str, Any]], since: str | None):
        fresh = [r for r in items if since is None or r["synced_at"] > since]
        fresh.sort(key=lambda r: r["synced_at"])
        cursor = fresh[-1]["synced_at"] if fresh else since
        return fresh, cursor

    async def fetch_rows(self, table: str, since: str | None):
        return self._after(list(self.rows[table].values()), since)

    async def fetch_tombstones(self, since: str | None):
        return self._after(list(self.tombstones.values()), since)

    async def push_rows(self, table: str, rows: Sequence[dict[str, Any]]) -> None:
        for row in rows:
            existing = self.rows[table].get(row["uid"])
            # Mirrors the keep_newer_write() trigger on the real mirror: a
            # device that has been offline must not overwrite a newer row with
            # its stale copy. Without this the fake would be more permissive
            # than production and the tests would pass on a lie.
            if existing and row["updated_at"] <= existing["updated_at"]:
                continue
            self.rows[table][row["uid"]] = {**row, "synced_at": self._stamp()}

    async def push_tombstones(self, rows: Sequence[dict[str, Any]]) -> None:
        for row in rows:
            key = (row["table_name"], row["uid"])
            self.tombstones[key] = {**row, "synced_at": self._stamp()}

    async def close(self) -> None:
        self.closed = True

    # -- helpers used by the tests, not part of the adapter protocol --------

    def seed(self, table: str, row: dict[str, Any]) -> None:
        """Write a row directly, bypassing the last-write-wins guard.

        Deliberately more permissive than `push_rows`: it stages states the real
        server would refuse, so the *client's* own guard can be tested on its
        own rather than hiding behind the server's.
        """
        self.rows[table][row["uid"]] = {**row, "synced_at": self._stamp()}

    def seed_tombstone(self, table: str, uid: str, deleted_at: str) -> None:
        self.tombstones[(table, uid)] = {
            "table_name": table,
            "uid": uid,
            "deleted_at": deleted_at,
            "synced_at": self._stamp(),
        }


async def become_other_device() -> None:
    """Wipe local rows and sync watermarks, keeping the remote intact.

    Standing in for a second machine: same code, same schema, no local state
    and nothing pulled yet.
    """
    for table in sync.SYNCED_TABLES:
        await db.execute(f"DELETE FROM {table}")
    await db.execute("DELETE FROM sync_tombstones")
    await db.execute("DELETE FROM sync_state")
    await db.execute("DELETE FROM sync_pending")


async def main(live: bool = False) -> int:
    await db.connect()

    # -- identity ---------------------------------------------------------
    print("\n== every new row gets a sync identity ==")
    task = await crud.create_task("Finish the sync engine", priority="HIGH")
    idea = await crud.create_idea("Publish SLDT", description="after testing")
    event = await crud.create_schedule_event(
        "DSA revision", kind="ROUTINE", day_of_week=2, start_time="19:30"
    )
    memory = await crud.upsert_memory("preferred editor", "Neovim", category="PREFERENCE")

    check("task has a uid", bool(task.get("uid")), repr(task.get("uid")))
    check("idea has a uid", bool(idea.get("uid")))
    check("schedule has a uid", bool(event and event.get("uid")))
    check("memory has a uid", bool(memory.get("uid")))
    check(
        "schedule carries updated_at",
        bool(event and event.get("updated_at")),
        repr(event.get("updated_at") if event else None),
    )
    check(
        "uids are distinct",
        len({task["uid"], idea["uid"], event["uid"], memory["uid"]}) == 4,
    )

    # -- push -------------------------------------------------------------
    print("\n== push publishes local work ==")
    remote = FakeRemote()
    result = await sync.sync_once(remote)
    check("push reported no error", result.error is None, str(result.error))
    check("task reached the remote", task["uid"] in remote.rows["tasks"])
    check("schedule reached the remote", event["uid"] in remote.rows["schedules"])
    check("memory reached the remote", memory["uid"] in remote.rows["memories"])
    check("idea reached the remote", idea["uid"] in remote.rows["ideas"])
    check(
        "local id did not travel",
        "id" not in remote.rows["tasks"][task["uid"]],
        "the integer id is device-local and must not sync",
    )

    # -- pull -------------------------------------------------------------
    print("\n== another device pulls the same state ==")
    await become_other_device()
    check("second device starts empty", not await crud.list_tasks())

    result = await sync.sync_once(remote)
    check("pull reported no error", result.error is None, str(result.error))
    tasks = await crud.list_tasks()
    check("task arrived", any(t["uid"] == task["uid"] for t in tasks), str(tasks))
    check(
        "title survived the round trip",
        any(t["title"] == "Finish the sync engine" for t in tasks),
    )
    check("schedule arrived", len(await crud.list_schedules()) == 1)
    check("memory arrived", len(await crud.list_memories()) == 1)

    # -- idempotence ------------------------------------------------------
    print("\n== syncing twice changes nothing ==")
    before = len(await crud.list_tasks())
    await sync.sync_once(remote)
    check("no duplicate rows", len(await crud.list_tasks()) == before)

    # -- conflicts --------------------------------------------------------
    print("\n== last write wins, and only when it really is later ==")
    local = (await crud.list_tasks())[0]
    await crud.update_task(local["id"], title="Edited locally, later")
    edited = await crud.get_task(local["id"])

    stale = dict(remote.rows["tasks"][task["uid"]])
    stale["title"] = "Stale remote edit"
    stale["updated_at"] = "2020-01-01T00:00:00"
    remote.seed("tasks", stale)

    await sync.sync_once(remote)
    now_local = await crud.get_task(local["id"])
    check(
        "older remote edit does not clobber a newer local one",
        now_local["title"] == "Edited locally, later",
        f"got {now_local['title']!r}",
    )

    fresher = dict(remote.rows["tasks"][task["uid"]])
    fresher["title"] = "Newer remote edit"
    fresher["updated_at"] = "2099-01-01T00:00:00"
    remote.seed("tasks", fresher)
    await sync.sync_once(remote)
    check(
        "newer remote edit does land",
        (await crud.get_task(local["id"]))["title"] == "Newer remote edit",
    )

    # -- deletes ----------------------------------------------------------
    print("\n== deletes propagate instead of resurrecting ==")
    doomed = await crud.create_task("Delete me")
    await sync.sync_once(remote)
    check("doomed task published", doomed["uid"] in remote.rows["tasks"])

    await crud.delete_task(doomed["id"])
    tombstones = await db.fetch_all("SELECT * FROM sync_tombstones")
    check(
        "delete recorded a tombstone",
        any(t["uid"] == doomed["uid"] for t in tombstones),
        str(tombstones),
    )

    await sync.sync_once(remote)
    check(
        "tombstone published",
        ("tasks", doomed["uid"]) in remote.tombstones,
    )

    await become_other_device()
    await sync.sync_once(remote)
    surviving = {t["uid"] for t in await crud.list_tasks()}
    check(
        "deleted task does not come back on the other device",
        doomed["uid"] not in surviving,
        f"still present in {surviving}",
    )
    check("the other tasks did survive", task["uid"] in surviving)

    # -- completing a task is a delete ------------------------------------
    print("\n== completing a task tombstones it too ==")
    finished = await crud.create_task("Ship it")
    await sync.sync_once(remote)
    await crud.update_task_status(finished["id"], "COMPLETED")
    stones = await db.fetch_all(
        "SELECT * FROM sync_tombstones WHERE uid = ?", (finished["uid"],)
    )
    check(
        "completion left a tombstone",
        bool(stones),
        "otherwise a finished task returns on the next pull",
    )

    # -- a local edit beats a stale tombstone ------------------------------
    print("\n== a row edited after its delete is kept ==")
    revived = await crud.create_task("Brought back")
    remote.seed_tombstone("tasks", revived["uid"], "2020-01-01T00:00:00")
    await sync.sync_once(remote)
    check(
        "stale tombstone does not delete a newer row",
        await crud.get_task(revived["id"]) is not None,
    )

    # -- a future timestamp must not strand later writes -------------------
    print("\n== a clock-skewed row does not freeze the push watermark ==")
    # Stands in for a second device running fast: it writes a row stamped in
    # the future, and this device pulls it. If the watermark were allowed to
    # follow that stamp, every subsequent local edit would fall below it and
    # never push again -- silently, with no error anywhere.
    skewed = await crud.create_task("Written by a fast clock")
    await db.execute(
        "UPDATE tasks SET updated_at = ? WHERE id = ?",
        ("2099-06-01T00:00:00", skewed["id"]),
    )
    await sync.sync_once(remote)

    after_skew = await crud.create_task("Written afterwards, normal clock")
    await sync.sync_once(remote)
    check(
        "a normally-stamped row still reaches the remote",
        after_skew["uid"] in remote.rows["tasks"],
        "the future-dated row dragged the watermark past the clock",
    )

    # -- backward clock skew ----------------------------------------------
    print("\n== a clock moving backwards still publishes ==")
    backdated = await crud.create_task("Written before the clock was corrected")
    await sync.sync_once(remote)
    # An ordinary NTP correction: the next edit lands with an *earlier* stamp
    # than one already sent. A high-water-mark cursor would sort it below the
    # mark and never send it again -- the failure the pending set exists to
    # remove. Whether the server then accepts it is a separate question
    # (last-write-wins says no); what matters here is that it was queued.
    await db.execute(
        "UPDATE tasks SET title = ?, updated_at = ? WHERE id = ?",
        ("Edited after the correction", "2020-02-02T02:02:02", backdated["id"]),
    )
    result = await sync.sync_once(remote)
    check(
        "an edit stamped in the past is still queued and sent",
        result.pushed.get("tasks", 0) > 0,
        "a timestamp watermark would have sorted it below the mark and skipped it",
    )

    # -- identical timestamps ----------------------------------------------
    print("\n== rows sharing one timestamp all publish ==")
    twin_a = await crud.create_task("Same second, first")
    twin_b = await crud.create_task("Same second, second")
    await db.execute(
        "UPDATE tasks SET updated_at = ? WHERE id IN (?, ?)",
        ("2027-03-03T03:03:03", twin_a["id"], twin_b["id"]),
    )
    await sync.sync_once(remote)
    check(
        "neither row is lost to a timestamp collision",
        twin_a["uid"] in remote.rows["tasks"] and twin_b["uid"] in remote.rows["tasks"],
    )

    # -- out-of-order commits ----------------------------------------------
    print("\n== a late-committing row is not stepped over ==")
    await become_other_device()
    await sync.sync_once(remote)  # cursor advances to the newest synced_at
    remote.seed(
        "tasks",
        {
            "uid": "late-commit-0001",
            "title": "Began early, committed late",
            "category": "GENERAL",
            "priority": "MEDIUM",
            "status": "PENDING",
            "due_date": None,
            "created_at": "2026-05-05T05:05:05",
            "updated_at": "2026-05-05T05:05:05",
        },
    )
    # Stamped *behind* the cursor the last pull already reached, exactly as a
    # slow Postgres transaction appears. Only the overlap window finds it.
    remote.commit_late("tasks", "late-commit-0001", seconds_earlier=2)
    await sync.sync_once(remote)
    check(
        "a row stamped behind the cursor is still pulled",
        await db.fetch_value(
            "SELECT COUNT(*) FROM tasks WHERE uid = 'late-commit-0001'", default=0
        ) == 1,
        "the overlap window did not cover the commit-order gap",
    )

    # -- concurrent writes --------------------------------------------------
    print("\n== two devices editing one row converge ==")
    contended = await crud.create_task("Contended")
    await sync.sync_once(remote)
    # The other device edits and publishes first, with the later stamp.
    remote.seed(
        "tasks",
        {**remote.rows["tasks"][contended["uid"]], "title": "Device B",
         "updated_at": "2030-01-01T00:00:00"},
    )
    # This device edits too, but its stamp is older.
    await db.execute(
        "UPDATE tasks SET title = ?, updated_at = ? WHERE id = ?",
        ("Device A", "2029-01-01T00:00:00", contended["id"]),
    )
    await sync.sync_once(remote)
    settled_local = (await crud.get_task(contended["id"]))["title"]
    settled_remote = remote.rows["tasks"][contended["uid"]]["title"]
    check(
        "both sides settle on the same version",
        settled_local == settled_remote == "Device B",
        f"local={settled_local!r} remote={settled_remote!r}",
    )

    # -- offline, then reconnect -------------------------------------------
    print("\n== edits made offline publish on reconnect ==")

    class OfflineRemote:
        """Every call fails, as an unreachable server does."""

        async def fetch_rows(self, *_: Any):
            raise RuntimeError("offline")

        async def fetch_tombstones(self, *_: Any):
            raise RuntimeError("offline")

        async def push_rows(self, *_: Any):
            raise RuntimeError("offline")

        async def push_tombstones(self, *_: Any):
            raise RuntimeError("offline")

        async def close(self) -> None:
            pass

    on_the_train = await crud.create_task("Written on a train")
    outcome = await sync.sync_once(OfflineRemote())
    check("an unreachable remote is reported, not raised", outcome.error is not None)
    check(
        "the edit is still queued after the failure",
        await db.fetch_value(
            "SELECT COUNT(*) FROM sync_pending WHERE uid = ?", (on_the_train["uid"],), default=0
        ) == 1,
    )
    await sync.sync_once(remote)
    check(
        "it publishes once the connection returns",
        on_the_train["uid"] in remote.rows["tasks"],
    )

    # -- unconfigured -----------------------------------------------------
    print("\n== sync stays out of the way when unconfigured ==")
    from app.core.config import settings

    saved = (settings.supabase_url, settings.supabase_service_key)
    settings.supabase_url, settings.supabase_service_key = "", ""
    idle = await sync.sync_once()
    settings.supabase_url, settings.supabase_service_key = saved
    check("skipped rather than raised", idle.skipped is not None, str(idle))
    check("reported no error", idle.error is None, str(idle.error))
    check("summary reads cleanly", "skipped" in idle.summary(), idle.summary())

    # -- optional live probe ----------------------------------------------
    if live:
        print("\n== live Supabase round trip ==")
        adapter = sync.build_adapter()
        if adapter is None:
            check("credentials present", False, "set SUPABASE_URL / SUPABASE_SERVICE_KEY")
        else:
            outcome = await sync.sync_once(adapter)
            check("live sync succeeded", outcome.error is None, str(outcome.error))
            print(f"        {outcome.summary()}")
            await adapter.close()

    await db.disconnect()

    print(f"\n{PASSED} passed, {FAILED} failed")
    return 1 if FAILED else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main(live="--live" in sys.argv)))
