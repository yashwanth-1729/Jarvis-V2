"""End-to-end smoke test for the JARVIS backend.

Exercises the schema, every tool handler (including error paths), the proactive
brief generator, the context synthesizer, chat-history round-tripping and all
HTTP routes.

Runs against a throwaway database in the system temp directory and never calls
the Anthropic API, so it is safe to run at any time:

    cd backend
    .venv/Scripts/python -m pip install httpx      # test-only dependency
    .venv/Scripts/python tests/smoke_test.py

Exit code 0 = everything passed.
"""

from __future__ import annotations

import asyncio
import os
import sys
import tempfile
import traceback
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_ROOT))

TMP_DB = Path(tempfile.gettempdir()) / "jarvis_smoke_test.db"
for suffix in ("", "-wal", "-shm"):
    stale = Path(str(TMP_DB) + suffix)
    if stale.exists():
        stale.unlink()

# Must be set before app.core.config is imported.
os.environ["JARVIS_DB_PATH"] = str(TMP_DB)
# CRITICAL: this test starts the real app lifespan (TestClient runs it),
# which starts the sync loop if not disabled here. Without this, a machine
# with real Supabase credentials in backend/.env pushes this test's
# throwaway local data to the LIVE project and deletes real rows via
# tombstones -- this actually happened once. Never remove this line.
os.environ["JARVIS_SYNC_ENABLED"] = "false"

os.environ.setdefault("ANTHROPIC_API_KEY", "sk-ant-smoke-test-not-real")

failures: list[str] = []


def check(label: str, condition: bool, detail: str = "") -> None:
    print(f"  [{'PASS' if condition else 'FAIL'}] {label}" + (f" — {detail}" if detail else ""))
    if not condition:
        failures.append(label)


