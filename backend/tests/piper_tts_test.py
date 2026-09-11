"""Local English TTS routing and synthesis.

Runs without a database or any network. The synthesis checks need the Piper
voice on disk and piper-tts installed; when either is missing they skip rather
than fail, so this file is safe on a machine that has not fetched the model.
"""

from __future__ import annotations

import asyncio
import io
import os
import sys
import wave
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

os.environ.setdefault("ANTHROPIC_API_KEY", "sk-ant-piper-test")
os.environ.setdefault("SARVAM_API_KEY", "piper-test")

import app.services.speech as speech  # noqa: E402
from app.providers import get_english_tts_provider, get_tts_provider  # noqa: E402
from app.providers.base import ProviderNotConfigured  # noqa: E402
from app.providers.piper import PiperTTS  # noqa: E402
from app.providers.sarvam import SarvamTTS  # noqa: E402

passed = failed = skipped = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global passed, failed
    if ok:
        passed += 1
        print(f"  [PASS] {name}")
    else:
        failed += 1
        print(f"  [FAIL] {name} {detail}")


def skip(name: str, why: str) -> None:
    global skipped
    skipped += 1
    print(f"  [SKIP] {name} — {why}")


def _voice_available() -> bool:
    try:
        import piper  # noqa: F401
    except ImportError:
        return False
    raw = Path(speech.settings.jarvis_piper_model)
    from app.core.config import BACKEND_ROOT

    path = raw if raw.is_absolute() else (BACKEND_ROOT / raw)
    return path.exists()


def main() -> int:
    print("== routing ==")
    # English → the local engine (Piper here); every Indic language → Sarvam.
    check("English routes to Piper", isinstance(speech._provider_for("en-IN"), PiperTTS))
    check("Telugu routes to Sarvam", isinstance(speech._provider_for("te-IN"), SarvamTTS))
    check("Hindi routes to Sarvam", isinstance(speech._provider_for("hi-IN"), SarvamTTS))
    check(
        "unknown language falls back to English routing",
        isinstance(speech._provider_for("zz-XX"), PiperTTS),
    )
    check(
        "get_english_tts_provider is the Piper engine",
        isinstance(get_english_tts_provider(), PiperTTS),
    )
    check(
        "the other-language engine is still Sarvam",
        isinstance(get_tts_provider(), SarvamTTS),
    )

    print("\n== length_scale mapping ==")
    p = PiperTTS()
    # pace is rate (bigger = faster); length_scale is duration (bigger = slower).
    fast = p._config(1.5).length_scale
    slow = p._config(0.8).length_scale
    check("faster pace yields a smaller length_scale", fast < slow, f"{fast} !< {slow}")
    check("length_scale stays in the safe band", 0.6 <= fast <= 1.6 and 0.6 <= slow <= 1.6)

    print("\n== synthesis ==")
    if not _voice_available():
        skip("synthesize produces WAV", "piper-tts or the voice model is absent")
        skip("stream_speech produces PCM packets", "piper-tts or the voice model is absent")
    else:
        async def synth() -> None:
            speech_out = await p.synthesize("Your next class is at nine thirty.", "en-IN")
            with wave.open(io.BytesIO(speech_out.audio)) as w:
                frames, ch, width = w.getnframes(), w.getnchannels(), w.getsampwidth()
            check("synthesize produces WAV", speech_out.content_type == "audio/wav" and frames > 0)
            check("mono 16-bit", ch == 1 and width == 2, f"ch={ch} width={width}")

            total = packets = 0
            async for pkt in p.stream_speech("Done. Three tasks pending.", "en-IN"):
                packets += 1
                total += len(pkt.audio)
                check_rate = pkt.sample_rate
            check("stream_speech produces PCM packets", packets > 0 and total > 0)
            check("packets are PCM16 sample-aligned", total % 2 == 0)

        asyncio.run(synth())

    print("\n== empty input ==")

    async def empty() -> None:
        try:
            await p.synthesize("   ", "en-IN")
        except Exception as exc:  # noqa: BLE001
            check("empty text is rejected", "speak" in str(exc).lower() or isinstance(exc, ProviderNotConfigured))
            return
        check("empty text is rejected", False, "no error raised")

    asyncio.run(empty())

    print(f"\n{passed} passed, {failed} failed, {skipped} skipped")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
