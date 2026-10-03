"""Who the user said they are, during the public edition's onboarding.

The app hands over the onboarding answers (name, the vibe they picked, stage,
interests, goals, rhythm, language; ``frontend/src/lib/profile.ts``) and the
agent folds a short summary into its persona message, so every reply is
personal and in the chosen voice. The persona message is the cached half of
the prompt, and this text only changes when the user edits their profile, so
the prefix cache keeps hitting.

Stored as a small JSON file beside the database: device-local, never synced,
never seeded over, the same as reminders and Lock-in.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from app.core.config import settings

logger = logging.getLogger("jarvis.profile")

VIBES: dict[str, str] = {
    "hype": (
        "Hype friend: high energy and warm, playful slang, celebrate every win "
        "loudly, push them with excitement."
    ),
    "coach": (
        "Strict coach: direct and demanding, short sentences, no excuses "
        "accepted, hold them to what they committed to, but never cruel."
    ),
    "chill": (
        "Chill bro: relaxed and casual, friendly banter and light humour, no "
        "pressure, still genuinely useful."
    ),
    "monk": (
        "Calm monk: calm, grounded and gentle. Slow them down, one thing at a "
        "time."
    ),
}
STAGES = {
    "school": "in school",
    "college": "in college",
    "working": "working",
    "creator": "a creator",
    "exam": "preparing for an exam",
}
LANGUAGES = {
    "en": "",
    "te": (
        "Their language is Telugu. In text replies, a natural Telugu word "
        "(Roman script) now and then is welcome."
    ),
    "hinglish": (
        "They like Hinglish. In text replies, mix casual Hindi words into English "
        "naturally (Roman script)."
    ),
}

_TEXT_FIELDS = ("name", "callMe", "vibe", "stage", "exam", "examDate", "enemy", "wake", "sleep",
                "chronotype", "language", "completedAt")
_LIST_FIELDS = ("interests", "goals")
_cache: dict[str, Any] | None = None
_loaded = False


def _path() -> Path:
    return settings.db_file.with_name("profile.json")


def _clean(data: dict[str, Any]) -> dict[str, Any]:
    """Keep known fields at sane sizes. The text reaches the prompt, so it is
    bounded and cannot carry anything but short labels."""
    out: dict[str, Any] = {}
    for key in _TEXT_FIELDS:
        value = data.get(key)
        if isinstance(value, str) and value.strip():
            out[key] = " ".join(value.split())[:60]
    for key in _LIST_FIELDS:
        value = data.get(key)
        if isinstance(value, list):
            out[key] = [" ".join(str(item).split())[:40] for item in value if str(item).strip()][:12]
    out["wantsLockinTrial"] = bool(data.get("wantsLockinTrial"))
    if out.get("vibe") not in VIBES:
        out.pop("vibe", None)
    if out.get("language") not in LANGUAGES:
        out.pop("language", None)
    return out


def load() -> dict[str, Any] | None:
    global _cache, _loaded
    if not _loaded:
        _loaded = True
        try:
            _cache = json.loads(_path().read_text(encoding="utf-8"))
        except FileNotFoundError:
            _cache = None
        except (OSError, ValueError):
            logger.warning("Could not read the profile; starting without one")
            _cache = None
    return _cache


def save(data: dict[str, Any]) -> dict[str, Any]:
    global _cache, _loaded
    profile = _clean(data)
    path = _path()
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(profile, ensure_ascii=False, indent=2), encoding="utf-8")
    temp.replace(path)
    _cache, _loaded = profile, True
    return profile


def clear() -> None:
    global _cache, _loaded
    try:
        _path().unlink()
    except FileNotFoundError:
        pass
    _cache, _loaded = None, True


def persona_note(profile: dict[str, Any] | None = None) -> str | None:
    """A short "about this person" block for the persona message, or None."""
    profile = profile if profile is not None else load()
    if not profile:
        return None
    lines = ["About the person you're talking to (from their setup; use it, never recite it):"]
    call = profile.get("callMe") or profile.get("name")
    if call:
        name = profile.get("name")
        lines.append(f"- Call them {call}." + (f" Their name is {name}." if name and name != call else ""))
    stage = STAGES.get(str(profile.get("stage") or ""))
    if stage:
        exam = profile.get("exam")
        exam_date = profile.get("examDate")
        detail = f" ({exam}{', on ' + exam_date if exam_date else ''})" if exam else ""
        lines.append(f"- They're {stage}{detail}.")
    if profile.get("interests"):
        lines.append(f"- Into: {', '.join(profile['interests'])}.")
    if profile.get("goals"):
        lines.append(f"- Goals this year: {', '.join(profile['goals'])}.")
    if profile.get("enemy"):
        lines.append(f"- What wrecks their day: {profile['enemy']}.")
    if profile.get("wake") and profile.get("sleep"):
        rhythm = {"early": "an early bird", "night": "a night owl"}.get(str(profile.get("chronotype") or ""), "")
        lines.append(f"- Up around {profile['wake']}, asleep by {profile['sleep']}" + (f", {rhythm}" if rhythm else "") + ".")
    vibe = VIBES.get(str(profile.get("vibe") or ""))
    if vibe:
        lines.append(f"Your vibe with them: {vibe}")
    language = LANGUAGES.get(str(profile.get("language") or ""), "")
    if language:
        lines.append(language)
    return "\n".join(lines) if len(lines) > 1 else None
