"""The JARVIS agent loop.

Streams a single user turn to completion: text deltas, reasoning, tool
executions and their results all come back as a flat sequence of events that
the API layer forwards to the browser as SSE.

The loop is provider-neutral — it speaks the OpenAI-shaped message format
defined in `app.providers.base` and never imports a vendor SDK directly, so
switching chat providers (v3) touches only the provider module.

Two robustness properties matter here:

* **Never leaves a dangling tool call.** Every ``tool_call`` the model emits
  gets exactly one matching ``tool`` message, even when the handler throws,
  because ``execute_tool`` converts failures into error outcomes.
* **Never replays a broken history.** Slicing a conversation mid tool-cycle
  would leave a ``tool`` message with no preceding ``tool_calls``, which the
  API rejects — so history is trimmed at safe boundaries only.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any, AsyncIterator

from app.core.config import settings
from app.core.languages import reply_directive, reply_reminder
from app.core.timeutil import now
from app.db import crud
from app.llm.prompts import (
    CONTEXT_PREAMBLE,
    SYSTEM_PROMPT,
    VOICE_SYSTEM_PROMPT,
    VOICE_TURN_REMINDER,
)
from app.llm.tools import execute_tool, openai_tools, tool_requires_arguments
from app.llm.tools_system import SYSTEM_TOOLS_GUIDANCE, environment_note
from app.providers import get_chat_provider
from app.providers.base import ProviderError
from app.services.context import build_context_snapshot
from app.services import memory as memory_service
from app.services import surfaces

logger = logging.getLogger("jarvis.agent")


# ---------------------------------------------------------------------------
# History
# ---------------------------------------------------------------------------

def _has_tool_role(message: dict[str, Any]) -> bool:
    return message.get("role") == "tool"


def _trim_to_safe_boundary(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Drop leading messages until the history starts on a real user turn.

    A ``tool`` message whose originating ``tool_calls`` were trimmed away is a
    400 from any OpenAI-compatible endpoint.
    """
    for index, message in enumerate(messages):
        if message.get("role") == "user" and not _has_tool_role(message):
            return messages[index:]
    return []


