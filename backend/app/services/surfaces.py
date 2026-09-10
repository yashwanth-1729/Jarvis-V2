"""Which instrument panel a request is asking for.

The first version of this hung the panels off tool calls, on the reasoning that
the model reaching for a tool *is* the intent signal. That is true for weather,
which genuinely requires a lookup. It is wrong for everything the model already
has: the state block carries the whole task board and timetable, so asked "what
do I have tomorrow" the model simply answers, correctly, without calling
anything. Measured on the live transcript:

    "What's the weather in Nellore?"  -> get_weather   -> panel
    "What do I have tomorrow?"        -> no tool call  -> nothing
    "What tasks do I have today?"     -> no tool call  -> nothing

Forcing a tool call would have fixed the panel by making the answer slower and
no better -- a round trip to fetch data already in the prompt.

So intent is read here instead, from the user's own words, before the model runs
at all. That is free, deterministic, and it means the panel opens *while* JARVIS
is still thinking rather than after it has finished talking. Tools can still
name a surface themselves (weather does); this covers the rest.

Deliberately keyword matching rather than a classifier model. It runs on every
turn on the latency path, and a wrong panel is a cheap mistake -- the user
closes it -- while a second of added delay on every single turn is not.
"""

from __future__ import annotations

import re
from typing import Literal

Surface = Literal["tasks", "schedule", "memory", "weather"]

#: Ordered: the first pattern to match wins. Weather is first because "what's
#: on today" and "what's it like today" collide, and the weather reading is the
#: one with a distinctive vocabulary.
_RULES: list[tuple[Surface, re.Pattern[str]]] = [
    # Explicit recall wins over whatever it is recall *about*. "What do you
    # remember about my schedule" opened the timeline, because `schedule`
    # matched before `remember` -- but the question is about what is stored,
    # not about Tuesday. The subject is the noun; the verb is the intent.
    (
        "memory",
        re.compile(
            r"\b(what do you (?:remember|know)|do you remember|"
            r"remind me what|what have you (?:stored|saved)|"
            r"what did i tell you)\b",
            re.I,
        ),
    ),
    (
        "weather",
        re.compile(
            r"\b(weather|temperature|forecast|rain|rains|raining|rainy|snow|"
            r"humid|humidity|"
            r"sunny|cloudy|storm|jacket|umbrella|how (?:hot|cold|warm))\b",
            re.I,
        ),
    ),
    # Tasks before schedule, deliberately. "What tasks do I have today?"
    # contains "do i have ... today", which the schedule rule below also
    # matches — and it was winning, opening a timeline for a question about the
    # board. An explicit noun ("tasks", "deadlines") is a stronger signal than
    # a date word, so it gets first refusal.
    (
        "tasks",
        re.compile(
            r"\b(tasks?|to-?dos?|todo|deadlines?|due|overdue|pending|"
            r"what (?:do i|should i|must i) (?:need to )?do|"
            r"my (?:work|list|board)|priorit(?:y|ies))\b",
            re.I,
        ),
    ),
    (
        "schedule",
        re.compile(
            r"\b(schedule|timetable|calendar|classes?|lecture|agenda|"
            # The apostrophe is optional throughout: speech-to-text writes
            # "whats on today", and so does anyone typing quickly.
            r"what(?:'?s| is| do i have)?\s+(?:on|up)\b|"
            r"free time|busy|appointments?|meetings?|"
            r"(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|"
            r"saturday|sunday)\b.*\b(plan|on|schedule|classes)|"
            r"what.*\b(?:do i have|have i got)\b.*\b(?:tomorrow|today|this week))",
            re.I,
        ),
    ),
    (
        "memory",
        re.compile(
            r"\b(remember|memor(?:y|ies)|recall|what do you know|"
            r"notes?|ideas?|stored|saved)\b",
            re.I,
        ),
    ),
]

#: Requests that are asking JARVIS to *change* something rather than show it.
#: "add a task" should not throw the board up on screen -- the row simply
#: appears where it already was. Only questions open an instrument.
_MUTATING = re.compile(
    r"^\s*(add|create|make|new|set|delete|remove|clear|cancel|update|change|"
    r"rename|move|mark|complete|finish|schedule\s+a|remind)\b",
    re.I,
)


#: Which day a schedule question is about, as an offset from today.
#:
#: Asking "what do I have tomorrow" and being shown today is the kind of small
#: wrongness that makes an interface feel like it is not listening. The panel
#: has a day selector; this decides where it starts.
_DAY_WORDS: list[tuple[int, re.Pattern[str]]] = [
    (1, re.compile(r"\btomorrow\b", re.I)),
    (0, re.compile(r"\btoday|tonight|this (?:morning|afternoon|evening)\b", re.I)),
]

_WEEKDAYS = [
    "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
]


def _day_offset(text: str, weekday_today: int) -> int | None:
    for offset, pattern in _DAY_WORDS:
        if pattern.search(text):
            return offset
    for index, name in enumerate(_WEEKDAYS):
        if re.search(rf"\b{name}\b", text, re.I):
            # The next occurrence of that weekday, today included.
            return (index - weekday_today) % 7
    return None


def detect(message: str, weekday_today: int = 0) -> dict[str, object] | None:
    """The panel this message is asking for, or None to leave the screen alone.

    Returns the surface name plus anything the panel needs to open in the right
    state -- for a schedule question, which day was meant.

    None is the common case and the right default. Most turns are conversation,
    and a screen that reshapes itself on every sentence is worse than one that
    never does.
    """
    text = (message or "").strip()
    if not text or _MUTATING.match(text):
        return None

    for surface, pattern in _RULES:
        if not pattern.search(text):
            continue
        found: dict[str, object] = {"kind": surface}
        if surface == "schedule":
            offset = _day_offset(text, weekday_today)
            if offset is not None:
                found["day"] = offset
        return found
    return None
