"""Deterministic identity/introduction intent, handled before the LLM runs.

JARVIS should always answer "who are you" / "what are you" / "who made you"
the same documented way -- not whatever the model happens to improvise this
turn, and not a second slower than it has to be. Regex intent classification
ahead of the model already has precedent here: see `app.services.surfaces`,
which reads panel intent from the user's own words before the model runs, for
exactly the same reason -- it runs on every single turn on the latency path,
so it has to be free, and a wrong (or missed) call is a cheap mistake, not a
correctness one. A missed identity match here just means the model answers
"who are you" itself, which it already can; there is no failure mode where
the user gets nothing.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Callable

#: The one and only source of truth for JARVIS's self-introduction. Every
#: caller that matches the `identity` intent gets this text verbatim -- never
#: regenerated or paraphrased by the model -- so the answer to "who are you"
#: reads the same tonight as it did this morning. Change it here and nowhere
#: else.
JARVIS_INTRODUCTION = """Who am I?
Well…
I'm Jarvis.
Personal assistant, second brain, idea partner, professional overthinker… and part-time supervisor of questionable human decisions.
I listen.
I understand.
I remember.
I help you think.
And when possible…
I actually get things done.
I was built from the ground up by Yashwanth Cherukuru, founder of Yashwanth Builds.
His plan?
Build an intelligence that makes the words "personal assistant" feel like an understatement.
My plan?
Make sure he doesn't regret giving me a voice.
I'm Jarvis.
Nice to meet you."""


@dataclass(frozen=True)
class SpecialIntent:
    """One deterministic, pre-LLM shortcut: a matcher and its fixed reply.

    Adding another canned intent later -- capabilities, creator/founder info,
    privacy explanation, help mode, demo mode -- means appending one more
    entry to `_INTENTS` below and nothing else in the agent loop changes;
    `run_turn` only ever asks "does anything match" and speaks whatever comes
    back.
    """

    name: str
    matches: Callable[[str], bool]
    response: str


# Continuations that turn "who/what ... are you" from a question about
# JARVIS's own nature into a question about something else entirely -- what
# it's doing right now, who it's talking to, what it's planning. Checked as a
# negative lookahead so the identity patterns below never fire on these.
# Not exhaustive by design, same reasoning as `surfaces.py`'s _MUTATING list:
# it only has to cover the shapes real speech actually takes.
_NOT_IDENTITY_FOLLOWUP = (
    r"doing|working|thinking|saying|looking|talking|calling|referring|"
    r"speaking|meeting|seeing|going|waiting|planning|trying|up\b"
)

#: Optional single adverb between the question word and the copula --
#: "who *exactly* are you", "what *actually* are you". A small fixed set
#: rather than `\w+`, so this can never drift into matching some unrelated
#: question that merely happens to have one word sitting there.
_ADVERB = r"(?:exactly|really|actually|precisely|literally)?\s*"

_IDENTITY_PATTERNS: tuple[re.Pattern[str], ...] = (
    # "who are you", "who exactly are you" -- not "who are you calling" /
    # "...talking about" / etc., which ask about someone else, not JARVIS.
    re.compile(
        rf"\bwho\s+{_ADVERB}are\s+you\b(?!\s*(?:{_NOT_IDENTITY_FOLLOWUP}))",
        re.I,
    ),
    # "what are you", "what exactly are you" -- not "what are you doing" /
    # "...working on" / "...thinking about" / etc., which ask about the
    # current moment, not JARVIS's nature.
    re.compile(
        rf"\bwhat\s+{_ADVERB}are\s+you\b(?!\s*(?:{_NOT_IDENTITY_FOLLOWUP}))",
        re.I,
    ),
    # "who you are", as in "tell me who you are" / "can you tell me who you
    # are" -- the reordered form the two direct patterns above don't reach.
    re.compile(r"\bwho\s+you\s+are\b(?!\s*(?:talking|calling|referring))", re.I),
    # "what is jarvis", "what exactly is jarvis" -- anchored to "jarvis" by
    # name, not just "is" plus any noun, so "what is artificial intelligence"
    # is never in scope.
    re.compile(rf"\bwhat\s+{_ADVERB}is\s+jarvis\b", re.I),
    # "what kind of assistant are you" -- its own pattern because "what"
    # isn't directly followed by "are you" here, so the general rule above
    # doesn't reach it.
    re.compile(r"\bwhat\s+kind\s+of\s+assistant\s+are\s+you\b", re.I),
    # "introduce yourself", "tell me about yourself".
    re.compile(r"\b(?:introduce\s+yourself|tell\s+me\s+about\s+yourself)\b", re.I),
    # "who made/built/created/designed/developed/programmed you/jarvis" --
    # anchored to "you" or "jarvis" specifically, so "who created Python" or
    # "who created Linux" never matches; the object has to be JARVIS itself.
    re.compile(
        r"\bwho\s+(?:made|built|created|designed|developed|programmed)\s+"
        r"(?:you|jarvis)\b",
        re.I,
    ),
)


def _is_identity_question(text: str) -> bool:
    return any(pattern.search(text) for pattern in _IDENTITY_PATTERNS)


_INTENTS: tuple[SpecialIntent, ...] = (
    SpecialIntent("identity", _is_identity_question, JARVIS_INTRODUCTION),
)


def detect_special_intent(text: str) -> SpecialIntent | None:
    """The canned intent this turn matches, or None to fall through to the LLM.

    None is the common case and the safe default: a missed detection costs
    nothing but a slightly less on-brand answer, since the model can already
    answer "who are you" itself. A false match is the real risk, which is why
    every pattern above is anchored to JARVIS/"you" specifically and excludes
    the obvious unrelated-question shapes ("who are you calling", "what are
    you doing").
    """
    stripped = (text or "").strip()
    if not stripped:
        return None
    for intent in _INTENTS:
        if intent.matches(stripped):
            return intent
    return None