async def main() -> int:
    from datetime import timedelta

    from app.core.config import settings
    from app.core.languages import LANGUAGES
    from app.core.timeutil import days_from_now, now, to_iso
    from app.db import crud
    from app.db.database import db
    from app.llm.tools import OPENAI_TOOLS, TOOL_SCHEMAS, execute_tool
    from app.services import context, proactive

    print(f"\n== config ==\n  db -> {settings.db_file}")
    check("database path is the temp file", settings.db_file == TMP_DB)

    await db.connect()

    # ---------------------------------------------------------------- schema
    print("\n== schema ==")
    tables = {
        row["name"]
        for row in await db.fetch_all(
            "SELECT name FROM sqlite_master WHERE type='table'"
        )
    }
    for expected in ("tasks", "schedules", "memories", "ideas", "proactive_briefs", "chat_messages"):
        check(f"table {expected}", expected in tables)
    journal = str(await db.fetch_value("PRAGMA journal_mode")).lower()
    check("WAL journal mode", journal == "wal", journal)

    # --------------------------------------------------------- tool schemas
    print("\n== tool schemas ==")
    # The core set is the contract: fourteen tools over the user's own data,
    # available on every platform. System tools (shell and, later, files and
    # network) are counted separately because they are gated off on mobile, so
    # a bare total would fail on the phone build for the right reason and look
    # like the wrong one.
    from app.llm.tools import TOOL_REGISTRY

    core = [s for s in TOOL_REGISTRY if s.capability == "core"]
    # Bump deliberately when a core tool is added — the point of pinning it is
    # to notice, since every tool costs ~230 tokens on every single request.
    check("19 core tools registered", len(core) == 19, str(len(core)))
    check("set_reminder is one of them", any(s.name == "set_reminder" for s in core))
    check(
        "configure_notifications is one of them",
        any(s.name == "configure_notifications" for s in core),
    )

    check(
        "schema view mirrors the registry",
        len(TOOL_SCHEMAS) == len(TOOL_REGISTRY),
        f"{len(TOOL_SCHEMAS)} vs {len(TOOL_REGISTRY)}",
    )
    for spec in TOOL_SCHEMAS:
        well_formed = (
            bool(spec["name"])
            and len(spec["description"]) > 40
            and "properties" in spec["input_schema"]
        )
        check(f"schema shape: {spec['name']}", well_formed)

    check("OpenAI envelope mirrors the registry", len(OPENAI_TOOLS) == len(TOOL_SCHEMAS))
    check(
        "OpenAI tools are function-shaped",
        all(
            t["type"] == "function"
            and t["function"]["name"]
            and "parameters" in t["function"]
            for t in OPENAI_TOOLS
        ),
    )

    # ------------------------------------------------------------- providers
    print("\n== provider registry ==")
    from app.providers import get_chat_provider, get_stt_provider, get_tts_provider

    chat_p, stt_p, tts_p = get_chat_provider(), get_stt_provider(), get_tts_provider()
    check("chat provider resolves", chat_p.name == "sarvam", chat_p.name)
    check("chat model configured", bool(chat_p.model), chat_p.model)
    check("stt provider resolves", stt_p.name == "sarvam", stt_p.model)
    check("tts provider resolves", tts_p.name == "sarvam", tts_p.model)
    check("providers are cached singletons", get_chat_provider() is chat_p)

    # -------------------------------------------------------------- add_task
    print("\n== tool: add_task ==")
    created = await execute_tool(
        "add_task",
        {
            "title": "Renew the domain",
            "due_date": to_iso(now().replace(hour=10, minute=0, second=0)),
            "priority": "high",  # lowercase on purpose — must be coerced
            "category": "finance",
        },
    )
    print("   ->", created.content)
    check("add_task succeeds", not created.is_error)
    check("refreshes tasks + brief", created.refresh == {"tasks", "brief"}, str(created.refresh))
    check("undated task accepted", not (await execute_tool(
        "add_task", {"title": "Read the Anthropic docs", "priority": "LOW"}
    )).is_error)
    await crud.create_task("File the tax return", due_date=days_from_now(-2), priority="HIGH")

    # -------------------------------------------------------- error handling
    print("\n== error paths ==")
    check("blank title rejected", (await execute_tool("add_task", {"title": "   "})).is_error)
    check("unknown tool rejected", (await execute_tool("no_such_tool", {})).is_error)
    fuzzy = await execute_tool("add_task", {"title": "Fuzzy", "due_date": "next tuesday"})
    check(
        "unparseable due date degrades with a warning",
        not fuzzy.is_error and "warning" in fuzzy.content,
        fuzzy.content[:80],
    )

    # ---------------------------------------------------- add_schedule_event
    print("\n== tool: add_schedule_event ==")
    event = await execute_tool(
        "add_schedule_event",
        {
            "event_name": "Design review",
            "time_start": to_iso(now().replace(hour=14, minute=0, second=0)),
            "time_end": to_iso(now().replace(hour=15, minute=0, second=0)),
            "location": "Room 4",
        },
    )
    print("   ->", event.content)
    check("event created", not event.is_error)
    check(
        "invalid start time rejected",
        (await execute_tool("add_schedule_event", {"event_name": "X", "time_start": "soon"})).is_error,
    )

    # ----------------------------------------------------- save_idea_or_note
    print("\n== tool: save_idea_or_note ==")
    idea = await execute_tool(
        "save_idea_or_note",
        {"title": "CLI reading tracker", "content": "Track books via a tiny TUI.", "category": "side-project"},
    )
    check("idea filed to the idea board", not idea.is_error and idea.refresh == {"ideas"}, idea.content)

    memory = await execute_tool(
        "save_idea_or_note",
        {"title": "Meeting preference", "content": "Prefers morning meetings.", "category": "PREFERENCE"},
    )
    check("memory filed to long-term store", memory.refresh == {"memories"}, memory.content)

    await execute_tool(
        "save_idea_or_note",
        {"title": "meeting preference", "content": "Prefers 9-11am specifically.", "category": "PREFERENCE"},
    )
    stored = await crud.list_memories()
    check("same key updates in place, no duplicate", len(stored) == 1, f"{len(stored)} rows")
    check("memory content was updated", "9-11am" in stored[0]["content"])

    # -------------------------------------------------------- search_memory
    print("\n== tool: search_memory ==")
    check(
        "matches key_concept, case-insensitively",
        "Meeting preference" in (await execute_tool("search_memory", {"query": "MEETING"})).content,
    )
    check(
        "matches memory content",
        "Meeting preference" in (await execute_tool("search_memory", {"query": "9-11am"})).content,
    )
    check(
        "matches idea titles",
        "CLI reading tracker" in (await execute_tool("search_memory", {"query": "reading"})).content,
    )
    check(
        "matches task titles",
        "Renew the domain" in (await execute_tool("search_memory", {"query": "domain"})).content,
    )
    check(
        "no results handled cleanly",
        "No stored memories" in (await execute_tool("search_memory", {"query": "zzzz-nothing"})).content,
    )

    # --------------------------------------------------- update_task_status
    print("\n== tool: update_task_status ==")
    first_id = (await crud.list_tasks())[0]["id"]
    updated = await execute_tool("update_task_status", {"task_id": first_id, "status": "COMPLETED"})
    check("status updated", not updated.is_error, updated.content)
    # Completing is also a removal: the board holds outstanding work only.
    check("completing clears the task off the board", await crud.get_task(first_id) is None)
    check("model is told it was cleared, not asked to delete", "cleared" in updated.content)
    check(
        "missing id is a recoverable error, not an exception",
        (await execute_tool("update_task_status", {"task_id": 999_999, "status": "COMPLETED"})).is_error,
    )

    # ------------------------------------------------ get_dashboard_summary
    print("\n== tool: get_dashboard_summary ==")
    summary = await execute_tool("get_dashboard_summary", {})
    check("summary lists the task board", "TASK BOARD" in summary.content)
    check("summary separates the college timetable", "COLLEGE TIMETABLE" in summary.content)
    check("summary separates day routines", "DAY ROUTINES" in summary.content)
    check("summary separates booked sessions", "BOOKED SESSIONS" in summary.content)
    check("summary tells the model the stores are distinct", "SEPARATE store" in summary.content)

    # --------------------------------------------- generate_proactive_brief
    print("\n== tool: generate_proactive_brief ==")
    brief = await execute_tool("generate_proactive_brief", {})
    print("   ->", brief.content.replace("\n", "\n      "))
    check("brief generated", not brief.is_error)
    check("urgent items counted", brief.display["urgent_count"] >= 1, str(brief.display["urgent_count"]))
    check("at most three bullets", len(brief.display["bullets"]) <= 3)

    # ------------------------------------------------------------- services
    print("\n== services ==")
    snapshot = await context.build_context_snapshot()
    check("snapshot is tagged", "<current_state>" in snapshot)
    check("snapshot includes a task", "Renew the domain" in snapshot or "tax return" in snapshot)
    check("cached brief returns a payload", bool((await proactive.get_or_build_brief())["summary_text"]))

    # -------------------------------------------------------- chat history
    print("\n== chat history ==")
    # Payloads are stored verbatim in provider (OpenAI) message shape so a
    # restarted process can replay the exact turn structure.
    await crud.append_chat_message("user", "hello", {"role": "user", "content": "hello"})
    await crud.append_chat_message(
        "assistant", "hi", {"role": "assistant", "content": "hi"}
    )
    rows = await crud.recent_chat_messages(10)
    check("stored oldest-first", [r["role"] for r in rows] == ["user", "assistant"])
    check("payload round-trips as a message dict", isinstance(rows[0]["blocks"], dict))
    check("payload keeps its role", rows[1]["blocks"]["role"] == "assistant")

    from app.llm.agent import _trim_to_safe_boundary

    # A `tool` message whose originating `tool_calls` were trimmed away is a 400
    # from any OpenAI-compatible endpoint, so the head must be cut past it.
    trimmed = _trim_to_safe_boundary(
        [
            {"role": "tool", "tool_call_id": "call_x", "content": "orphaned"},
            {"role": "assistant", "content": "a"},
            {"role": "user", "content": "real turn"},
        ]
    )
    check(
        "orphaned tool message trimmed from the head of history",
        len(trimmed) == 1 and trimmed[0]["content"] == "real turn",
        f"{len(trimmed)} message(s) kept",
    )

    from app.llm.agent import _parse_arguments

    args, err = _parse_arguments('{"title": "x"}')
    check("tool arguments parse", args == {"title": "x"} and err is None)
    args, err = _parse_arguments("{not json")
    check("malformed arguments reported, not raised", args is None and bool(err), str(err))
    args, err = _parse_arguments("")
    check("empty arguments treated as no-args", args == {} and err is None)

    # --------------------------------------------------- edit + delete gate
    print("\n== edit and delete ==")
    edit_target = await crud.create_task("Temp task", None, "LOW", "TEST")
    r = await execute_tool(
        "update_task", {"task_id": edit_target["id"], "priority": "HIGH", "status": "IN_PROGRESS"}
    )
    row = await crud.get_task(edit_target["id"])
    check("update_task applies changes", row["priority"] == "HIGH" and row["status"] == "IN_PROGRESS")
    check("update_task leaves other fields", row["category"] == "TEST", row["category"])
    check(
        "empty update rejected",
        (await execute_tool("update_task", {"task_id": edit_target["id"]})).is_error,
    )

    gate = await execute_tool(
        "delete_record", {"record_type": "task", "record_id": edit_target["id"]}
    )
    check("delete requires confirmation", "CONFIRMATION REQUIRED" in gate.content)
    check("nothing deleted before confirming", await crud.get_task(edit_target["id"]) is not None)
    check("unconfirmed delete refreshes nothing", gate.refresh == set(), str(gate.refresh))

    done = await execute_tool(
        "delete_record",
        {"record_type": "task", "record_id": edit_target["id"], "confirmed": True},
    )
    check("confirmed delete removes the row", await crud.get_task(edit_target["id"]) is None)
    check("delete reports what went", "Temp task" in done.content, done.content[:70])

    # ------------------------------------------------------- bulk deletion
    # The user asked for a whole board to go and was interrogated task by task
    # instead; one confirmation must cover the entire set.
    print("\n== bulk delete ==")
    for title in ("Bulk A", "Bulk B", "Bulk C"):
        await crud.create_task(title, None, "LOW", "BULK")

    bulk_gate = await execute_tool("bulk_delete_tasks", {"scope": "all"})
    check("bulk delete asks once", "CONFIRMATION REQUIRED" in bulk_gate.content)
    check("bulk delete states the count", "task(s)" in bulk_gate.content)
    check(
        "bulk delete forbids one-by-one questioning",
        "one by one" in bulk_gate.content or "one at a time" in bulk_gate.content,
    )
    check("nothing removed before confirming", len(await crud.list_tasks()) >= 3)

    # Confirming now requires the count the tool quoted. See
    # tests/bulk_delete_test.py: a consent obtained for three once deleted
    # nineteen, because relaying the number was left to the model.
    before = len(await crud.list_tasks())
    naked = await execute_tool("bulk_delete_tasks", {"scope": "all", "confirmed": True})
    check("confirming without a count is refused", naked.is_error, naked.content[:80])
    check("  ...and nothing was deleted", len(await crud.list_tasks()) == before)

    wrong = await execute_tool(
        "bulk_delete_tasks", {"scope": "all", "confirmed": True, "expect_count": 1}
    )
    check("a wrong count is refused", wrong.is_error, wrong.content[:80])
    check("  ...and nothing was deleted", len(await crud.list_tasks()) == before)

    bulk_done = await execute_tool(
        "bulk_delete_tasks", {"scope": "all", "confirmed": True, "expect_count": before}
    )
    check("confirmed bulk delete clears the board", len(await crud.list_tasks()) == 0)
    check("bulk delete reports the count", "Deleted" in bulk_done.content)
    check(
        "empty board handled cleanly",
        "No " in (await execute_tool("bulk_delete_tasks", {"scope": "all"})).content,
    )
    check(
        "unknown scope rejected",
        (await execute_tool("bulk_delete_tasks", {"scope": "everything"})).is_error,
    )

    # The bulk test just emptied the board; restore a working set for the HTTP
    # route checks further down.
    await crud.create_task("Renew the domain", days_from_now(1), "HIGH", "ADMIN")
    await crud.create_task("File the tax return", days_from_now(-2), "HIGH", "FINANCE")
    await crud.create_task("Read the Anthropic docs", None, "LOW", "GENERAL")

    # ------------------------------------------------------ schedule kinds
    print("\n== schedule kinds ==")
    college = await execute_tool(
        "add_schedule_event",
        {
            "event_name": "Java Lab",
            "kind": "COLLEGE",
            "day_of_week": 0,
            "start_time": "14:00",
            "end_time": "15:30",
        },
    )
    check("college class saved", not college.is_error, college.content[:80])
    check("college kind recorded", college.display["kind"] == "COLLEGE")

    routine = await execute_tool(
        "add_schedule_event",
        {
            "event_name": "Study block",
            "kind": "ROUTINE",
            "day_of_week": 0,
            "start_time": "18:00",
            "end_time": "23:20",
        },
    )
    check("routine saved", not routine.is_error, routine.content[:80])
    check("routine did not clash with the class", "OVERLAP" not in routine.content)

    # A one-off session landing inside that Monday routine fills the block:
    # saved, and deliberately not reported as a clash (the user's choice).
    monday = now().date()
    monday += timedelta(days=(0 - monday.weekday()) % 7 or 7)
    session = await execute_tool(
        "add_schedule_event",
        {
            "event_name": "C revision",
            "kind": "SESSION",
            "time_start": f"{monday.isoformat()}T19:00:00",
            "time_end": f"{monday.isoformat()}T20:00:00",
        },
    )
    check("one-off session saved", not session.is_error, session.content[:80])
    check("session inside a routine does not warn", "OVERLAP" not in session.content, session.content[:160])
    check("session inside a routine is saved", session.display.get("id") is not None)

    # Other clashes still warn: a session on top of a college class.
    lab_clash = await execute_tool(
        "add_schedule_event",
        {
            "event_name": "Viva prep",
            "kind": "SESSION",
            "time_start": f"{monday.isoformat()}T14:30:00",
            "time_end": f"{monday.isoformat()}T15:00:00",
        },
    )
    check("session over a college class warns", "OVERLAP WARNING" in lab_clash.content, lab_clash.content[:160])
    check("clash is a warning, not a refusal", lab_clash.display.get("id") is not None)

    groups = await crud.grouped_schedules()
    check(
        "three kinds are stored separately",
        len(groups["COLLEGE"]) == 1 and len(groups["ROUTINE"]) == 1 and len(groups["SESSION"]) >= 1,
        f"college={len(groups['COLLEGE'])} routine={len(groups['ROUTINE'])} "
        f"session={len(groups['SESSION'])}",
    )
    check(
        "every stored entry carries a kind",
        all(row["kind"] in crud.SCHEDULE_KINDS for row in await crud.list_schedules()),
    )

    weekly_summary = (await execute_tool("get_dashboard_summary", {})).content
    check("weekly entries are grouped by day name", "Monday:" in weekly_summary)

    check(
        "recurring entry without a day is rejected with guidance",
        "day_of_week" in (
            await execute_tool(
                "add_schedule_event", {"event_name": "Broken", "kind": "ROUTINE"}
            )
        ).content,
    )

    # ------------------------------------------------------ speech numbers
    # Telugu TTS reads a bare numeral in Telugu, so digits are rewritten as
    # English words before synthesis.
    print("\n== spoken numbers ==")
    from app.core.speechtext import spell_numbers_in_english
    from app.services.speech import prepare

    check("clock times spelled out", spell_numbers_in_english("at 7:30 PM") == "at seven thirty PM")
    check("on-the-hour drops the minutes", spell_numbers_in_english("at 6:00 PM") == "at six PM")
    check("minutes under ten use 'oh'", spell_numbers_in_english("7:05") == "seven oh five")
    check("counts spelled out", spell_numbers_in_english("3 tasks") == "three tasks")
    check("years read naturally", spell_numbers_in_english("in 2026") == "in twenty twenty-six")
    check("ordinals handled", spell_numbers_in_english("the 21st") == "the twenty-first")
    check("text without digits is untouched", spell_numbers_in_english("no digits") == "no digits")
    check("english keeps its digits", prepare("at 7:30 PM", "en-IN") == "at 7:30 PM")
    check("telugu gets english words", "seven thirty" in prepare("7:30 PM కి", "te-IN"))

    # ---------------------------------------------------------------- voices
    print("\n== voices ==")
    from app.core.voices import VOICES, match as match_voice

    check("voice catalogue is populated", len(VOICES) >= 8, str(len(VOICES)))
    check("both genders offered", {v.gender for v in VOICES} == {"female", "male"})
    check("a spoken gender resolves", (match_voice("a girl's voice") or None) is not None)
    check("female request picks a female voice", match_voice("female").gender == "female")
    check("male request picks a male voice", match_voice("male voice").gender == "male")
    check("a name resolves", match_voice("Kavya").id == "kavya")
    check("nonsense voice rejected", match_voice("zzzz") is None)

    voice_set = await execute_tool("set_voice", {"voice": "girl"})
    check("set_voice accepts a gender", not voice_set.is_error, voice_set.content[:70])
    check(
        "voice persisted",
        bool(await crud.get_preference(crud.PREF_VOICE_SPEAKER, "")),
    )

    # --------------------------------------------------- per-language pace
    from app.core.languages import resolve as resolve_language

    check(
        "telugu speaks faster than english",
        resolve_language("te-IN").pace > resolve_language("en-IN").pace,
    )
    check(
        "pace stays short of flash speed",
        all(1.0 <= lang.pace <= 1.3 for lang in LANGUAGES),
    )

    # ------------------------------------------------- voice turn boundary
    # Regression: the tail of a reply (typically its closing line) was still
    # queued when the user asked the next question, so it played *before* the
    # new answer. Every turn now announces itself and stamps its audio, giving
    # the client a way to drop anything belonging to a superseded turn.
    print("\n== voice turn boundary ==")
    from app.api.realtime import VoiceSession

    class FakeSocket:
        def __init__(self) -> None:
            self.frames: list[dict] = []

        async def send_json(self, payload: dict) -> None:
            self.frames.append(payload)

    socket = FakeSocket()
    session = VoiceSession(socket)  # type: ignore[arg-type]

    # Keep this offline: the boundary logic is what is under test, not the agent.
    async def _noop(text: str, generation: int) -> None:
        return None

    session._guarded_turn = _noop  # type: ignore[assignment,method-assign]

    await session.start_turn("first question")
    first_turn = [f for f in socket.frames if f["type"] == "turn"]
    check("starting a turn announces it", len(first_turn) == 1, str(socket.frames))
    first_gen = first_turn[0]["gen"]

    await session.start_turn("second question")
    turns = [f for f in socket.frames if f["type"] == "turn"]
    check("each turn announces itself", len(turns) == 2)
    check(
        "the turn id advances so older audio can be identified",
        turns[1]["gen"] > first_gen,
        f"{first_gen} -> {turns[1]['gen']}",
    )
    check(
        "a superseded turn is no longer current",
        session._generation == turns[1]["gen"],
    )

    # ------------------------------------------------------------- language
    print("\n== language ==")
    from app.core.languages import DEFAULT_LANGUAGE, reply_directive, reply_reminder

    # English used to be the one language with no per-turn reminder, on the
    # assumption that the default needed no defending. It did: with only a line
    # at the top of the system prompt, an English session answered an English
    # question ("2 squared is 4") in Telugu, and greeting it with "Namaste"
    # flipped it outright. Every language now gets the same anti-mirror anchor.
    check("english gets a reminder too", "English" in (reply_reminder("en-IN") or ""))
    check(
        "english reminder forbids mirroring",
        "not mirror" in (reply_reminder("en-IN") or ""),
    )
    check(
        "english directive forbids mirroring",
        "NOT a request to switch" in reply_directive("en-IN"),
    )
    check("telugu gets a reminder", "Telugu" in (reply_reminder("te-IN") or ""))
    check(
        "telugu directive demands code-mix",
        "times" in reply_directive("te-IN") and "Latin script" in reply_directive("te-IN"),
    )
    check(
        "unknown code falls back to default",
        reply_reminder("xx-XX") == reply_reminder(DEFAULT_LANGUAGE),
    )

    lang = await execute_tool("set_language", {"language": "Telugu"})
    check("set_language accepts a plain name", not lang.is_error, lang.content[:70])
    check(
        "language persisted",
        await crud.get_preference(crud.PREF_VOICE_LANGUAGE, "") == "te-IN",
    )
    check(
        "native script accepted",
        not (await execute_tool("set_language", {"language": "తెలుగు"})).is_error,
    )
    check(
        "nonsense language rejected",
        (await execute_tool("set_language", {"language": "Klingon"})).is_error,
    )
    await crud.set_preference(crud.PREF_VOICE_LANGUAGE, DEFAULT_LANGUAGE)

    # --- every handler actually runs ---------------------------------------
    #
    # `set_reminder` shipped with a missing import. Nothing caught it, because
    # `execute_tool` turns any exception into readable text — so the tool
    # "worked", returning "set_reminder failed: name 'parse_datetime' is not
    # defined" to the model, which dutifully retried it eight times and burned
    # the entire iteration budget on one broken import.
    #
    # That is the trade-off of never raising: a crash is indistinguishable from
    # a refusal unless something looks. This looks. Every tool must be invoked
    # here with a plausible payload, and a Python-level failure is a test
    # failure rather than a message.
    print("\n== every tool handler is wired ==")
    probes: dict[str, dict] = {
        "add_task": {"title": "wiring probe"},
        "update_task_status": {"task_id": 999_999, "status": "PENDING"},
        "get_dashboard_summary": {},
        "save_idea_or_note": {"title": "probe", "content": "probe"},
        "search_memory": {"query": "probe"},
        "generate_proactive_brief": {},
        "add_schedule_event": {"event_name": "probe", "day_of_week": 0, "start_time": "09:00"},
        "bulk_delete_tasks": {"scope": "completed"},
        "update_task": {"task_id": 999_999, "title": "probe"},
        "update_schedule_event": {
            "event_id": 999_999,
            "matching": "probe",
            "event_name": "probe",
        },
        "set_voice": {"voice": "female"},
        "update_idea": {"idea_id": 999_999, "title": "probe"},
        "delete_record": {"record_type": "task", "title": "probe-that-does-not-exist"},
        "set_language": {"language": "English"},
        "configure_notifications": {},
        "set_reminder": {
            "text": "probe",
            "remind_at": days_from_now(1),
            "time_expression": "tomorrow",
        },
        # Reaches the network. The check here is that the handler does not
        # *raise* — an unreachable weather service must come back as an error
        # outcome the model can read, which is exactly what this loop verifies,
        # so it stays meaningful offline.
        "get_weather": {"location": "Nellore", "days": 1},
        "web_search": {"query": "python asyncio", "limit": 2},
        "fetch_url": {"url": "https://example.com"},
        "run_command": {"command": "echo probe"},
        "read_file": {"path": "no-such-file-probe.txt"},
        "write_file": {"path": "storage/wiring_probe.txt", "content": "probe"},
        "edit_file": {"path": "no-such-file-probe.txt", "old_text": "a", "new_text": "b"},
        "list_dir": {"path": "."},
        "search_files": {"query": "probe", "path": "storage"},
    }

    missing = [s.name for s in TOOL_REGISTRY if s.name not in probes]
    check("every registered tool has a probe", not missing, missing)

    crashes = []
    for spec in TOOL_REGISTRY:
        payload = probes.get(spec.name)
        if payload is None:
            continue
        outcome = await execute_tool(spec.name, payload)
        # `handler raised` is rendered as "{name} failed: {exception}".
        if f"{spec.name} failed:" in outcome.content:
            crashes.append(f"{spec.name}: {outcome.content[:100]}")
    check("no handler raised", not crashes, crashes)
    Path("storage/wiring_probe.txt").unlink(missing_ok=True)

    await db.disconnect()


    # ------------------------------------------------------------ HTTP API
    print("\n== HTTP routes ==")
    from fastapi.testclient import TestClient

    import main

    with TestClient(main.app) as client:
        health = client.get("/api/health")
        check("GET /api/health -> 200", health.status_code == 200, str(health.status_code))
        check(
            "health reports the chat model",
            health.json()["model"] == settings.sarvam_chat_model,
            health.json().get("model", ""),
        )
        check(
            "health reports the provider wiring",
            health.json()["details"]["chat_provider"] == settings.jarvis_chat_provider,
        )

        voice_cfg = client.get("/api/voice/config")
        check("GET /api/voice/config -> 200", voice_cfg.status_code == 200)
        check(
            "voice config names both speech providers",
            {"stt_provider", "tts_provider"} <= set(voice_cfg.json()),
        )
        check(
            "empty audio upload -> 400",
            client.post(
                "/api/voice/transcribe", files={"file": ("x.wav", b"", "audio/wav")}
            ).status_code
            == 400,
        )

        dashboard = client.get("/api/dashboard")
        check("GET /api/dashboard -> 200", dashboard.status_code == 200, str(dashboard.status_code))
        body = dashboard.json()
        for key in ("counts", "brief", "tasks", "today", "upcoming", "ideas", "memories"):
            check(f"dashboard includes '{key}'", key in body)
        check("dashboard returns tasks", len(body["tasks"]) >= 3, str(len(body["tasks"])))
        check("overdue tasks counted", body["counts"]["OVERDUE"] >= 1, str(body["counts"]["OVERDUE"]))

        target = next(t for t in body["tasks"] if t["status"] == "PENDING")
        cycled = client.post("/api/tasks/toggle", json={"task_id": target["id"]})
        check("POST /api/tasks/toggle -> 200", cycled.status_code == 200, str(cycled.status_code))
        check(
            "toggle cycles PENDING -> IN_PROGRESS",
            cycled.json()["task"]["status"] == "IN_PROGRESS",
            cycled.json()["task"]["status"],
        )
        check("toggle returns fresh counts and brief", {"counts", "brief"} <= set(cycled.json()))

        explicit = client.post("/api/tasks/toggle", json={"task_id": target["id"], "status": "COMPLETED"})
        check("explicit status honoured", explicit.json()["task"]["status"] == "COMPLETED")
        check(
            "toggle on a missing task -> 404",
            client.post("/api/tasks/toggle", json={"task_id": 987_654}).status_code == 404,
        )

        history = client.get("/api/chat/history")
        check("GET /api/chat/history -> 200", history.status_code == 200)
        check("history omits empty tool-result turns", all(m["text"].strip() for m in history.json()))

        check("POST /api/briefs/generate -> 200", client.post("/api/briefs/generate").status_code == 200)
        check(
            "empty chat message -> 422",
            client.post("/api/chat", json={"message": ""}).status_code == 422,
        )
        check("DELETE /api/chat/history -> 204", client.delete("/api/chat/history").status_code == 204)


    print("\n" + "=" * 60)
    if failures:
        print(f"FAILED ({len(failures)}):")
        for failure in failures:
            print("  -", failure)
        return 1
    print("ALL CHECKS PASSED")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(asyncio.run(main()))
    except SystemExit:
        raise
    except Exception:
        traceback.print_exc()
        raise SystemExit(2)
