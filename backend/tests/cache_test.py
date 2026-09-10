"""The prompt prefix must stay byte-identical between turns.

Sarvam does automatic prefix caching. There is no `cache_control` field -- it
rejects one outright (400: system content must be a plain string) -- so the only
thing that earns a hit is a prefix that does not change. Measured against the
live endpoint, two turns one minute apart:

    live state inside the system message : 0% cached, then 0% cached
    live state moved to the tail         : 0% cached, then 92.7% cached

The prefix is roughly 4,700 tokens on a voice turn and is re-sent on every tool
iteration, up to eight per turn. So a refactor that quietly reintroduces
anything volatile ahead of the history -- a clock, a task count, a tool schema
that reorders -- costs real money on every request and produces no error, no
warning and no visible symptom. That is what this file exists to catch.

    .venv/Scripts/python.exe tests/cache_test.py           # offline, always safe
    .venv/Scripts/python.exe tests/cache_test.py --live    # two real API calls
"""

from __future__ import annotations

import asyncio
import io
import json
import os
import re
import sys
import tempfile
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

# A scratch database, so this never depends on -- or disturbs -- real data.
SCRATCH = Path(tempfile.gettempdir()) / "jarvis_cache_test.db"
if SCRATCH.exists():
    SCRATCH.unlink()
os.environ["JARVIS_DB_PATH"] = str(SCRATCH)

from app.core.config import get_settings  # noqa: E402

get_settings.cache_clear()
import app.core.config as cfg  # noqa: E402

cfg.settings = get_settings()

import app.db.database as dbmod  # noqa: E402

dbmod.db = dbmod.Database(cfg.settings.db_file, 5)
import app.db.crud as crud  # noqa: E402

crud.db = dbmod.db

import app.llm.agent as agent  # noqa: E402
import app.services.context as context_mod  # noqa: E402

agent.crud = crud
context_mod.crud = crud

LIVE = "--live" in sys.argv

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


#: Anything matching these must never appear in the cached prefix.
VOLATILE = [
    (r"\bNow:\s*\d{1,2}:\d{2}", "the clock"),
    (r"Task counts:", "task counts"),
    (r"TASK BOARD", "the task board"),
    (r"Current block:", "the active schedule block"),
    (r"<current_state>", "the state block"),
]