def _close_interrupted_tool_cycles(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Stop a later user turn from being treated as continuation of a failed tool run.

    If the provider fails after tools have returned, persisted history ends in a
    ``tool`` message with no final assistant response. The next real user
    message otherwise lands directly after those results, and the model often
    resumes the old batch instead of answering the new request.
    """
    closed: list[dict[str, Any]] = []
    for message in messages:
        if message.get("role") == "user" and closed and _has_tool_role(closed[-1]):
            closed.append(
                {
                    "role": "assistant",
                    "content": "The previous tool turn was interrupted before completion.",
                }
            )
        closed.append(message)
    if closed and _has_tool_role(closed[-1]):
        closed.append(
            {
                "role": "assistant",
                "content": "The previous tool turn was interrupted before completion.",
            }
        )
    return closed


def _repair_tool_arguments(message: dict[str, Any]) -> dict[str, Any]:
    """Normalize any stored tool-call arguments so the turn survives replay.

    Belt-and-braces for history written before arguments were normalized on the
    write path: a single malformed blob otherwise 400s every future request in
    the conversation, with no way out but clearing the transcript.
    """
    calls = message.get("tool_calls")
    if not isinstance(calls, list):
        return message

    repaired = []
    for call in calls:
        function = dict(call.get("function") or {})
        parsed, error = _parse_arguments(function.get("arguments") or "")
        if error is not None:
            logger.warning(
                "Repairing malformed stored arguments for tool %r", function.get("name")
            )
        function["arguments"] = json.dumps(parsed if parsed is not None else {})
        repaired.append({**call, "function": function})

    return {**message, "tool_calls": repaired}


#: A reply that opens by announcing the clock.
#:
#: Matches "Sir, the time is 8:51 PM.", "బాస్, ఇప్పుడు time eight fifty one PM."
#: and the variants in between: an optional address, an optional "now" in any
#: of the supported scripts, the word for time, the clock itself, and the stop
#: that ends the clause. Anchored to the start, so a time mentioned mid-answer
#: — which is usually the answer — is untouched.
_TIME_OPENER = re.compile(
    r"^\s*(?:[^\s,.।]{1,12}[,،]\s*)?"          # बॉस, / బాస్, / Sir,
    r"(?:ఇప్పుడు|అప్పుడు|अभी|इस समय|now|right now)?\s*"
    r"(?:the\s+)?(?:time|టైం|టైమ్|समय|వేళ)\s*"
    r"(?:is\s+)?"
    r"[^.।\n]{0,40}?"                            # eight fifty one
    r"(?:AM|PM|am|pm|ఏఎం|పీఎం)"
    # Whatever finishes the clause after the meridiem. Telugu puts the verb
    # last -- "time nine PM అయింది." -- so requiring the stop immediately after
    # PM matched the English shape and silently missed every Telugu one, which
    # is the shape it actually speaks in.
    r"[^.।\n]{0,24}"
    r"[.।]\s*",
    re.IGNORECASE,
)


#: Words that make a question about the clock, across the languages spoken here.
_ASKED_THE_TIME = re.compile(
    r"\b(time|clock|o'?clock)\b|టైం|టైమ్|వేళ|గంట|समय|टाइम|वक्त",
    re.IGNORECASE,
)


def strip_time_opener(text: str) -> str:
    """Remove a leading clock announcement, keeping the rest of the reply.

    Returns the text unchanged when stripping would empty it -- whether that is
    right depends on what was asked, which this cannot see. `_load_history`
    decides, because it can.
    """
    stripped = _TIME_OPENER.sub("", text, count=1)
    return stripped if stripped.strip() else text


def is_clock_only(text: str) -> bool:
    """True when the message is a clock announcement and nothing else."""
    return bool(text.strip()) and not _TIME_OPENER.sub("", text, count=1).strip()


#: Unicode blocks for the scripts this assistant actually replies in.
_SCRIPTS = {
    "telugu": (0x0C00, 0x0C7F),
    "devanagari": (0x0900, 0x097F),
    "tamil": (0x0B80, 0x0BFF),
    "kannada": (0x0C80, 0x0CFF),
    "malayalam": (0x0D00, 0x0D7F),
    "bengali": (0x0980, 0x09FF),
    "gujarati": (0x0A80, 0x0AFF),
    "gurmukhi": (0x0A00, 0x0A7F),
    "odia": (0x0B00, 0x0B7F),
}


def dominant_script(text: str) -> str:
    """Which language a reply is written in, judged by script presence.

    Not by majority. Replies in an Indian language are deliberately code-mixed
    -- names, times, room numbers and technical words stay in English so they
    stay intelligible aloud -- so the Latin characters routinely outnumber the
    Telugu ones in a reply that is unmistakably Telugu. Measured on a real one:

        "బాస్, Nellore లో 26.9 degrees ఉంది"   ->  majority says latin

    The reverse never occurs: an English reply contains no Telugu at all. So
    presence of an Indic script decides, with a small floor so that a single
    stray glyph in an otherwise English sentence does not flip the verdict.
    """
    latin = 0
    indic: dict[str, int] = {}

    for character in text:
        if not character.isalpha():
            continue
        point = ord(character)
        if point < 0x0250:
            latin += 1
            continue
        for name, (low, high) in _SCRIPTS.items():
            if low <= point <= high:
                indic[name] = indic.get(name, 0) + 1
                break

    if indic:
        script = max(indic, key=lambda key: indic[key])
        letters = latin + sum(indic.values())
        # A handful of characters, or a tenth of the letters — either is far
        # more than an English sentence ever contains, and far less than a
        # code-mixed reply falls below.
        if indic[script] >= 3 or (letters and indic[script] / letters >= 0.10):
            return script

    if latin:
        return "latin"
    return "unknown"


#: What each reply language should look like on the page.
_LANGUAGE_SCRIPT = {
    "en": "latin",
    "te": "telugu",
    "hi": "devanagari",
    "ta": "tamil",
    "kn": "kannada",
    "ml": "malayalam",
    "bn": "bengali",
    "gu": "gujarati",
    "pa": "gurmukhi",
    "or": "odia",
    "mr": "devanagari",
}


def language_switch_note(
    language: str | None, history: list[dict[str, Any]]
) -> str | None:
    """A line naming the switch, when the script is about to change.

    None on the overwhelming majority of turns, which is the point: this only
    exists to break a precedent, and there is no precedent to break unless the
    last reply was in a different script from the next one.
    """
    if not language:
        return None
    wanted = _LANGUAGE_SCRIPT.get(language.split("-")[0].lower())
    if wanted is None:
        return None

    for message in reversed(history):
        if message.get("role") != "assistant":
            continue
        content = message.get("content")
        if isinstance(content, list):
            content = " ".join(
                block.get("text", "")
                for block in content
                if isinstance(block, dict) and block.get("type") == "text"
            )
        if not isinstance(content, str) or not content.strip():
            continue
        was = dominant_script(content)
        if was == "unknown" or was == wanted:
            return None
        return (
            f"LANGUAGE CHANGED. Your previous replies in this conversation were "
            f"in {was}; that has ended. Reply in {language} from now on, and do "
            f"not copy the language of the turns above — they are the old "
            f"setting, not an example to follow."
        )
    return None


async def _load_history() -> list[dict[str, Any]]:
    """Replay the conversation, without replaying its bad habits.

    Assistant turns are cleaned of a leading time announcement before they go
    back to the model, and this is not cosmetic -- it is the fix for a failure
    that made JARVIS look broken.

    Observed on the device: asked "జార్విస్ టైం ఎంత?" (what is the time), the
    reply was the time *plus* an unasked weather report. Asked nothing at all --
    just "Okay." -- the reply was the time plus the user's class. Every turn
    opened with the clock and several ended with the same 81-character weather
    sentence, repeated verbatim across turns, with no tool call behind it.

    The prompt already forbids all of this. The prompt was losing, because a
    rule competes against forty rows of history in which every single assistant
    message is shaped exactly that way, and demonstrated format beats stated
    format. The model was not ignoring instructions so much as imitating
    itself.

    So the pattern is removed from what it imitates. The instruction stays as
    well -- see VOICE_TURN_REMINDER -- but it no longer has to win an argument
    against the evidence.
    """
    rows = await crud.recent_chat_messages(settings.jarvis_history_limit)
    messages: list[dict[str, Any]] = []
    for row in rows:
        payload = row.get("blocks")
        # Rows written by an earlier provider format are skipped rather than
        # replayed into a shape the current provider cannot parse.
        if isinstance(payload, dict) and payload.get("role"):
            messages.append(_repair_tool_arguments(_clean_assistant_turn(payload)))
        elif row["text"].strip():
            text = row["text"]
            if row["role"] == "assistant":
                text = strip_time_opener(text)
            messages.append({"role": row["role"], "content": text})
    return _trim_to_safe_boundary(
        _close_interrupted_tool_cycles(_defuse_clock_only_replies(messages))
    )


#: Stands in for a reply that was nothing but the clock, when nobody asked.
_WITHDRAWN = "(no answer was given)"


def _defuse_clock_only_replies(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Neutralise replies that were *only* a time announcement, unprompted.

    `strip_time_opener` leaves a message alone when removing the clock would
    empty it, on the reasoning that the clock must have been the answer. That
    reasoning is right for "what time is it" and exactly backwards everywhere
    else -- and everywhere else is where it kept firing.

    Measured on the device, after the stripper was already live:

        user       delete all the tasks I created today
        assistant  బాస్, ఇప్పుడు time ten fifty nine PM, Tuesday 25 August 2026.
        user       delete the tasks named "fix the tax return"
        assistant  బాస్, ఇప్పుడు time eleven twelve PM, Tuesday 25 August 2026.

    Those are pure clock announcements, so the guard preserved them verbatim --
    which meant the history the model imitated still contained four flawless
    demonstrations of "answer anything at all with the time". The guard was
    protecting the worst examples in the file.

    Whether the clock was a legitimate answer depends on the question, so the
    question is what decides: a preceding user turn that mentions the time
    keeps its reply, and one that does not has it withdrawn. Replaced rather
    than deleted, so the user/assistant alternation the provider expects stays
    intact.
    """
    for index, message in enumerate(messages):
        if message.get("role") != "assistant":
            continue
        content = message.get("content")
        if not isinstance(content, str) or not is_clock_only(content):
            continue

        asked = ""
        for earlier in reversed(messages[:index]):
            if earlier.get("role") == "user":
                asked = str(earlier.get("content") or "")
                break
        if not _ASKED_THE_TIME.search(asked):
            messages[index] = {**message, "content": _WITHDRAWN}
    return messages


def _clean_assistant_turn(message: dict[str, Any]) -> dict[str, Any]:
    """Strip the time opener from a block-structured assistant turn."""
    if message.get("role") != "assistant":
        return message
    content = message.get("content")
    if isinstance(content, str):
        return {**message, "content": strip_time_opener(content)}
    if not isinstance(content, list):
        return message

    blocks = []
    cleaned = False
    for block in content:
        if not cleaned and isinstance(block, dict) and block.get("type") == "text":
            blocks.append({**block, "text": strip_time_opener(str(block.get("text", "")))})
            cleaned = True
        else:
            blocks.append(block)
    return {**message, "content": blocks}


def _build_persona_message(
    voice: bool = False, language: str | None = None
) -> dict[str, Any]:
    """The byte-stable half of the prompt: who JARVIS is, and in what language.

    Deliberately contains nothing that changes between turns. Sarvam does
    automatic prefix caching -- no ``cache_control`` field, which it rejects
    outright (400: system content must be a plain string) -- so the only thing
    that earns a cache hit is a prefix that is identical byte for byte.

    The live state block used to be concatenated on here. Because it carries the
    clock, the system message differed every single turn, and since it sits
    ahead of the whole conversation it invalidated everything behind it.
    Measured against the live endpoint, two turns a minute apart:

        state inside this message : 0% cached, then 0% cached
        state moved to the tail   : 0% cached, then 92.7% cached

    That is the entire reason for the split, and it is what
    ``prompts.py`` has described from the start without it ever being wired up.
    """
    parts = [VOICE_SYSTEM_PROMPT if voice else SYSTEM_PROMPT]
    # Only spoken replies switch language; the text console stays in English.
    if voice:
        parts.append(reply_directive(language))
    # Where it is standing, when it can act on the machine. Constant for the
    # life of the process, so it does not disturb the cached prefix.
    if settings.system_tools_enabled:
        parts.append(SYSTEM_TOOLS_GUIDANCE)
        parts.append(environment_note())
    return {"role": "system", "content": "\n\n".join(parts)}


#: Words that make the week itself the subject.
#:
#: Only these turns carry the full weekly grid in the state block. Everything
#: else gets today's blocks and a note saying the week is a tool call away —
#: which is what stops an unrelated question being answered with a timetable.
_ABOUT_SCHEDULE = re.compile(
    r"\b(schedule|timetable|class|classes|lecture|lab|practical|routine|"
    r"week|weekly|monday|tuesday|wednesday|thursday|friday|saturday|sunday|"
    r"tomorrow|today|holiday|free|busy|session|college)\b"
    "|\u0936\u0947\u0921\u094d\u092f\u0942\u0932"          # शेड्यूल
    "|\u0915\u0915\u094d\u0937\u093e"                        # कक्षा
    "|\u0c37\u0c46\u0c21\u0c4d\u0c2f\u0c42\u0c32\u0c4d"   # షెడ్యూల్
    "|\u0c15\u0c4d\u0c32\u0c3e\u0c38\u0c4d"                 # క్లాస్
    "|\u0c30\u0c47\u0c2a\u0c41"                               # రేపు
    "|\u0c08\u0c30\u0c4b\u0c1c\u0c41"                        # ఈరోజు
    "|\u0c35\u0c3e\u0c30\u0c02"                               # వారం
    "|\u0c15\u0c3e\u0c32\u0c47\u0c1c\u0c4d",                # కాలేజ్
    re.IGNORECASE,
)


def wants_schedule(text: str) -> bool:
    """Whether the whole weekly grid is worth the space this turn."""
    return bool(_ABOUT_SCHEDULE.search(text or ""))


#: Real reasoning-shaped requests: compare, explain why, plan across
#: constraints, work something out. Deliberately narrow and English-anchored
#: -- most JARVIS turns are commands or lookups ("add a task", "what's my
#: schedule", "remind me at five"), which need none of this, and a classifier
#: that fires too eagerly defeats the point: it would add reasoning latency
#: to exactly the turns this exists to keep fast.
_REASONING_SHAPED = re.compile(
    r"\b("
    r"compar\w*|"
    r"why\b|"
    r"explain\b|"
    r"pros and cons|trade[- ]?offs?|"
    r"which (?:is|one|option) (?:is )?(?:better|best|worse)|"
    r"plan (?:my|a|out|the)|"
    r"figure out|work out|"
    r"calculat\w*|how much (?:in total|altogether)|"
    r"step[- ]by[- ]step|think (?:it |this )?through|in detail|thoroughly"
    r")\b",
    re.IGNORECASE,
)


def reasoning_effort_for(user_text: str) -> str | None:
    """Escalate reasoning only for turns that plausibly need it, at zero cost.

    Runs a regex over text already in hand -- no network call, no extra model
    round trip -- so this can never add latency to a turn it does not
    escalate. Conservative on purpose: the base rate is `False`, so the vast
    majority of turns (commands, lookups, small talk) pay nothing extra, and
    only a real match pays the cost reasoning genuinely costs. Returns
    ``None`` to mean "use the provider's own default" rather than repeating
    that default here, so a future config change does not need a matching
    edit in two places.
    """
    if _REASONING_SHAPED.search(user_text or ""):
        return "low"
    return None


async def _build_state_message(user_text: str = "") -> dict[str, Any]:
    """The volatile half: what is true right now.

    Rides at the tail, after the history, for two reasons. It keeps the cached
    prefix intact (see ``_build_persona_message``), and it puts the live state
    adjacent to the generation point, which is where the voice reminder already
    had to move for exactly the same reason -- a rule stated far above the
    conversation stops holding by the time the model answers.
    """
    snapshot = await build_context_snapshot(
        full_schedule=wants_schedule(user_text), user_text=user_text
    )
    return {"role": "system", "content": f"{CONTEXT_PREAMBLE}\n\n{snapshot}"}


def _parse_arguments(
    raw: str, tool_name: str | None = None
) -> tuple[dict[str, Any] | None, str | None]:
    """Parse a tool-call argument blob, returning (args, error).

    When a tool takes no required parameters, an unparseable blob degrades to
    ``{}`` rather than failing: models frequently emit junk arguments for
    zero-parameter tools, and rejecting the call would throw away an
    invocation whose intent is unambiguous.
    """
    lenient = tool_name is not None and not tool_requires_arguments(tool_name)

    if not raw or not raw.strip():
        return {}, None
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        if lenient:
            logger.info("Ignoring malformed arguments for no-arg tool %r", tool_name)
            return {}, None
        return None, f"arguments were not valid JSON ({exc.msg})"
    if not isinstance(parsed, dict):
        if lenient:
            return {}, None
        return None, "arguments must be a JSON object"
    return parsed, None


def _assistant_message(
    content: str, calls: list[tuple[Any, dict[str, Any] | None]]
) -> dict[str, Any]:
    """Serialize an assistant turn back into the wire format.

    ``arguments`` is re-serialized from the *parsed* value rather than echoed
    verbatim. A truncated or malformed argument blob (the model running out of
    budget mid-call, say) is rejected by the API on every subsequent request
    once it is in the history — which would poison the conversation
    permanently. Normalising here keeps the transcript replayable; the model
    still learns the call failed from its tool message.
    """
    message: dict[str, Any] = {"role": "assistant", "content": content or ""}
    if calls:
        message["tool_calls"] = [
            {
                "id": call.id,
                "type": "function",
                "function": {
                    "name": call.name,
                    "arguments": json.dumps(arguments if arguments is not None else {}),
                },
            }
            for call, arguments in calls
        ]
    return message


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

async def run_turn(
    user_message: str, *, voice: bool = False, language: str | None = None
) -> AsyncIterator[dict[str, Any]]:
    """Execute one user turn, yielding events as they happen.

    ``voice=True`` swaps in the spoken persona and the dialogue-tuned model, and
    caps the reply length — the transcript, tools and history are shared with
    text mode, so a conversation can move between the two.
    """
    user_text = user_message.strip()
    if not user_text:
        yield {"type": "error", "data": {"message": "Empty message."}}
        return

    user_payload = {"role": "user", "content": user_text}
    await crud.append_chat_message("user", user_text, user_payload)
    inferred_candidate = None
    try:
        inferred_candidate = await memory_service.capture_inferred_candidate(user_text)
    except Exception:  # noqa: BLE001 - learning must never block the actual answer
        logger.exception("Could not capture inferred memory candidate")

    # Emitted before the model runs, so the panel opens while JARVIS is still
    # thinking rather than after it has finished speaking. Hanging this off a
    # tool call did not work: the state block already carries the board and the
    # timetable, so the model answers "what do I have tomorrow" without calling
    # anything, and no panel ever appeared. Reading intent here costs nothing
    # and is faster than the answer it accompanies.
    wanted = surfaces.detect(user_text, weekday_today=now().weekday())
    if wanted:
        yield {"type": "surface", "data": wanted}

    try:
        provider = get_chat_provider()
    except ProviderError as exc:
        yield {"type": "error", "data": {"message": str(exc)}}
        return

    model = settings.sarvam_voice_model if voice else None
    max_tokens = settings.jarvis_voice_max_tokens if voice else None
    stream_typed = not voice and len(user_text) >= settings.jarvis_typed_stream_chars
    if stream_typed:
        logger.info("Large typed prompt (%d chars): using progressive output", len(user_text))

    history = await _load_history()

    # The question goes LAST. This is the fix for the worst bug in the system.
    #
    # `user_text` was appended to the transcript a few lines above, so it comes
    # back as the final entry of `history` -- and the state block was then
    # placed after it, followed by the turn reminder. The user's actual
    # question therefore sat two system messages away from the generation
    # point, behind a block containing the clock, the current timetable entry,
    # the next one, and the whole week's schedule.
    #
    # The model answered the state block instead of the question, and did it
    # consistently. Measured on the device:
    #
    #   "Hello Jarvis."                          -> current block + next block
    #   "what's the weather?"                    -> the time
    #   "Jawaharlal Nehru, who is the Father
    #    of Nation."                             -> Wednesday's skill classes,
    #                                               verbatim from the previous
    #                                               reply, an hour later
    #
    # Every one of those is the tail of the request winning over its middle,
    # which is exactly what should be expected: the last thing before
    # generation is the thing that gets answered.
    #
    # Ordering the state before the question costs nothing in caching. The
    # cacheable prefix is the persona plus the settled history, and both still
    # sit ahead of the volatile blocks; only the last few messages change.
    trailing_user = (
        history
        and history[-1].get("role") == "user"
        and history[-1].get("content") == user_text
    )
    settled = history[:-1] if trailing_user else history

    messages: list[dict[str, Any]] = [
        _build_persona_message(voice, language),
        *settled,
        # Context for the question, positioned before it.
        await _build_state_message(user_text),
    ]

    # Spoken turns always carry the scope/brevity reminder; the language
    # reminder is appended to it only when replying in something other than
    # English. Both ride beside the generation point rather than living in the
    # cached prefix, because that is the only place they reliably hold.
    reminder = None
    if voice:
        parts = [VOICE_TURN_REMINDER]
        language_note = reply_reminder(language)
        if language_note:
            parts.append(language_note)
        # Only present on the turn the script actually changes. See
        # `language_switch_note`: a standing directive loses to forty rows of
        # contrary evidence, so the evidence has to be named and dismissed.
        switch = language_switch_note(language, settled)
        if switch:
            parts.append(switch)
        reminder = {"role": "system", "content": "\n\n".join(parts)}

    # Resolved once per turn, not per iteration: the tool block is part of the
    # cached request prefix, so it must be byte-identical across the iterations
    # of a single turn.
    offered_tools = openai_tools()

    # Same reasoning_effort for every iteration of this turn too -- a
    # multi-step tool cycle is answering the same question throughout.
    reasoning_effort = reasoning_effort_for(user_text)

    # True once the question has been folded into `messages` as a real turn.
    tool_cycle_started = False

    refreshed: set[str] = {"memories"} if inferred_candidate else set()
    assistant_text_parts: list[str] = []
    usage_total: dict[str, int] = {}
    finish_reason: str | None = None

    yield {
        "type": "start",
        "data": {"model": model or provider.model, "provider": provider.name},
    }

    try:
        for _ in range(settings.jarvis_max_tool_iterations):
            # Tool-call ids are assigned by the provider during streaming; the
            # UI keys its execution log on them.
            # The reminder rides along with the request but is never stored, so
            # it stays adjacent to generation on every tool iteration without
            # accumulating in the transcript.
            # Order at the generation point: ... state, reminder, THE QUESTION.
            #
            # The question is last on the first iteration only. Once a tool has
            # run, `messages` has grown an assistant tool_use turn and its
            # result, and those must stay in sequence after the question they
            # belong to — re-appending it would put the question after its own
            # answer.
            request_messages = list(messages)
            if reminder is not None:
                request_messages.append(reminder)
            if not tool_cycle_started:
                request_messages.append(user_payload)

            # Stream only where partial output is actually being consumed.
            #
            # A spoken turn feeds each finished sentence to TTS as it arrives,
            # so the first word reaches the speaker about a second sooner --
            # that is worth paying for. A typed turn is not: measured on an
            # identical prompt, streaming produced its first token at 0.57s but
            # did not finish until 2.47s with 0 of 9,014 tokens cached, while
            # the unstreamed request finished the whole answer at 1.61s with
            # 8,960 cached. The provider does not apply its prefix cache to
            # streaming requests, so streaming a turn nobody watches arrive
            # costs both time and money for nothing.
            async for chunk in provider.stream(
                request_messages,
                offered_tools,
                model=model,
                max_tokens=max_tokens,
                incremental=voice or stream_typed,
                reasoning_effort=reasoning_effort,
            ):
                if chunk.kind == "text":
                    yield {"type": "text", "data": {"text": chunk.text}}
                elif chunk.kind == "reasoning":
                    yield {"type": "thinking", "data": {"text": chunk.text}}
                elif chunk.kind == "tool_call_started" and chunk.tool_call:
                    yield {
                        "type": "tool_use",
                        "data": {"id": chunk.tool_call.id, "name": chunk.tool_call.name},
                    }

            result = provider.last_result()
            finish_reason = result.finish_reason

            for key, value in (result.usage or {}).items():
                usage_total[key] = usage_total.get(key, 0) + value

            if result.content:
                assistant_text_parts.append(result.content)

            # Parse before serializing the assistant turn, so the history only
            # ever contains argument blobs the API will accept on replay.
            parsed_calls = [
                (call, *_parse_arguments(call.arguments, call.name))
                for call in result.tool_calls
            ]

            assistant = _assistant_message(
                result.content, [(call, args) for call, args, _ in parsed_calls]
            )
            await crud.append_chat_message("assistant", result.content, assistant)

            # The question joins the conversation properly the moment a reply
            # is built on it. Until now it was appended per-iteration, purely so
            # it could sit last; from here it has to be a real turn, because the
            # assistant message about to follow is a response to it and the
            # provider requires that sequence.
            if not tool_cycle_started:
                messages.append(user_payload)
                tool_cycle_started = True
            messages.append(assistant)

            if not result.tool_calls:
                if finish_reason == "length" and not result.content:
                    # Reasoning consumed the whole budget before any visible
                    # text — say so rather than showing an empty reply.
                    yield {
                        "type": "error",
                        "data": {
                            "message": (
                                "The model used its entire token budget on reasoning "
                                "before answering. Raise JARVIS_MAX_TOKENS in "
                                "backend/.env (currently "
                                f"{settings.jarvis_max_tokens})."
                            )
                        },
                    }
                break

            for call, arguments, parse_error in parsed_calls:
                logger.info("tool call: %s", call.name)
                if parse_error is not None:
                    outcome_text = f"{call.name} was called with invalid input — {parse_error}."
                    ok = False
                else:
                    outcome = await execute_tool(
                        call.name, arguments, source_turn_ref=call.id
                    )
                    outcome_text = outcome.content
                    ok = not outcome.is_error
                    refreshed |= outcome.refresh
                logger.info("tool result: %s ok=%s", call.name, ok)

                yield {
                    "type": "tool_result",
                    "data": {
                        "id": call.id,
                        "name": call.name,
                        "ok": ok,
                        "summary": outcome_text[:600],
                        "display": None if parse_error else outcome.display,
                    },
                }
                if not parse_error and outcome.refresh:
                    yield {"type": "refresh", "data": {"domains": sorted(outcome.refresh)}}

                tool_message = {
                    "role": "tool",
                    "tool_call_id": call.id,
                    "content": outcome_text,
                }
                await crud.append_chat_message("user", "", tool_message)
                messages.append(tool_message)
        else:
            yield {
                "type": "error",
                "data": {
                    "message": (
                        f"Stopped after {settings.jarvis_max_tool_iterations} tool rounds "
                        "to avoid a runaway loop. Ask me to continue if that was premature."
                    )
                },
            }

    except ProviderError as exc:
        yield {"type": "error", "data": {"message": str(exc)}}
        return
    except Exception as exc:  # noqa: BLE001
        logger.exception("Agent turn failed")
        yield {"type": "error", "data": {"message": f"Agent failure: {exc}"}}
        return

    yield {
        "type": "done",
        "data": {
            "stop_reason": finish_reason,
            "refresh": sorted(refreshed),
            "usage": usage_total,
            "text": "".join(assistant_text_parts),
        },
    }
