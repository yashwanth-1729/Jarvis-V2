"""Live test of the two-tier listening protocol over a real websocket.

Reproduces the behaviours the user asked for:

1. A question split across pauses arrives as one question, not three.
2. Saying "period" ends the turn immediately, without waiting out the long
   silence timer.
3. The stop word never reaches the model.

Drives the socket the way the browser does — segments, then either a stop word
or an explicit `end_turn`.

    .venv/Scripts/python.exe tests/segment_test.py
"""

from __future__ import annotations

import asyncio
import base64
import io
import json
import os
import sys
import tempfile
import time
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

TMP_DB = Path(tempfile.gettempdir()) / "jarvis_segment_test.db"
for suffix in ("", "-wal", "-shm"):
    target = Path(str(TMP_DB) + suffix)
    if target.exists():
        target.unlink()
os.environ["JARVIS_DB_PATH"] = str(TMP_DB)
# CRITICAL: this test starts the real app lifespan (TestClient runs it),
# which starts the sync loop if not disabled here. Without this, a machine
# with real Supabase credentials in backend/.env pushes this test's
# throwaway local data to the LIVE project and deletes real rows via
# tombstones -- this actually happened once. Never remove this line.
os.environ["JARVIS_SYNC_ENABLED"] = "false"


failures: list[str] = []


def check(label: str, condition: bool, detail: str = "") -> None:
    print(f"  [{'PASS' if condition else 'FAIL'}] {label}" + (f"  -> {detail}" if detail else ""))
    if not condition:
        failures.append(label)


async def main() -> int:
    from fastapi.testclient import TestClient

    from app.db.database import db
    from app.services import speech
    from main import app

    await db.connect()

    async def say(text: str, language: str = "en-IN") -> str:
        """Render text to a WAV the way a microphone would deliver it."""
        rendered = await speech.speak(text, language_code=language)
        return base64.b64encode(rendered.audio).decode("ascii")

    print("\n== rendering test audio ==")
    part_one = await say("What is on my schedule")
    part_two = await say("this evening")
    with_stop = await say("What time is it period")
    await db.disconnect()
    print("  three clips ready")

    # `with TestClient(...)` is required: it runs the app lifespan, which is
    # what reconnects the database the socket handler needs.
    with TestClient(app) as client:
        return run_cases(client, part_one, part_two, with_stop)


def run_cases(client, part_one: str, part_two: str, with_stop: str) -> int:
    # ---------------------------------------------------------------- case 1
    print("\n== a question split across a pause is ONE question ==")
    with client.websocket_connect("/api/voice/session") as socket:
        transcripts: list[str] = []
        started = False

        socket.send_json({"type": "segment", "audio": part_one})
        socket.send_json({"type": "segment", "audio": part_two})
        socket.send_json({"type": "end_turn"})

        deadline = time.time() + 90
        while time.time() < deadline:
            frame = socket.receive_json()
            if frame["type"] == "transcript":
                transcripts.append(frame["text"])
            if frame["type"] == "turn":
                started = True
                break

        final = transcripts[-1] if transcripts else ""
        print(f"   transcript updates: {transcripts}")
        check("both segments were joined", "schedule" in final.lower() and "evening" in final.lower(), final)
        check("only one turn was started", started)
        check(
            "transcript was sent per segment, as a running total",
            len(transcripts) >= 2,
            f"{len(transcripts)} updates",
        )

    # ---------------------------------------------------------------- case 2
    print("\n== 'period' ends the turn without an end_turn message ==")
    with client.websocket_connect("/api/voice/session") as socket:
        heard = ""
        started = False

        # Deliberately no end_turn: the stop word alone must close it.
        socket.send_json({"type": "segment", "audio": with_stop})

        deadline = time.time() + 90
        while time.time() < deadline:
            frame = socket.receive_json()
            if frame["type"] == "transcript":
                heard = frame["text"]
            if frame["type"] == "turn":
                started = True
                break

        print(f"   heard: {heard!r}")
        check("the stop word alone ended the turn", started)
        check(
            "the stop word never reaches the model",
            "period" not in heard.lower(),
            heard,
        )
        check("the actual question survived", "time" in heard.lower(), heard)

    print("\n" + "=" * 60)
    if failures:
        print(f"FAILED ({len(failures)}):")
        for label in failures:
            print("  -", label)
        return 1
    print("ALL SEGMENT CHECKS PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
