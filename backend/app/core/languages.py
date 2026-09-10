"""Supported spoken languages.

Sarvam's TTS accepts a fixed set of BCP-47 codes; STT is always run in
auto-detect mode (see `providers.sarvam`), because forcing a language mangles
input spoken in a different one — measured: English audio forced to `te-IN`
transliterates into Telugu script instead of transcribing.

So the selected language governs *output* only: which language JARVIS replies
and speaks in. The user can still speak whatever they like.
"""

from __future__ import annotations

from dataclasses import dataclass

#: Passed to STT so it identifies the language itself.
AUTO_DETECT = "unknown"

DEFAULT_LANGUAGE = "en-IN"


#: Indic speech renders markedly longer than the equivalent English sentence —
#: measured on bulbul:v3, the same reply took 3.67s in `en-IN` and 5.55s in
#: `te-IN`, about 50% more. A flat pace therefore *sounds* sluggish in Telugu
#: even when it is fine in English, so pace is a per-language property.
#: These are deliberately short of "fast": 1.5 is comically rushed.
_INDIC_PACE = 1.18


@dataclass(frozen=True, slots=True)
class Language:
    code: str
    #: English name, for the UI and logs.
    label: str
    #: Endonym, shown in the picker so a Telugu speaker sees "తెలుగు".
    native: str
    #: How to instruct the model to write it.
    directive: str
    #: TTS speaking rate for this language.
    pace: float = _INDIC_PACE


LANGUAGES: tuple[Language, ...] = (
    Language("en-IN", "English", "English", "English", pace=1.04),
    Language("te-IN", "Telugu", "తెలుగు", "Telugu, in Telugu script", pace=1.20),
    Language("hi-IN", "Hindi", "हिन्दी", "Hindi, in Devanagari script"),
    Language("ta-IN", "Tamil", "தமிழ்", "Tamil, in Tamil script"),
    Language("kn-IN", "Kannada", "ಕನ್ನಡ", "Kannada, in Kannada script"),
    Language("ml-IN", "Malayalam", "മലയാളം", "Malayalam, in Malayalam script"),
    Language("mr-IN", "Marathi", "मराठी", "Marathi, in Devanagari script"),
    Language("bn-IN", "Bengali", "বাংলা", "Bengali, in Bengali script"),
    Language("gu-IN", "Gujarati", "ગુજરાતી", "Gujarati, in Gujarati script"),
    Language("pa-IN", "Punjabi", "ਪੰਜਾਬੀ", "Punjabi, in Gurmukhi script"),
    Language("od-IN", "Odia", "ଓଡ଼ିଆ", "Odia, in Odia script"),
)

_BY_CODE = {language.code: language for language in LANGUAGES}


def resolve(code: str | None) -> Language:
    return _BY_CODE.get((code or "").strip(), _BY_CODE[DEFAULT_LANGUAGE])


def is_supported(code: str | None) -> bool:
    return (code or "").strip() in _BY_CODE


def reply_reminder(code: str | None) -> str | None:
    """A terse restatement injected immediately before generation.

    The full directive lives in the system prompt, but by generation time it is
    behind the entire conversation — and models mirror whatever language the
    user just used. Measured: with the directive alone, a Telugu session
    silently reverted to English the moment the user typed an English sentence.
    Repeating the rule adjacent to the generation point is what actually holds.
    """
    language = resolve(code)
    if language.code == DEFAULT_LANGUAGE:
        # English needs this as much as any other language, and for a while did
        # not get it. Returning None meant the only language instruction in an
        # English session was one line at the top of the system prompt, behind
        # the whole conversation, while every other language also got a
        # restatement here. The asymmetry failed exactly where the docstring
        # predicts: an English session answered an English question in Telugu.
        return (
            "Reminder: reply in English, even if the user just spoke Telugu, "
            "Hindi or anything else. Do not mirror the user's language."
        )
    return (
        f"Reminder: reply in {language.directive}, even though the user may have "
        "just spoken English. Keep names, class titles, times and numbers in "
        "English — write times and counts as English words ('seven thirty PM', "
        "'three tasks'), never in "
        f"{language.label} words or {language.label} digits. "
        "Do not mirror the user's language."
    )


def reply_directive(code: str | None) -> str:
    """The system-prompt clause that sets the reply language.

    For non-English languages this asks for a code-mixed register: the natural
    way bilingual speakers actually talk, and the only way times and course
    names stay intelligible. Transliterating "C Learning Session" into Telugu
    script makes it *harder* to understand, not easier.
    """
    language = resolve(code)
    if language.code == DEFAULT_LANGUAGE:
        return (
            "# Language\n"
            "Reply in English. Use natural Indian-English phrasing.\n\n"
            "**This holds no matter which language the user speaks.** They will "
            "sometimes greet you or talk to you in Telugu, Hindi or another "
            "language — that is normal, and it is NOT a request to switch. Keep "
            "replying in English until they explicitly ask you to change, at "
            "which point call `set_language`. Do not mirror the user's language."
        )

    return (
        "# Language\n"
        f"Reply in {language.directive}. This is spoken aloud, so write it the "
        "way a bilingual speaker actually talks, not the way a textbook would.\n\n"
        f"**This holds no matter which language the user speaks.** They will "
        f"often talk to you in English — that is normal and expected, and it is "
        f"NOT a request to switch. Keep replying in {language.label} until they "
        "explicitly ask you to change, at which point call `set_language`. Do "
        "not mirror the user's language.\n\n"
        "Keep the following in English and Latin script, inline, never "
        "translated or transliterated:\n"
        "- names of classes, subjects, people, places and apps\n"
        "- clock times, dates, and all numbers\n"
        "- technical terms that are normally said in English\n\n"
        "Everything else — the connecting words, verbs, and your own phrasing — "
        f"goes in {language.label}.\n\n"
        "**Numbers are spoken aloud, so write them as English words, not "
        "digits**: 'seven thirty PM' not '7:30 PM', 'three tasks' not '3 tasks', "
        f"'Monday' not 'సోమవారం'. A digit gets read out in {language.label}, "
        "which is exactly what the user does not want.\n\n"
        "Example of the register (Telugu):\n"
        "  అవును సర్, ఈ రోజు సాయంత్రం C Learning Session ఉంది, seven thirty PM కి. "
        "అది skill class కాబట్టి, work ఉంటే skip చేయొచ్చు."
    )
