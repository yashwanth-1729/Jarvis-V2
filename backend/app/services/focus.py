"""Serious mode: tasks and schedule blocks the user commits to, and how that is going.

Added 2026-10-02 at the user's request: "a separate mode where we make the
tasks serious and some schedule blocks serious ... click started ... then
click completed after finishing it, or in some types of tasks it directly
completes", plus stats on how many were completed without skipping.

- An item is a task or a block marked serious, in one of two modes:
  `session` (Start, then Done) or `quick` (Done in one tap).
- Every Start/Done is an event. Stats come from events plus the items'
  own timing: a block occurrence that ended, or a task deadline that passed,
  with no Done is a skip. Skips are computed, never stored, so editing an
  item's time re-evaluates the past correctly.
- Items keep a snapshot of their timing (the client sends it when marking
  and refreshes it when opening the screen) because on Android the record
  tables in this database are only a working copy seeded around agent turns.
- Local to the device like reminders: never synced, never seeded over.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any

from app.core.timeutil import clock_to_minutes, now, now_iso, parse_datetime
from app.db import database

MODES = ("session", "quick")
KINDS = ("task", "block")
ASSUMED_MINUTES = 60
#: Tasks have one occurrence for their whole life; blocks have one per day.
TASK_OCCURRENCE = "once"

ItemFields = dict[str, Any]


def _today() -> str:
    return now().date().isoformat()


async def list_items() -> list[dict[str, Any]]:
    return await database.db.fetch_all("SELECT * FROM focus_items ORDER BY created_at")


async def get_item(uid: str) -> dict[str, Any] | None:
    return await database.db.fetch_one("SELECT * FROM focus_items WHERE uid = ?", (uid,))


async def upsert_item(uid: str, fields: ItemFields) -> dict[str, Any]:
    """Mark something serious, or refresh its snapshot. Keeps `created_at`."""
    stamp = now_iso()
    columns = ("kind", "mode", "title", "block_kind", "day_of_week", "start_time",
               "end_time", "time_start", "time_end", "due_date")
    values = [fields.get(column) for column in columns]
    if await get_item(uid):
        await database.db.execute(
            f"UPDATE focus_items SET {', '.join(f'{c} = ?' for c in columns)}, updated_at = ? WHERE uid = ?",
            (*values, stamp, uid),
        )
    else:
        await database.db.execute(
            f"INSERT INTO focus_items (uid, {', '.join(columns)}, created_at, updated_at) "
            f"VALUES (?, {', '.join('?' for _ in columns)}, ?, ?)",
            (uid, *values, stamp, stamp),
        )
    item = await get_item(uid)
    assert item is not None
    return item


async def remove_item(uid: str) -> bool:
    """Not serious any more. Its past events stay, so history keeps its wins."""
    return bool(await database.db.execute_count("DELETE FROM focus_items WHERE uid = ?", (uid,)))


def _occurrence_key(item: dict[str, Any], occurrence: str | None) -> str:
    if item["kind"] == "task":
        return TASK_OCCURRENCE
    return occurrence or _today()


async def _event(uid: str, occurrence: str, status: str) -> dict[str, Any] | None:
    return await database.db.fetch_one(
        "SELECT * FROM focus_events WHERE item_uid = ? AND occurrence = ? AND status = ? ORDER BY id DESC LIMIT 1",
        (uid, occurrence, status),
    )


async def start(uid: str, occurrence: str | None = None) -> dict[str, Any] | None:
    """Begin a session. Idempotent: a running or finished one is returned as is."""
    item = await get_item(uid)
    if item is None:
        return None
    key = _occurrence_key(item, occurrence)
    existing = await _event(uid, key, "running") or await _event(uid, key, "done")
    if existing:
        return existing
    event_id = await database.db.execute(
        "INSERT INTO focus_events (item_uid, title, occurrence, status, started_at) VALUES (?, ?, ?, 'running', ?)",
        (uid, item["title"], key, now_iso()),
    )
    return await database.db.fetch_one("SELECT * FROM focus_events WHERE id = ?", (event_id,))


async def finish(uid: str, occurrence: str | None = None) -> dict[str, Any] | None:
    """Done: closes a running session (recording its minutes) or, for a
    one-tap item, records the completion directly."""
    item = await get_item(uid)
    if item is None:
        return None
    key = _occurrence_key(item, occurrence)
    done = await _event(uid, key, "done")
    if done:
        return done
    stamp = now_iso()
    running = await _event(uid, key, "running")
    if running:
        started = parse_datetime(running["started_at"])
        minutes = round((now() - started).total_seconds() / 60, 1) if started else None
        await database.db.execute(
            "UPDATE focus_events SET status = 'done', finished_at = ?, minutes = ? WHERE id = ?",
            (stamp, minutes, running["id"]),
        )
        return await database.db.fetch_one("SELECT * FROM focus_events WHERE id = ?", (running["id"],))
    event_id = await database.db.execute(
        "INSERT INTO focus_events (item_uid, title, occurrence, status, finished_at) VALUES (?, ?, ?, 'done', ?)",
        (uid, item["title"], key, stamp),
    )
    return await database.db.fetch_one("SELECT * FROM focus_events WHERE id = ?", (event_id,))


async def reset(uid: str, occurrence: str | None = None) -> int:
    """Take back a Start or a Done tapped by mistake."""
    item = await get_item(uid)
    key = _occurrence_key(item, occurrence) if item else (occurrence or _today())
    return await database.db.execute_count(
        "DELETE FROM focus_events WHERE item_uid = ? AND occurrence = ?", (uid, key)
    )


async def recent_events(days: int = 2) -> list[dict[str, Any]]:
    """Events the screen needs to show today's state (plus every task's)."""
    since = (now().date() - timedelta(days=days - 1)).isoformat()
    return await database.db.fetch_all(
        "SELECT * FROM focus_events WHERE occurrence >= ? OR occurrence = ? ORDER BY id",
        (since, TASK_OCCURRENCE),
    )


def block_window(item: dict[str, Any], day: date) -> tuple[datetime, datetime] | None:
    """When this block happens on `day`, or None if it does not."""
    kind = (item.get("block_kind") or "").upper()
    if kind == "SESSION":
        start = parse_datetime(item.get("time_start"))
        if start is None or start.date() != day:
            return None
        end = parse_datetime(item.get("time_end")) or start + timedelta(minutes=ASSUMED_MINUTES)
        return start, end
    if item.get("day_of_week") is None or int(item["day_of_week"]) != day.weekday():
        return None
    begin = clock_to_minutes(item.get("start_time"))
    finish_at = clock_to_minutes(item.get("end_time"))
    midnight = datetime.combine(day, datetime.min.time())
    if begin is None:
        return midnight, midnight + timedelta(days=1) - timedelta(seconds=1)
    start = midnight + timedelta(minutes=begin)
    end = midnight + timedelta(minutes=finish_at) if finish_at and finish_at > begin else start + timedelta(minutes=ASSUMED_MINUTES)
    return start, end


async def stats(days: int = 30, current: datetime | None = None) -> dict[str, Any]:
    """Everything the stats screen draws, for the last `days` days."""
    days = max(7, min(120, days))
    current = current or now()
    today = current.date()
    first = today - timedelta(days=days - 1)
    items = await list_items()
    events = await database.db.fetch_all("SELECT * FROM focus_events ORDER BY id")

    series: dict[date, dict[str, Any]] = {
        first + timedelta(days=i): {"done": 0, "skipped": 0, "minutes": 0.0} for i in range(days)
    }
    per_item: dict[str, dict[str, Any]] = {}
    done_keys: set[tuple[str, str]] = set()
    running: dict[str, Any] | None = None

    for event in events:
        if event["status"] == "running":
            running = event
            continue
        if event["status"] != "done":
            continue
        done_keys.add((event["item_uid"], event["occurrence"]))
        when = parse_datetime(event["finished_at"])
        if when is None or when.date() not in series:
            continue
        bucket = series[when.date()]
        bucket["done"] += 1
        bucket["minutes"] += float(event["minutes"] or 0)
        stat = per_item.setdefault(event["item_uid"], {"uid": event["item_uid"], "title": event["title"], "done": 0, "skipped": 0})
        stat["done"] += 1

    pending_today = 0
    for item in items:
        created = parse_datetime(item["created_at"]) or current
        stat = per_item.setdefault(item["uid"], {"uid": item["uid"], "title": item["title"], "done": 0, "skipped": 0})
        stat["title"] = item["title"]
        if item["kind"] == "task":
            if (item["uid"], TASK_OCCURRENCE) in done_keys:
                continue
            due = parse_datetime(item.get("due_date"))
            if due and due <= current and due >= created and due.date() in series:
                series[due.date()]["skipped"] += 1
                stat["skipped"] += 1
            elif due is None or due > current:
                pending_today += 1 if (due is None or due.date() == today) else 0
            continue
        day = max(first, created.date())
        while day <= today:
            window = block_window(item, day)
            if window and window[0] >= created and (item["uid"], day.isoformat()) not in done_keys:
                is_running = bool(running and running["item_uid"] == item["uid"] and running["occurrence"] == day.isoformat())
                if window[1] <= current and not is_running:
                    series[day]["skipped"] += 1
                    stat["skipped"] += 1
                elif day == today:
                    pending_today += 1
            day += timedelta(days=1)

    ordered = [{**series[first + timedelta(days=i)], "date": (first + timedelta(days=i)).isoformat()} for i in range(days)]
    done_total = sum(day["done"] for day in ordered)
    skipped_total = sum(day["skipped"] for day in ordered)

    # A streak counts clean days (something done, nothing skipped). Days
    # with nothing serious on them neither extend nor break it.
    streak = 0
    for day in reversed(ordered):
        if day["skipped"]:
            break
        if day["done"]:
            streak += 1
    best = run = 0
    for day in ordered:
        if day["skipped"]:
            run = 0
        elif day["done"]:
            run += 1
            best = max(best, run)

    return {
        "days": days,
        "done": done_total,
        "skipped": skipped_total,
        "rate": round(done_total / (done_total + skipped_total), 3) if done_total + skipped_total else None,
        "minutes": round(sum(day["minutes"] for day in ordered)),
        "streak": streak,
        "best_streak": best,
        "perfect_days": sum(1 for day in ordered if day["done"] and not day["skipped"]),
        "today": {**{k: ordered[-1][k] for k in ("done", "skipped")}, "pending": pending_today},
        "series": ordered,
        # Only items with a record yet: a freshly marked block is not a row of zeros.
        "items": sorted(
            (stat for stat in per_item.values() if stat["done"] or stat["skipped"]),
            key=lambda s: (-s["done"], s["skipped"], s["title"]),
        )[:12],
        "running": running,
    }


def _planned_minutes(item: dict[str, Any] | None, occurrence: str) -> float:
    """A one-tap block's planned length on its day (0 for tasks or untimed blocks)."""
    if not item or item["kind"] != "block":
        return 0.0
    try:
        day = date.fromisoformat(occurrence)
    except ValueError:
        return 0.0
    window = block_window(item, day)
    if not window or not (item.get("start_time") or (item.get("block_kind") or "").upper() == "SESSION"):
        return 0.0
    return min(240.0, (window[1] - window[0]).total_seconds() / 60)


