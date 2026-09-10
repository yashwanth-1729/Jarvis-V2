"""Selectable TTS voices.

Every entry below was verified against the live API in both `en-IN` and
`te-IN` — the vendor's own advertised speaker list is stale (it offers
`niharika`, which is then rejected as unrecognized), so this catalogue is the
measured set rather than the documented one.
"""

from __future__ import annotations

from dataclasses import dataclass

DEFAULT_VOICE = "priya"


@dataclass(frozen=True, slots=True)
class Voice:
    id: str
    label: str
    gender: str  # 'female' | 'male'
    #: One-line character note shown under the picker.
    note: str


VOICES: tuple[Voice, ...] = (
    Voice("priya", "Priya", "female", "Warm and bright — the default"),
    Voice("ritu", "Ritu", "female", "Soft and quick"),
    Voice("kavya", "Kavya", "female", "Clear and even"),
    Voice("shreya", "Shreya", "female", "Gentle, slightly lower"),
    Voice("simran", "Simran", "female", "Light and fast"),
    Voice("suhani", "Suhani", "female", "Calm and measured"),
    Voice("shubh", "Shubh", "male", "Crisp and neutral"),
    Voice("aditya", "Aditya", "male", "Deeper, unhurried"),
    Voice("rahul", "Rahul", "male", "Conversational"),
    Voice("dev", "Dev", "male", "Steady and low"),
)

_BY_ID = {voice.id: voice for voice in VOICES}


def resolve(voice_id: str | None) -> Voice:
    return _BY_ID.get((voice_id or "").strip().lower(), _BY_ID[DEFAULT_VOICE])


def is_supported(voice_id: str | None) -> bool:
    return (voice_id or "").strip().lower() in _BY_ID


def match(spoken: str) -> Voice | None:
    """Resolve what the user said into a voice.

    Handles a name ("use Kavya") and a bare gender request ("can you use a
    girl's voice"), which is how this is actually asked for out loud.
    """
    raw = spoken.strip().lower()
    if not raw:
        return None
    if raw in _BY_ID:
        return _BY_ID[raw]

    for voice in VOICES:
        if voice.label.lower() == raw:
            return voice

    female_words = ("female", "girl", "woman", "lady", "she", "her")
    male_words = ("male", "boy", "man", "guy", "he", "him")
    if any(word in raw for word in female_words):
        return _BY_ID[DEFAULT_VOICE]
    if any(word in raw for word in male_words):
        return _BY_ID["shubh"]

    # Fall back to a name appearing anywhere in the phrase.
    for voice in VOICES:
        if voice.id in raw:
            return voice
    return None
