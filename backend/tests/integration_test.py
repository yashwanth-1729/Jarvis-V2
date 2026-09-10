"""End-to-end integration test: real Sarvam calls through the real agent loop.

Runs against a throwaway database. Exercises the full tool round-trip
(model -> tool_calls -> execute -> tool messages -> final answer) plus both
voice endpoints.
"""

import asyncio
import io
import os
import sys
import tempfile
import traceback
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

# Replies contain non-Latin script and typographic punctuation; the Windows
# console defaults to cp1252 and would raise UnicodeEncodeError on both.
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

TMP_DB = Path(tempfile.gettempdir()) / "jarvis_integration.db"
for suffix in ("", "-wal", "-shm"):
    p = Path(str(TMP_DB) + suffix)
    if p.exists():
        p.unlink()
os.environ["JARVIS_DB_PATH"] = str(TMP_DB)

failures = []


def check(label, cond, detail=""):
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f" â€” {detail}" if detail else ""))
    if not cond:
        failures.append(label)


async def main():
    from app.core.config import settings
    from app.db import crud
    from app.db.database import db
    from app.llm.agent import run_turn

    print(f"\nchat model : {settings.sarvam_chat_model}")
    print(f"max_tokens : {settings.jarvis_max_tokens}")
    print(f"key set    : {settings.has_api_key}")

    await db.connect()

    # ---------------------------------------------------------------- turn 1
    print("\n== turn 1: multi-tool capture ==")
    prompt = (
        "Add a high priority task to renew the domain on Friday at 10am, "
        "and block Thursday 2pm to 3pm for the design review in Room 4."
    )
    events, text, tool_uses, tool_results, errors = [], [], [], [], []
    thinking_chars = 0

    async for ev in run_turn(prompt):
        events.append(ev["type"])
        d = ev.get("data", {})
        if ev["type"] == "text":
            text.append(d["text"])
        elif ev["type"] == "thinking":
            thinking_chars += len(d["text"])
        elif ev["type"] == "tool_use":
            tool_uses.append(d["name"])
            print(f"   -> tool_use  {d['name']}")
        elif ev["type"] == "tool_result":
            tool_results.append((d["name"], d["ok"]))
            print(f"   -> result    {d['name']} ok={d['ok']}: {d['summary'][:90]}")
        elif ev["type"] == "error":
            errors.append(d["message"])
            print(f"   -> ERROR     {d['message'][:160]}")
        elif ev["type"] == "done":
            print(f"   -> done      stop={d['stop_reason']} usage={d['usage']}")

    final = "".join(text).strip()
    print(f"\n   assistant: {final[:400]}")

    check("no errors emitted", not errors, "; ".join(errors)[:160])
    check("stream produced text", bool(final), f"{len(final)} chars")
    check("reasoning streamed", thinking_chars > 0, f"{thinking_chars} chars")
    check("at least one tool ran", len(tool_results) >= 1, f"{len(tool_results)} calls")
    check("all tool calls succeeded", all(ok for _, ok in tool_results),
          str([n for n, ok in tool_results if not ok]))
    check("every tool_use got a result", len(tool_uses) == len(tool_results),
          f"{len(tool_uses)} uses / {len(tool_results)} results")
    check("done event emitted", "done" in events)

    tasks = await crud.list_tasks()
    events_rows = await crud.upcoming_schedule(days=14)
    print(f"\n   db tasks   : {[(t['id'], t['title'], t['priority'], t['due_date']) for t in tasks]}")
    print(f"   db schedule: {[(e['id'], e['event_name'], e['time_start']) for e in events_rows]}")
    check("a task was persisted", len(tasks) >= 1, f"{len(tasks)} rows")

    # ---------------------------------------------------------------- turn 2
    # Depends on replayed history: the model must resolve "it" from turn 1 and
    # look up a real task id. This is what breaks if tool messages are malformed.
    print("\n== turn 2: history replay + state read ==")
    t2_text, t2_tools, t2_errors = [], [], []
    async for ev in run_turn("What's on my plate right now? Keep it to one sentence."):
        d = ev.get("data", {})
        if ev["type"] == "text":
            t2_text.append(d["text"])
        elif ev["type"] == "tool_result":
            t2_tools.append((d["name"], d["ok"]))
            print(f"   -> result    {d['name']} ok={d['ok']}")
        elif ev["type"] == "error":
            t2_errors.append(d["message"])
            print(f"   -> ERROR     {d['message'][:160]}")

    reply = "".join(t2_text).strip()
    print(f"\n   assistant: {reply[:400]}")
    check("turn 2 had no errors", not t2_errors, "; ".join(t2_errors)[:160])
    check("turn 2 produced text", bool(reply))
    check("turn 2 tool calls all ok", all(ok for _, ok in t2_tools) if t2_tools else True)

    history = await crud.recent_chat_messages(50)
    roles = [(r["blocks"] or {}).get("role") for r in history if isinstance(r["blocks"], dict)]
    print(f"\n   stored message roles: {roles}")
    check("tool messages persisted for replay", "tool" in roles, str(set(roles)))
    check("assistant messages persisted", "assistant" in roles)

    await db.disconnect()

    # ------------------------------------------------------------- voice API
    print("\n== voice endpoints ==")
    from fastapi.testclient import TestClient
    import main as app_main

    with TestClient(app_main.app) as client:
        cfg = client.get("/api/voice/config")
        check("GET /api/voice/config -> 200", cfg.status_code == 200)
        check("voice reports enabled", cfg.json().get("enabled") is True, str(cfg.json()))

        spoken = client.post("/api/voice/speak", json={"text": "Two tasks are overdue."})
        check("POST /api/voice/speak -> 200", spoken.status_code == 200, str(spoken.status_code))
        audio = spoken.content
        check("speak returned wav bytes", len(audio) > 2000, f"{len(audio)} bytes")
        check("speak content-type is audio", spoken.headers["content-type"].startswith("audio/"),
              spoken.headers.get("content-type", ""))

        if len(audio) > 2000:
            back = client.post(
                "/api/voice/transcribe",
                files={"file": ("clip.wav", audio, "audio/wav")},
            )
            check("POST /api/voice/transcribe -> 200", back.status_code == 200, str(back.status_code))
            if back.status_code == 200:
                got = back.json()
                print(f"   round-trip transcript: {got.get('text')!r}")
                check("transcript is non-empty", bool(got.get("text")))
                check("round-trip recovers the words",
                      "overdue" in (got.get("text") or "").lower(), got.get("text", ""))

        empty = client.post("/api/voice/transcribe", files={"file": ("x.wav", b"", "audio/wav")})
        check("empty upload -> 400", empty.status_code == 400, str(empty.status_code))

        h = client.get("/api/health")
        check("health reports sarvam", h.json()["details"]["chat_provider"] == "sarvam")

    print("\n" + "=" * 62)
    if failures:
        print(f"FAILED ({len(failures)}):")
        for f in failures:
            print("  -", f)
        return 1
    print("ALL INTEGRATION CHECKS PASSED")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except SystemExit:
        raise
    except Exception:
        traceback.print_exc()
        sys.exit(2)