async def week(current: datetime | None = None) -> dict[str, Any]:
    """The honest number (2026-10-04): time locked in and how much of the plan
    was kept, this week (Monday to now) against last week.

    Time is what Start -> Stop measured; a one-tap block that was done counts
    its planned length, since it was done and that is the time it took. A
    one-tap task counts as kept but adds no time. `last.to_date` is last week
    up to this same moment, so the comparison is fair on a Tuesday.
    """
    current = current or now()
    today = current.date()
    this_monday = today - timedelta(days=today.weekday())
    last_monday = this_monday - timedelta(days=7)
    same_point = current - timedelta(days=7)
    items = {item["uid"]: item for item in await list_items()}
    rows = await database.db.fetch_all(
        "SELECT * FROM focus_events WHERE status = 'done' AND finished_at >= ?", (last_monday.isoformat(),)
    )
    minutes = {"this": 0.0, "last": 0.0, "last_to_date": 0.0}
    for row in rows:
        finished = parse_datetime(row["finished_at"])
        if finished is None or finished > current:
            continue
        spent = float(row["minutes"] or 0) or _planned_minutes(items.get(row["item_uid"]), row["occurrence"])
        if finished.date() >= this_monday:
            minutes["this"] += spent
        else:
            minutes["last"] += spent
            if finished <= same_point:
                minutes["last_to_date"] += spent

    daily = await stats(14, current=current)
    this_week = [d for d in daily["series"] if d["date"] >= this_monday.isoformat()]
    last_week = [d for d in daily["series"] if last_monday.isoformat() <= d["date"] < this_monday.isoformat()]

    def tally(days: list[dict[str, Any]], spent: float) -> dict[str, Any]:
        done = sum(d["done"] for d in days)
        skipped = sum(d["skipped"] for d in days)
        return {
            "minutes": round(spent),
            "done": done,
            "skipped": skipped,
            "kept": round(done / (done + skipped), 3) if done + skipped else None,
        }

    this = tally(this_week, minutes["this"])
    last = tally(last_week, minutes["last"])
    last["to_date"] = round(minutes["last_to_date"])
    return {
        "week_of": this_monday.isoformat(),
        "this": this,
        "last": last,
        "today": daily["today"],
        "streak": daily["streak"],
        "items": len(items),
    }
