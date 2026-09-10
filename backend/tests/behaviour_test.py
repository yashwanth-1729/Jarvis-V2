"""Live checks for the specific failures the user reported in real use.

Each case below reproduces something that actually went wrong in a session, so
a regression here is a regression in the product, not in an abstraction:

1. "delete all my tasks" was answered one task at a time, and kept re-asking
   after the user said to stop asking.
2. "what's my Monday schedule" was answered "I don't have that", while the
   data sat in the database.
3. Asked about tasks, the reply mixed in schedules and rules.
4. Telugu replies read times and counts in Telugu instead of English.

Runs against a COPY of the real database, because case 1 deletes everything.

    .venv/Scripts/python.exe tests/behaviour_test.py
"""

from __future__ import annotations

import asyncio
import io
import os
import sqlite3
import sys
import tempfile
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

# Point the app at a throwaway copy *before* app.core.config is imported.
LIVE_DB = BACKEND / "storage" / "jarvis_memory.db"
TMP_DB = Path(tempfile.gettempdir()) / "jarvis_behaviour_test.db"
for suffix in ("", "-wal", "-shm"):
    target = Path(str(TMP_DB) + suffix)
    if target.exists():
        target.unlink()
if LIVE_DB.exists():
    source = sqlite3.connect(LIVE_DB)
    source.execute("VACUUM INTO ?", (str(TMP_DB),))
    source.close()
os.environ["JARVIS_DB_PATH"] = str(TMP_DB)

failures: list[str] = []


def check(label: str, condition: bool, detail: str = "") -> None:
    print(f"  [{'PASS' if condition else 'FAIL'}] {label}" + (f"  -> {detail}" if detail else ""))
    if not condition:
        failures.append(label)


async def turn(text: str, *, voice: bool = True, language: str | None = None):
    """Run one agent turn and collect the reply plus the tools it used."""
    from app.llm.agent import run_turn

    reply: list[str] = []
    tools: list[str] = []
    async for event in run_turn(text, voice=voice, language=language):
        if event["type"] == "text":
            reply.append(event["data"]["text"])
        elif event["type"] == "tool_use":
            tools.append(event["data"]["name"])
        elif event["type"] == "error":
            print("    ! error:", event["data"]["message"][:200])
    return "".join(reply).strip(), tools


async def main() -> int:
    from app.core.config import settings
    from app.db import crud
    from app.db.database import db

    print(f"\n== setup ==\n  db -> {settings.db_file}")
    check("running against the throwaway copy", settings.db_file == TMP_DB)
    await db.connect()
    await crud.clear_chat_history()

    groups = await crud.grouped_schedules()
    print(
        f"  seeded: college={len(groups['COLLEGE'])} "
        f"routine={len(groups['ROUTINE'])} session={len(groups['SESSION'])}"
    )

    # ---------------------------------------------------------------- case 2
    # The exact complaint: "మరి మండే షెడ్యూల్ చెప్పు అన్నప్పుడు వాటిలో నుంచే
    # చెప్పాలి నువ్వు. నా దగ్గర లేదు అని చెప్పకూడదు."
    print("\n== case 2: answers the Monday schedule from stored data ==")
    reply, tools = await turn("What is my Monday schedule?", language="en-IN")
    print("   ->", reply[:400])
    lowered = reply.lower()
    check(
        "does not claim the data is missing",
        not any(
            phrase in lowered
            for phrase in ("don't have", "do not have", "no monday", "nothing saved", "not available")
        ),
        reply[:120],
    )
    check(
        "names something real from Monday",
        any(word in lowered for word in ("django", "japanese", "dinner", "drawing", "diary", "project")),
        reply[:120],
    )

    # ---------------------------------------------------------------- case 3
    print("\n== case 3: asked about tasks, answers about tasks only ==")
    await crud.clear_chat_history()
    reply, tools = await turn("What tasks do I have right now?", language="en-IN")
    print("   ->", reply[:400])
    check(
        "does not read the timetable back as tasks",
        not any(word in reply.lower() for word in ("timetable", "c410", "lecture", "practical")),
        reply[:120],
    )

    # ---------------------------------------------------------------- case 4
    print("\n== case 4: Telugu keeps times and numbers in English ==")
    await crud.clear_chat_history()
    reply, _ = await turn("ఈ రోజు నా schedule చెప్పు", language="te-IN")
    print("   ->", reply[:400])
    telugu_digits = set("౦౧౨౩౪౫౬౭౮౯")
    check("no Telugu numerals in the reply", not (telugu_digits & set(reply)), reply[:120])

    from app.services.speech import prepare

    spoken = prepare(reply, "te-IN")
    check(
        "no bare digits survive into the spoken text",
        not any(char.isdigit() for char in spoken),
        spoken[:160],
    )

    # ---------------------------------------------------------------- case 1
    # Run last: it empties the task board.
    print("\n== case 1: 'delete all my tasks' is ONE question ==")
    await crud.clear_chat_history()
    for title in ("Alpha task", "Beta task", "Gamma task", "Delta task"):
        await crud.create_task(title, None, "MEDIUM", "TEST")
    before = len(await crud.list_tasks())

    reply, tools = await turn("Delete all my tasks.", language="en-IN")
    print("   ->", reply[:300])
    print("   tools:", tools)
    check("reaches for the bulk tool", "bulk_delete_tasks" in tools, str(tools))
    check(
        "does not loop single deletes",
        tools.count("delete_record") == 0,
        f"delete_record x{tools.count('delete_record')}",
    )
    check("nothing deleted before confirming", len(await crud.list_tasks()) == before)

    reply, tools = await turn("Yes, delete them all. Don't ask me one by one.", language="en-IN")
    print("   ->", reply[:300])
    print("   tools:", tools)
    remaining = len(await crud.list_tasks())
    check("the whole board goes on one confirmation", remaining == 0, f"{remaining} left")

    # -------------------------------------------------------------- speech
    print("\n== speech: pace and voice reach the vendor ==")
    from app.services import speech

    rendered = await speech.speak("Your Java class is at 7:30 PM.", language_code="te-IN")
    check("Telugu synthesis returns audio", len(rendered.audio) > 2000, f"{len(rendered.audio)} bytes")
    rendered_en = await speech.speak("Your Java class is at 7:30 PM.", language_code="en-IN")
    check("English synthesis returns audio", len(rendered_en.audio) > 2000, f"{len(rendered_en.audio)} bytes")

    await db.disconnect()

    print("\n" + "=" * 60)
    if failures:
        print(f"FAILED ({len(failures)}):")
        for label in failures:
            print("  -", label)
        return 1
    print("ALL BEHAVIOUR CHECKS PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
