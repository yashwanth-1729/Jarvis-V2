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
os.environ.setdefault("ANTHROPIC_API_KEY", "sk-ant-smoke-test-not-real")

failures: list[str] = []


def check(label: str, condition: bool, detail: str = "") -> None:
    print(f"  [{'PASS' if condition else 'FAIL'}] {label}" + (f" — {detail}" if detail else ""))
    if not condition:
        failures.append(label)


async def main() -> int:
    from app.core.config import settings
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
    check("7 tools registered", len(TOOL_SCHEMAS) == 7, str(len(TOOL_SCHEMAS)))
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
    check(
        "missing id is a recoverable error, not an exception",
        (await execute_tool("update_task_status", {"task_id": 999_999, "status": "COMPLETED"})).is_error,
    )

    # ------------------------------------------------ get_dashboard_summary
    print("\n== tool: get_dashboard_summary ==")
    summary = await execute_tool("get_dashboard_summary", {})
    check("summary lists open tasks", "OPEN TASKS" in summary.content)
    check("summary lists today's schedule", "TODAY'S SCHEDULE" in summary.content)

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
