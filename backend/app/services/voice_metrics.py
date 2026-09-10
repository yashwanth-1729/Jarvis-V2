"""Bounded in-process voice timings; no audio, text, keys, or record content."""
from collections import defaultdict, deque
import math

_samples: dict[str, deque[float]] = defaultdict(lambda: deque(maxlen=100))
_ALLOWED = {"stt_ms", "commit_to_text_ms", "commit_to_audio_sent_ms", "tts_first_packet_ms", "speech_end_to_playback_ms"}


def record(stage: str, milliseconds: float) -> None:
    if stage in _ALLOWED and math.isfinite(milliseconds) and 0 <= milliseconds <= 300000:
        _samples[stage].append(milliseconds)


def snapshot() -> dict:
    result = {}
    for stage, samples in _samples.items():
        values = sorted(samples)
        if not values:
            continue
        result[stage] = {
            "count": len(values),
            **{f"p{p}": round(values[max(0, math.ceil(len(values)*p/100)-1)], 1) for p in (50, 90, 99)},
        }
    return {"unit": "milliseconds", "window": "last 100 samples per stage, this backend process", "stages": result}
