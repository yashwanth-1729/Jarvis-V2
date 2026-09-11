"""Measure whether saying "period" actually shortens the wait.

The claim is that a stop word ends the turn sooner than waiting out the silence
timer. That is worth measuring rather than assuming — the segment still has to
reach the server and be transcribed either way, so the saving could easily be
smaller than it looks on paper.

Times, from "the user stopped speaking" to "the turn started":

  stop word   segment closes at SEGMENT_SILENCE_MS -> transcribe -> stop word
              spotted -> turn starts
  silence     same, but the turn waits for the client's TURN_SILENCE_MS timer

    .venv/Scripts/python.exe tests/latency_test.py
"""

from __future__ import annotations

import asyncio
import base64
import io
import os
import sys
import tempfile
import time
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

TMP_DB = Path(tempfile.gettempdir()) / "jarvis_latency_test.db"
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


# Mirrors frontend/src/lib/realtime.ts. Kept here so the arithmetic below is
# explicit rather than hidden.
SEGMENT_SILENCE_MS = 700
TURN_SILENCE_MS = 5000


def measure(client, audio_b64: str, *, use_stop_word: bool) -> float:
    """Server-side time from segment arrival to the turn starting, in seconds."""
    from fastapi.testclient import TestClient  # noqa: F401  (typing only)

    with client.websocket_connect("/api/voice/session") as socket:
        # Drain the handshake: language, voice, then the initial state frame.
        while socket.receive_json()["type"] != "state":
            pass

        started = time.perf_counter()
        socket.send_json({"type": "segment", "audio": audio_b64})

        if not use_stop_word:
            # The browser would wait out the long timer before sending this.
            # Simulated rather than slept, so the test does not take a minute.
            pass

        deadline = time.time() + 120
        while time.time() < deadline:
            frame = socket.receive_json()
            if frame["type"] == "turn":
                return time.perf_counter() - started
            if frame["type"] == "transcript" and not use_stop_word:
                # Transcription is done; a real client would now still be
                # counting down TURN_SILENCE_MS before closing the turn.
                socket.send_json({"type": "end_turn"})
    return float("nan")


async def main() -> int:
    from fastapi.testclient import TestClient

    from app.db.database import db
    from app.services import speech
    from main import app

    await db.connect()
    print("\n== rendering test audio ==")
    with_stop = base64.b64encode(
        (await speech.speak("What is on now period", language_code="en-IN")).audio
    ).decode("ascii")
    without_stop = base64.b64encode(
        (await speech.speak("What is on now", language_code="en-IN")).audio
    ).decode("ascii")
    await db.disconnect()
    print("  ready")

    with TestClient(app) as client:
        print("\n== server-side: segment arrival -> turn start ==")
        stop_times = [measure(client, with_stop, use_stop_word=True) for _ in range(2)]
        silence_times = [measure(client, without_stop, use_stop_word=False) for _ in range(2)]

        stop_best = min(stop_times)
        silence_best = min(silence_times)
        print(f"  with 'period'   {stop_best:.2f}s   (transcribe + spot the word)")
        print(f"  plain segment   {silence_best:.2f}s   (transcribe, then end_turn)")

    # Server cost is essentially identical — both paths transcribe one segment.
    # Any difference is entirely on the CLIENT, in how long it waits before
    # deciding the user has finished. So the honest question is not "does the
    # stop word help" but "how much of the help is just the tolerance setting".
    stop_wall = SEGMENT_SILENCE_MS / 1000 + stop_best

    print("\n== end to end, from the moment you stop speaking ==")
    print(f"  {'tolerance':>12}   {'just stop':>10}   {'say period':>11}   {'saving':>8}")
    print("  " + "-" * 50)

    savings: dict[int, float] = {}
    for tolerance_ms in (700, 2200, 5000, 7000):
        silence_wall = tolerance_ms / 1000 + silence_best
        saving = silence_wall - stop_wall
        savings[tolerance_ms] = saving
        marker = "  <- current" if tolerance_ms == TURN_SILENCE_MS else ""
        print(
            f"  {tolerance_ms:>10}ms   {silence_wall:>9.2f}s   {stop_wall:>10.2f}s   "
            f"{saving:>7.2f}s{marker}"
        )

    print("\n== reading ==")
    print("  Processing cost is the same either way — compare the two server")
    print(f"  numbers above ({stop_best:.2f}s vs {silence_best:.2f}s). The stop word does not")
    print("  make anything faster; it lets you skip the silence timer.")
    print()
    print(f"  At a 700ms tolerance the stop word saves {savings[700]:.2f}s — i.e. nothing,")
    print("  because simply stopping already ends the turn just as quickly. But a")
    print("  700ms tolerance is what used to cut you off mid-sentence.")
    print()
    print("  So the stop word is not a speed feature. It is what BUYS BACK the")
    print("  latency that a patient tolerance costs, letting the tolerance be")
    print("  long enough to think in without every turn feeling slow.")

    if savings[TURN_SILENCE_MS] < 1.0:
        print("\n  WARNING: at the current tolerance the stop word saves almost nothing.")
        return 1

    await asyncio.sleep(0)
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
