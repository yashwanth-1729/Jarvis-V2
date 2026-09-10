"""Trimming the silence the TTS vendor pads onto every clip.

Spoken replies are synthesized one sentence at a time and scheduled back-to-back
by the client, so silence inside a clip is heard as a gap *between* lines.
Measured on bulbul:v3 across three consecutive sentences the padding was 93ms,
166ms and 278ms -- so the reply did not merely drag, it lurched, because the
pause was different every time.

These run offline against synthetic WAVs: the property being tested is "how much
silence is left", which needs no vendor call to verify.

    .venv/Scripts/python.exe tests/audio_test.py
"""

from __future__ import annotations

import io
import math
import struct
import sys
import wave
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

from app.services.speech import TAIL_PAD_MS, trim_silence  # noqa: E402

RATE = 24_000

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


def make_wav(lead_ms: int, tone_ms: int, tail_ms: int, channels: int = 1) -> bytes:
    """A clip of silence, then a tone, then silence -- the shape of TTS output."""
    samples: list[int] = [0] * int(RATE * lead_ms / 1000)
    for i in range(int(RATE * tone_ms / 1000)):
        samples.append(int(12_000 * math.sin(2 * math.pi * 220 * i / RATE)))
    samples += [0] * int(RATE * tail_ms / 1000)
    if channels == 2:
        samples = [s for s in samples for _ in range(2)]

    out = io.BytesIO()
    with wave.open(out, "wb") as sink:
        sink.setnchannels(channels)
        sink.setsampwidth(2)
        sink.setframerate(RATE)
        sink.writeframes(struct.pack(f"<{len(samples)}h", *samples))
    return out.getvalue()


def measure(audio: bytes) -> tuple[float, float, float]:
    """(lead ms, tail ms, speech ms) using the same 2%-of-peak floor."""
    with wave.open(io.BytesIO(audio)) as source:
        channels = source.getnchannels()
        rate = source.getframerate()
        frames = source.readframes(source.getnframes())
    samples = struct.unpack(f"<{len(frames) // 2}h", frames)
    if channels > 1:
        samples = samples[::channels]
    peak = max((abs(s) for s in samples), default=0)
    if peak == 0:
        return len(samples) / rate * 1000, 0.0, 0.0
    floor = peak * 0.02
    first = next(i for i, s in enumerate(samples) if abs(s) > floor)
    last = next(i for i in range(len(samples) - 1, -1, -1) if abs(samples[i]) > floor)
    return (
        first / rate * 1000,
        (len(samples) - 1 - last) / rate * 1000,
        (last - first + 1) / rate * 1000,
    )


print("== the three real clips that prompted this ==")
# Padding taken from a live measurement, so the fixture is not invented.
for name, lead, tone, tail in (
    ("Yes boss.", 13, 640, 166),
    ("Your Java class is at seven thirty PM.", 34, 2_130, 93),
    ("I have moved it to ten o'clock tonight.", 21, 1_650, 278),
):
    before = make_wav(lead, tone, tail)
    after = trim_silence(before)
    lead_out, tail_out, speech_out = measure(after)
    _, _, speech_in = measure(before)

    check(f"{name[:34]:<34} tail {tail}ms -> {tail_out:.0f}ms", abs(tail_out - TAIL_PAD_MS) <= 5)
    check("  lead-in silence is gone", lead_out < 2, f"{lead_out:.1f}ms")
    check("  speech itself is untouched", abs(speech_out - speech_in) < 5, f"{speech_in:.0f} -> {speech_out:.0f}")

print("\n== evenness: the wobble is what makes it sound broken ==")
tails = []
for tail in (93, 166, 278, 40, 500):
    _, out_tail, _ = measure(trim_silence(make_wav(20, 800, tail)))
    tails.append(out_tail)
spread = max(tails) - min(tails)
check("every clip ends with the same beat", spread <= 5, f"spread {spread:.1f}ms across {tails}")

print("\n== it must never destroy audio ==")
check("stereo survives", len(trim_silence(make_wav(30, 500, 200, channels=2))) > 0)
_, stereo_tail, _ = measure(trim_silence(make_wav(30, 500, 200, channels=2)))
check("  stereo tail trimmed too", abs(stereo_tail - TAIL_PAD_MS) <= 5, f"{stereo_tail:.0f}ms")

silent = make_wav(0, 0, 300)
check("an all-silent clip is returned unchanged", trim_silence(silent) == silent)

check("garbage is returned unchanged", trim_silence(b"not a wav") == b"not a wav")
check("empty input is returned unchanged", trim_silence(b"") == b"")

no_pad = make_wav(0, 700, 0)
_, tail_out, _ = measure(trim_silence(no_pad))
check(
    "an already-tight clip gains the beat, not loses audio",
    abs(tail_out - TAIL_PAD_MS) <= 5,
    f"{tail_out:.0f}ms",
)

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
