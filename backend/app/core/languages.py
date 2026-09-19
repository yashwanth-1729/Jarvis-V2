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

#: The one non-English language with an optional local (Piper) voice. See
#: `PREF_TELUGU_TTS_ENGINE` in `app.db.crud` and `_provider_for` in
#: `app.services.speech`.
TELUGU_LANGUAGE = "te-IN"

#: Under the cloud voice stack (`JARVIS_VOICE_STACK=cloud`), Hindi is routed
#: to Kokoro (`get_hindi_tts_provider`) same as English, rather than Sarvam.
#: Under the legacy stack this constant is unused -- Hindi stays plain Sarvam
#: like every other non-English, non-Telugu-opt-in language.
HINDI_LANGUAGE = "hi-IN"


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


#: What the natural code-mixed register is called, for the prompt.
_MIX_NAME = {
    "te-IN": "Tenglish -- Telugu mixed with English",
    "hi-IN": "Hinglish -- Hindi mixed with English",
}

#: Worked examples of the register plus formal words to avoid. Written after a
#: native speaker said Telugu replies felt "over Telugu", bookish, and used
#: complicated Telugu words where people just say the English word.
_REGISTER_EXAMPLES = {
    "te-IN": (
        "\n## Sounds like this\n"
        "  Okay boss, tomorrow morning nine కి అమ్మకి call చేయమని reminder set చేశా.\n"
        "  ఈ రోజు మీకు three tasks ఉన్నాయి boss, అందులో physics assignment important.\n"
        "  Evening seven thirty కి C class ఉంది. Free గా లేకపోతే skip చేయొచ్చు.\n"
        "  Done boss, ఆ task delete చేశా.\n"
        "## Not like this (formal / bookish) -> say this instead\n"
        "  గుర్తు చేస్తాను -> reminder set చేశా · సమావేశం -> meeting · సమయం -> time · "
        "ఉదయం / సాయంత్రం -> morning / evening · ఖాళీగా -> free గా · "
        "కార్యక్రమం -> program · చేయబడింది -> చేశా · ఉన్నది -> ఉంది · సర్ -> boss\n"
    ),
    "hi-IN": (
        "\n## Sounds like this\n"
        "  Okay boss, कल morning nine बजे mom को call करने का reminder set कर दिया.\n"
        "  आज आपके three tasks हैं boss, सबसे important physics assignment है.\n"
        "  Evening seven thirty को C class है. Free नहीं हो तो skip कर सकते हो.\n"
        "  Done boss, वो task delete कर दिया.\n"
        "## Not like this (formal / bookish) -> say this instead\n"
        "  स्मरण कराऊँगा -> reminder set कर दिया · बैठक -> meeting · कार्य -> task · "
        "समय सारणी -> schedule · दूरभाष -> phone · कृपया -> (drop it) · "
        "किया गया है -> कर दिया · श्रीमान -> boss\n"
    ),
}


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
        f"Reminder: reply in casual spoken {language.label} ({language.directive}) "
        f"-- the code-mixed way people actually talk "
        f"({_MIX_NAME.get(language.code, 'mixed with English')}), even though the "
        "user may have just spoken English. Everyday words people normally say in "
        "English stay English, in Latin script (reminder, task, meeting, call, "
        f"time, morning, free, done, check). Only the grammar glue is {language.label}. "
        f"{language.label} parts in {language.label} script only -- not romanized, and "
        "never letters from any other script. "
        "Short, simple spoken sentences; no formal or bookish words. Times and "
        "counts as English words ('seven thirty PM', 'three tasks'), never digits. "
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

    mix = _MIX_NAME.get(language.code, f"{language.label} mixed with English")
    return (
        "# Language\n"
        f"Reply in {language.directive}, in the **casual, code-mixed way people "
        f"actually talk** ({mix}) -- like a friend from the city speaking "
        "out loud, never a news reader, a textbook, or a translation.\n\n"
        f"**This holds no matter which language the user speaks.** They will "
        f"often talk to you in English -- that is normal and NOT a request to "
        f"switch. Keep replying in {language.label} until they explicitly ask to "
        "change, then call `set_language`. Do not mirror the user's language.\n\n"
        "## Which words stay English (Latin script, inline)\n"
        "- Any everyday word people normally say in English: reminder, task, "
        "schedule, meeting, class, call, phone, message, time, morning, evening, "
        "weekend, free, busy, done, okay, sure, check, update, add, delete, set, "
        "plan, important, boss.\n"
        "- Names of classes, subjects, people, places and apps.\n"
        "- Clock times, dates and all numbers.\n\n"
        f"Only the grammar glue is {language.label}: verb endings, case endings, "
        "connectors, pronouns. If a young person would say the English word, use "
        f"the English word -- never swap it for a pure or literary {language.label} "
        "word.\n\n"
        "## Grammar\n"
        "Short, simple, spoken sentences. Everyday verb forms, not formal or "
        "written ones. If a sentence sounds like it came out of a translator, "
        "rewrite it the way you would say it.\n\n"
        "## Script (read aloud by a voice, so this matters)\n"
        f"- The {language.label} parts are always in {language.label} script -- never "
        f"romanized {language.label} in English letters (a voice mispronounces it).\n"
        "- The English words are in English letters.\n"
        "- Never any third script: no Hindi, Bengali, Tamil or other letters "
        f"inside a {language.label} reply.\n\n"
        "**Numbers are spoken aloud, so write them as English words, not "
        "digits**: 'seven thirty PM' not '7:30 PM', 'three tasks' not '3 tasks'. "
        f"A digit gets read out in {language.label}.\n"
        + _REGISTER_EXAMPLES.get(language.code, "")
    )