async def main() -> None:
    await dbmod.db.connect()
    try:
        print("== the persona message is the cached prefix ==")
        for voice in (False, True):
            mode = "voice" if voice else "text"
            persona = agent._build_persona_message(voice=voice, language="en-IN")
            body = persona["content"]
            check(f"{mode}: role is system", persona["role"] == "system")
            for pattern, what in VOLATILE:
                check(
                    f"{mode}: prefix carries no {what}",
                    re.search(pattern, body) is None,
                    f"found {pattern!r}",
                )

        print("\n== the same input must produce the identical prefix, twice ==")
        first = agent._build_persona_message(voice=True, language="en-IN")["content"]
        # A write between the two calls: the prefix must not notice.
        await crud.create_task(title="cache probe task", priority="HIGH")
        second = agent._build_persona_message(voice=True, language="en-IN")["content"]
        check("byte-identical across a database write", first == second)

        print("\n== the volatile half is separate, and it is not empty ==")
        state = await agent._build_state_message()
        check("state message is system-role", state["role"] == "system")
        # `Now:` until the clock line was split into `Clock:` and `Date:` and
        # moved below the schedule. It had led the block as a ready-made
        # sentence -- "Now: 22:59 (10:59 PM), Tuesday 25 August 2026" -- and
        # JARVIS was reading it out, in Telugu, as the whole answer to "delete
        # the tasks I created today".
        check(
            "state carries the clock",
            re.search(r"\bClock:\s*\d{1,2}:\d{2}", state["content"]) is not None,
        )
        check(
            "and the date, as a separate field",
            re.search(r"\bDate:\s*\w+", state["content"]) is not None,
        )
        check("state carries the board", "TASK BOARD" in state["content"])
        check(
            "the task written above reached it",
            "cache probe task" in state["content"],
            state["content"][:120],
        )

        print("\n== message order: persona, history, state ==")
        # Mirrors the assembly in run_turn.
        history = await agent._load_history()
        messages = [
            agent._build_persona_message(voice=False),
            *history,
            await agent._build_state_message(),
        ]
        check("persona is first", messages[0]["content"].startswith(
            agent._build_persona_message(voice=False)["content"][:40]))
        check("state is last", messages[-1] is messages[-1] and "<current_state>" in messages[-1]["content"])
        check(
            "nothing volatile sits ahead of the history",
            all(
                re.search(r"<current_state>", m.get("content") or "") is None
                for m in messages[:-1]
                if isinstance(m.get("content"), str)
            ),
        )

        print("\n== usage plumbing surfaces cache hits ==")
        # The provider filters usage to ints; cached_tokens lives one level down
        # and would be silently dropped without the flattening step.
        import app.providers.sarvam as sarvam_mod

        source = Path(sarvam_mod.__file__).read_text(encoding="utf-8")
        check(
            "sarvam flattens prompt_tokens_details.cached_tokens",
            "cached_tokens" in source and "prompt_tokens_details" in source,
        )

        if not LIVE:
            print("\n  (offline run — pass --live to verify against the real endpoint)")
            return

        print("\n== live: what the endpoint actually does with a stable prefix ==")
        # Measured 2026-08-21 with JARVIS's exact payload (stream, temperature,
        # reasoning_effort, 14 tool schemas), identical prefix throughout:
        #
        #     streaming     x4  -> prompt 5151, cached 0    (every time)
        #     stream=False  x2  -> prompt 5086, cached 5056 (99%, every time)
        #     streaming again, with the cache demonstrably warm -> still 0
        #
        # So the cache is real and large, and JARVIS cannot reach it, because
        # every turn streams. The layout fix above is still correct and still
        # required -- it is the precondition, and it puts the live state next to
        # the generation point where the codebase has twice learned rules
        # actually hold -- but the token saving is not available today.
        #
        # This asserts the *measured* behaviour rather than the hoped-for one.
        # If a run starts failing here because streaming began reporting cache
        # hits, that is good news: delete the xfail and take the saving.
        import httpx

        from app.llm.tools import OPENAI_TOOLS

        probe_messages = [
            agent._build_persona_message(voice=False),
            {"role": "user", "content": "say ok"},
        ]

        def probe(stream: bool) -> tuple[int, int]:
            payload = {
                "model": cfg.settings.sarvam_chat_model,
                "messages": probe_messages,
                "stream": stream,
                "max_tokens": 8,
                "temperature": cfg.settings.sarvam_temperature,
                "tools": list(OPENAI_TOOLS),
            }
            response = httpx.post(
                cfg.settings.sarvam_base_url.rstrip("/") + "/v1/chat/completions",
                headers={
                    "api-subscription-key": cfg.settings.sarvam_api_key,
                    "Content-Type": "application/json",
                },
                json=payload,
                timeout=90,
            )
            if stream:
                usage: dict = {}
                for line in response.text.splitlines():
                    body = line[5:].strip() if line.startswith("data:") else ""
                    if not body or body == "[DONE]":
                        continue
                    try:
                        event = json.loads(body)
                    except json.JSONDecodeError:
                        continue
                    if event.get("usage"):
                        usage = event["usage"]
            else:
                usage = response.json().get("usage", {})
            details = usage.get("prompt_tokens_details") or {}
            return usage.get("prompt_tokens", 0), (details.get("cached_tokens") or 0)

        probe(stream=False)  # warm it
        cold_prompt, non_stream_cached = probe(stream=False)
        _, streamed_cached = probe(stream=True)
        print(f"     non-streaming: prompt={cold_prompt} cached={non_stream_cached}")
        print(f"     streaming    : cached={streamed_cached}")

        check(
            "a stable prefix caches on the non-streaming path",
            non_stream_cached > cold_prompt * 0.5,
            f"{non_stream_cached}/{cold_prompt}",
        )
        check(
            "streaming still reports no cache (known Sarvam limitation)",
            streamed_cached == 0,
            f"cached={streamed_cached} — streaming now caches! Remove this xfail "
            "and switch the tool-planning rounds over to take the saving.",
        )
    finally:
        await dbmod.db.disconnect()


asyncio.run(main())
print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
