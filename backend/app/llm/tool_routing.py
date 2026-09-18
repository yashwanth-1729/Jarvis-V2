"""Picks which tool schemas a turn actually needs, instead of sending every
tool on every request.

Scoped to the "core" tool set only (the 21 tools active whenever
``system_tools_enabled`` is off, which is every Android turn -- see
``config.system_tools_enabled``). The 35 desktop-only "system" tools
(computer control, browser, filesystem) are a separate, unmeasured problem on
a much lower-volume surface; this pass is about the path every real voice
turn actually takes. Not routing "system" tools is a scoping choice, not an
oversight -- see the 2026-09-16 README entry for the numbers this was
measured against.

Deterministic keyword matching only, per the explicit preference for the
cheapest routing that has high confidence: no second LLM call, no
classifier model, nothing that would eat into the latency this exists to
save. The safety property that makes a keyword router acceptable here is the
fallback -- ``route()`` never returns an empty/narrow set on low confidence,
it returns ``None``, which callers treat as "send the whole core set" (today's
behaviour, unchanged). A false negative costs tokens; a false positive that
falls back to "everything" costs tokens too, but never silently breaks a
feature the way a false negative into "nothing" would.
"""

from __future__ import annotations

import re

from app.core.config import settings

#: Every core tool must appear in at least one group -- this is asserted at
#: import time below, so a new core tool silently missing a group fails fast
#: at startup rather than being unreachable through routing forever.
TOOL_GROUPS: dict[str, tuple[str, ...]] = {
    "tasks": ("add_task", "update_task_status", "update_task", "bulk_delete_tasks"),
    "schedule": (
        "add_schedule_event", "update_schedule_event", "bulk_delete_schedule",
        "get_dashboard_summary",
    ),
    "notes": ("save_idea_or_note", "update_idea", "bulk_delete_notes"),
    "memory": ("search_memory", "generate_proactive_brief"),
    "web": ("web_search", "fetch_url", "get_weather"),
    "settings": ("set_voice", "set_language", "configure_notifications"),
    "reminder": ("set_reminder",),
    # `delete_record` is the single-record deleter used across every domain
    # ("delete that task", "remove this note"), so it rides with any
    # deletion-shaped phrase rather than living in one domain's group.
    "record": ("delete_record",),
}

_KEYWORDS: dict[str, re.Pattern[str]] = {
    "tasks": re.compile(
        r"\b(task|todo|to-do|to do|tasks|pending|mark.*(done|complete)|finish(ed)?)\b", re.I
    ),
    "schedule": re.compile(
        r"\b(schedule|timetable|class(es)?|lecture|lab|session|calendar|event|agenda|"
        r"college|routine|reschedule|tomorrow|today|this week|weekly|what.?s on|"
        r"monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b", re.I
    ),
    "notes": re.compile(r"\b(note|idea|jot down|write down|save this|remember this)\b", re.I),
    "memory": re.compile(
        r"\b(remember|recall|earlier|previously|what did i (say|tell)|"
        r"my (preference|profile)|brief|daily summary)\b", re.I
    ),
    "web": re.compile(
        r"\b(weather|search|look up|google|news|latest|current price|price of|"
        r"who is|what is|how (many|much)|fetch|open (this|the) (url|link|page))\b", re.I
    ),
    "settings": re.compile(
        r"\b(voice|language|telugu|hindi|english|notification|mute|silent|speaker|"
        r"switch to)\b", re.I
    ),
    "reminder": re.compile(
        r"\b(remind|reminder|alert me|ping me|wake me|notify me|don'?t let me forget|"
        # `remember(\s+\w+){0,2}\s+to` catches "remember to", "remember me
        # to", "remember you to" -- a live "remember me to sleep at 11pm"
        # missed the plain "remember to" bigram entirely (STT's "me" sits
        # between the two words), the router offered no reminder tool, and
        # Qwen still verbally claimed the reminder was set. Widened rather
        # than dropping the adjacency requirement outright, so "remember my
        # address" or "remember that I like tea" -- real memory saves with
        # no task shape -- still route to `memory` only.
        r"nudge me|remember(?:\s+\w+){0,2}\s+to)\b", re.I
    ),
    "record": re.compile(r"\b(delete|remove|get rid of|clear)\b", re.I),
}

def _assert_full_coverage() -> None:
    """Fail fast at import time if a core tool has no route to it.

    A tool with no group is not disabled -- it silently becomes unreachable
    for any turn where the router narrows the set, since it would never
    appear in the routed union and callers only see the full set on a
    fallback. Cheaper to catch here than to discover it from a user
    reporting a tool that "stopped working".
    """
    from app.llm.tools import TOOL_REGISTRY

    core_names = {spec.name for spec in TOOL_REGISTRY if spec.capability == "core"}
    grouped = {name for names in TOOL_GROUPS.values() for name in names}
    missing = core_names - grouped
    if missing:
        raise RuntimeError(
            f"tool_routing.TOOL_GROUPS is missing core tool(s): {sorted(missing)}. "
            "Add each to a group or it becomes unreachable whenever routing narrows."
        )


_assert_full_coverage()


def route(user_text: str, recent_text: str = "") -> frozenset[str] | None:
    """Which core tool names this turn plausibly needs.

    Returns a possibly-multi-group union of names when one or more keyword
    sets fired, since a request routinely spans domains ("remind me to
    submit the note tomorrow" is both `reminder` and `notes`).

    ``recent_text`` is the prior user turn, when there is one -- a
    confirm-then-act reply ("yes, delete them all") routinely carries none of
    the original request's domain keywords, only "delete", so scoring it
    alone matched `delete_record`'s group but never `bulk_delete_tasks`'s: the
    model could not call the very tool it had just proposed, because that
    tool's schema was never in the request. Reproduced live (2026-09-18):
    ``route("Delete all my tasks.")`` correctly includes `bulk_delete_tasks`;
    ``route("Yes, delete them all. Don't ask me one by one.")`` alone did not,
    even though it is plainly a reply to the first. Folding the previous
    turn's keywords in fixes exactly this without losing the "current turn
    only" behavior for a request that truly stands alone.

    On no match (across both texts), the behavior is a config choice
    (``jarvis_tool_routing_fallback_all``): the empty frozenset (send zero
    core tools) or ``None`` (send every core tool -- the default, and the
    safer of the two). Both are legitimate; there is no way to distinguish
    "genuinely no tool needed" from "the keyword net missed it" from text
    alone, so this is a deliberate, documented tradeoff, not an oversight.
    """
    matched: set[str] = set()
    for text in (user_text or "", recent_text or ""):
        for group, pattern in _KEYWORDS.items():
            if pattern.search(text):
                matched.update(TOOL_GROUPS[group])
    if matched:
        return frozenset(matched)
    return None if settings.jarvis_tool_routing_fallback_all else frozenset()
